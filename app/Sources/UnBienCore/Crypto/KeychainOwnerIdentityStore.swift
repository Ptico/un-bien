import Foundation
import Security
import os

/// Keychain-backed Owner-key custody (DESIGN §5).
///
/// Stored in the **data-protection keychain** (`kSecUseDataProtectionKeychain`)
/// so access is gated by the app's entitlement (like iOS) rather than the
/// legacy macOS per-binary ACL — the latter re-prompts on every launch whenever
/// the app's code signature changes (ad-hoc / dev rebuilds). Falls back to the
/// legacy keychain when the process has no keychain entitlement (the unsigned
/// `swift run un-bien-mac` dev tool), and `load()` migrates a legacy item into
/// the data-protection keychain when the entitlement is present so existing
/// installs stop prompting.
///
/// PER-DEVICE ACCOUNT (design 01M1VS0X): the `account` is scoped per device
/// (`"owner." + <device id>`) so a re-key on one device can't overwrite another
/// device's identity through the shared, iCloud-synced slot. `legacyAccount`
/// (the old shared `"owner"`) is migrated INTO the per-device slot on first
/// load — the shared item is left in place so other devices migrate from it
/// independently. With per-device accounts iCloud sync can stay on (slots don't
/// collide). Value is the 64-byte `pubkey || seed` blob (``OwnerIdentityBlob``).
public final class KeychainOwnerIdentityStore: OwnerIdentityStore, @unchecked Sendable {
    public enum KeychainError: Error, Equatable {
        case unexpectedStatus(OSStatus)
        /// The process holds no keychain entitlement (unsigned dev build): the
        /// data-protection keychain is unavailable, use the legacy one.
        case missingEntitlement
    }

    /// DIAGNOSTICS (issue #2): one line per keychain operation with the exact
    /// OSStatus, so a failed toggle/save dance can be replayed in Console.
    /// NEVER logs blob/key material — statuses and slot names only.
    private let log = Logger(subsystem: "un-bien", category: "keychain")

    private let service: String
    private let account: String
    private let legacyAccount: String?
    private let syncsToICloud: Bool

    public init(service: String = "com.georgeharker.un-bien.owner-key",
                account: String = "owner",
                legacyAccount: String? = nil,
                syncsToICloud: Bool) {
        self.service = service
        self.account = account
        self.legacyAccount = legacyAccount
        self.syncsToICloud = syncsToICloud
    }

    private func query(account: String, dataProtection: Bool) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            // Match both synced and non-synced items so a sync-toggle change
            // still finds an existing key rather than silently minting a new one.
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
        ]
        if dataProtection {
            query[kSecUseDataProtectionKeychain as String] = true
        }
        return query
    }

    public func load() throws -> Ed25519Identity? {
        #if targetEnvironment(simulator)
        // SIMULATOR-ONLY file-backed seed. The original rationale was "the sim
        // keychain does not persist across relaunch (confirmed empirically)"
        // — but that observation predates issue #2 and is almost certainly a
        // MISDIAGNOSIS of save()'s self-wiping delete-then-add (see the save()
        // comment: write succeeds, then the "legacy cleanup" remove deletes it,
        // next launch's read is errSecItemNotFound). With the upsert fix the
        // sim keychain should persist; this file is now redundant belt-and-
        // braces for the dev loop. Kept sim-only; never compiled for device.
        if let blob = simFileBlob(), let id = try? OwnerIdentityBlob.decode(blob) {
            log.info("load: SIMULATOR file fallback hit — returning identity (keychain was not consulted)")
            return id
        }
        #endif
        // 1) Per-device account in the data-protection keychain (steady state).
        if let identity = try read(account: account, dataProtection: true) {
            log.info("load: per-device DP hit — returning existing identity")
            return identity
        }
        #if os(macOS)
        // 2) Per-device account in the LEGACY macOS per-binary keychain —
        //    migrate it UP into the data-protection keychain, drop the old copy.
        //    macOS ONLY (issue #2): on iOS `dataProtection: false` hits the
        //    same single keychain, so this path is meaningless there — and
        //    touching the "legacy" store from iOS is what destroyed keys.
        if let legacy = try read(account: account, dataProtection: false) {
            log.info("load: LEGACY per-device hit — migrating up into DP keychain")
            try? upsert(blob: OwnerIdentityBlob.encode(legacy), account: account,
                        synchronizable: syncsToICloud, dataProtection: true)
            try? remove(account: account, dataProtection: false, synchronizable: nil)
            return legacy
        }
        // 3) MIGRATION from the SHARED legacy account (the pre-per-device
        //    `"owner"` slot): COPY it into this device's slot so future launches
        //    find it and future writes stay isolated. Do NOT remove the shared
        //    item — other devices migrate from it independently (removing it
        //    would unpair them). Preserves the current pairing (same key).
        if let legacyAccount {
            for dataProtection in [true, false] {
                if let shared = try read(account: legacyAccount, dataProtection: dataProtection) {
                    let slot = dataProtection ? "dp" : "legacy"
                    log.info("load: shared legacy hit (\(slot, privacy: .public)) — copying into per-device slot")
                    try? upsert(blob: OwnerIdentityBlob.encode(shared), account: account,
                                synchronizable: syncsToICloud, dataProtection: true)
                    return shared
                }
            }
        }
        #endif
        log.info("load: MISS — caller will onboard/re-key (unexpected if paired; issue #2)")
        return nil
    }

    public func save(_ identity: Ed25519Identity) throws {
        let msg = "save: begin acct=\(account) syncsToICloud=\(syncsToICloud ? 1 : 0)"
        log.info("\(msg, privacy: .public)")
        let blob = OwnerIdentityBlob.encode(identity)
        #if targetEnvironment(simulator)
        try? writeSimFile(blob) // sim-only durable fallback (see load())
        log.info("save: SIMULATOR file fallback written (device builds rely on the keychain alone)")
        #endif
        // UPSERT, never delete-then-add (fix for issue #2): the old save()
        // removed items around the inserts — and on iOS `dataProtection: false`
        // is the SAME (only) keychain, so the trailing "legacy cleanup" deleted
        // the items just written on EVERY save (macOS too: a delete query
        // without the DP flag matched the fresh DP items). Update-in-place
        // keeps the keychain populated at every instant, so a crash or
        // foreground-kill mid-save can no longer lose the identity. The legacy
        // keychain is NEVER touched here; migration is load()'s macOS-only job.
        do {
            try upsert(blob: blob, account: account, synchronizable: false, dataProtection: true)
            if syncsToICloud {
                try upsert(blob: blob, account: account, synchronizable: true, dataProtection: true)
            } else {
                // Toggle OFF: remove ONLY the iCloud-synced copy (precise
                // match). The device-local copy stays as the durable anchor —
                // iCloud sign-out deletes synced items out from under us.
                try? remove(account: account, dataProtection: true, synchronizable: true)
            }
        } catch KeychainError.missingEntitlement {
            // Unsigned dev build: the DP keychain is unavailable; upsert into
            // the legacy keychain instead (macOS dev tool only, in practice).
            log.warning("save: DP keychain unavailable (missing entitlement) — upserting into LEGACY keychain")
            try upsert(blob: blob, account: account, synchronizable: false, dataProtection: false)
            if syncsToICloud {
                try upsert(blob: blob, account: account, synchronizable: true, dataProtection: false)
            } else {
                try? remove(account: account, dataProtection: false, synchronizable: true)
            }
        }
    }

    public func delete() throws {
        log.info("delete: wiping owner key (both copies, precise match)")
        try remove(account: account, dataProtection: true, synchronizable: false)
        try remove(account: account, dataProtection: true, synchronizable: true)
        #if os(macOS)
        try remove(account: account, dataProtection: false, synchronizable: nil)
        #endif
        #if targetEnvironment(simulator)
        if let url = simFileURL { try? FileManager.default.removeItem(at: url) }
        #endif
    }

    #if targetEnvironment(simulator)
    // Simulator-only file fallback for the owner seed (the sim keychain does not
    // persist across relaunch). Plain 0600 file, NO file-protection class (that
    // would reintroduce the same lock-gating). Never compiled for device.
    private var simFileURL: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("un-bien", isDirectory: true)
            .appendingPathComponent("owner-\(account).seed")
    }
    private func simFileBlob() -> Data? {
        guard let url = simFileURL else { return nil }
        return try? Data(contentsOf: url)
    }
    private func writeSimFile(_ blob: Data) throws {
        guard let url = simFileURL else { return }
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try blob.write(to: url, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
    #endif

    // MARK: - SecItem primitives

    /// Human-readable OSStatus for logs (statuses only; never item data).
    private func statusName(_ status: OSStatus) -> String {
        switch status {
        case errSecSuccess: return "errSecSuccess"
        case errSecItemNotFound: return "errSecItemNotFound"
        case errSecDuplicateItem: return "errSecDuplicateItem"
        case errSecMissingEntitlement: return "errSecMissingEntitlement"
        case errSecInteractionNotAllowed: return "errSecInteractionNotAllowed"
        case -25293: return "errSecAuthNeeded" // macOS-only symbol; raw value for iOS builds
        case errSecUserCanceled: return "errSecUserCanceled"
        default: return "OSStatus(\(status))"
        }
    }

    private func read(account: String, dataProtection: Bool) throws -> Ed25519Identity? {
        var query = query(account: account, dataProtection: dataProtection)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        let msg = "read \(account)/\(dataProtection ? "dp" : "legacy") → \(statusName(status))"
        log.info("\(msg, privacy: .public)")
        switch status {
        case errSecSuccess:
            guard let blob = item as? Data else { return nil }
            return try OwnerIdentityBlob.decode(blob)
        case errSecItemNotFound, errSecMissingEntitlement:
            return nil
        default:
            throw KeychainError.unexpectedStatus(status)
        }
    }

    /// UPSERT (issue #2): SecItemUpdate in place, SecItemAdd when missing.
    /// save() must never delete-then-add: the delete-then-add window erased
    /// the just-written identity, and a crash mid-save could lose the key.
    private func upsert(blob: Data, account: String, synchronizable: Bool, dataProtection: Bool) throws {
        var matchQuery = query(account: account, dataProtection: dataProtection)
        matchQuery[kSecAttrSynchronizable as String] = synchronizable
        let update: [String: Any] = [
            kSecValueData as String: blob,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        let syncLabel = synchronizable ? "sync" : "nosync"
        let storeLabel = dataProtection ? "dp" : "legacy"
        let updateStatus = SecItemUpdate(matchQuery as CFDictionary, update as CFDictionary)
        switch updateStatus {
        case errSecSuccess:
            let msg = "upsert \(account)/\(storeLabel)/\(syncLabel) → updated in place"
            log.info("\(msg, privacy: .public)")
        case errSecItemNotFound:
            var addQuery = matchQuery
            addQuery[kSecValueData as String] = blob
            addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            let status = SecItemAdd(addQuery as CFDictionary, nil)
            let msg = "upsert \(account)/\(storeLabel)/\(syncLabel) → added (\(statusName(status)))"
            log.info("\(msg, privacy: .public)")
            switch status {
            case errSecSuccess, errSecDuplicateItem:
                return
            case errSecMissingEntitlement:
                throw KeychainError.missingEntitlement
            default:
                throw KeychainError.unexpectedStatus(status)
            }
        case errSecMissingEntitlement:
            throw KeychainError.missingEntitlement
        default:
            throw KeychainError.unexpectedStatus(updateStatus)
        }
    }

    /// Precise remove: pass `synchronizable` to target exactly one item
    /// variant, or nil for SynchronizableAny (full wipe of the slot).
    private func remove(account: String, dataProtection: Bool, synchronizable: Bool?) throws {
        var delQuery = query(account: account, dataProtection: dataProtection)
        if let synchronizable {
            delQuery[kSecAttrSynchronizable as String] = synchronizable
        }
        let status = SecItemDelete(delQuery as CFDictionary)
        // NOTE (issue #2): on iOS `dataProtection: false` is NOT a separate
        // legacy store — it hits the same (only) keychain. Logs make any
        // steady-state remove visible in Console.
        let syncLabel = synchronizable == nil ? "syncAny" : synchronizable! ? "sync" : "nosync"
        let msg = "remove \(account)/\(dataProtection ? "dp" : "legacy") \(syncLabel) → \(statusName(status))"
        log.info("\(msg, privacy: .public)")
        switch status {
        case errSecSuccess, errSecItemNotFound, errSecMissingEntitlement:
            return
        default:
            throw KeychainError.unexpectedStatus(status)
        }
    }
}
