import Security
import XCTest
@testable import UnBienCore

/// Regression suite for issue #2 (owner key wiped on every app restart).
///
/// The old `save()` was delete-then-add: remove → insert → insert →
/// "legacy cleanup" remove. On iOS there is only ONE keychain, so the
/// trailing remove — aimed at a legacy store that does not exist there —
/// deleted the items it had just written, on EVERY save. Any fresh
/// install re-keyed and unpaired on every restart.
///
/// These tests drive the REAL keychain (`simFallback: false` — the
/// simulator-only seed file would mask exactly this class of bug) in a
/// unique per-run slot, and simulate an app restart by constructing a
/// FRESH store instance before each load — exactly what `AppModel` does
/// on every launch. If `save()` leaves the keychain empty, these fail.
final class KeychainOwnerIdentityStoreTests: XCTestCase {
    private var service: String!

    override func setUpWithError() throws {
        try super.setUpWithError()
        // Unique slot per test RUN: no ACL collisions with the real app's
        // items (so no keychain prompts), no cross-run pollution.
        service = "com.georgeharker.un-bien.tests.\(UUID().uuidString)"
    }

    override func tearDown() {
        if service != nil {
            try? makeStore(syncsToICloud: true).delete()
        }
        super.tearDown()
    }

    /// True when this process can use the data-protection keychain (an
    /// entitled host: the iOS-simulator test runner). The unsigned
    /// `swift test` CLI process cannot — persistence is untestable there,
    /// so skip rather than fail; run the suite via `xcodebuild test` on a
    /// simulator destination for the real proof.
    private func tryRequireDPKeychain() throws {
        let probe: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service!,
            kSecAttrAccount as String: "dp-entitlement-probe",
            kSecValueData as String: Data([0x2A]),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
            kSecUseDataProtectionKeychain as String: true,
        ]
        // SecItemAdd (not CopyMatching): unsigned CLI hosts report the
        // missing entitlement on WRITES — the probe must write to see it.
        let status = SecItemAdd(probe as CFDictionary, nil)
        SecItemDelete(probe as CFDictionary)
        if status == errSecMissingEntitlement {
            throw XCTSkip("no keychain entitlement in this test host — "
                + "run: xcodebuild test -scheme UnBienCore -destination 'platform=iOS Simulator,...'")
        }
    }

    private func makeStore(syncsToICloud: Bool, legacyAccount: String? = nil) -> KeychainOwnerIdentityStore {
        KeychainOwnerIdentityStore(
            service: service,
            account: "owner.test",
            legacyAccount: legacyAccount,
            simFallback: false, // real keychain only — see class doc
            syncsToICloud: syncsToICloud)
    }

    // MARK: - Fresh install → restart (the issue #2 repro)

    func testFreshInstallPairSurvivesRestart() throws {
        try tryRequireDPKeychain()
        // Fresh install: nothing stored yet.
        let firstLaunch = makeStore(syncsToICloud: true)
        XCTAssertNil(try firstLaunch.load())

        // Pairing / onboarding: mint + save.
        let identity = Ed25519Identity()
        try firstLaunch.save(identity)

        // RESTART: a brand-new store instance, the way AppModel builds one.
        let nextLaunch = makeStore(syncsToICloud: true)
        let loaded = try XCTUnwrap(try nextLaunch.load(),
                                   "owner key lost across store instances — issue #2 regression")
        XCTAssertEqual(loaded.publicKeyRaw, identity.publicKeyRaw)
        XCTAssertEqual(loaded.rawSeed, identity.rawSeed)
    }

    /// Under the old code EVERY save wiped the slot — this is the one test
    /// that would have caught it on day one.
    func testSaveTwiceKeepsIdentity() throws {
        try tryRequireDPKeychain()
        let identity = Ed25519Identity()
        let store = makeStore(syncsToICloud: true)
        try store.save(identity)
        try store.save(identity) // second save must not erase the first
        let fresh = makeStore(syncsToICloud: true)
        let loaded = try XCTUnwrap(try fresh.load())
        XCTAssertEqual(loaded.publicKeyRaw, identity.publicKeyRaw)
    }

    /// The iCloud-sync toggle path (Settings → "Sync Owner key via iCloud")
    /// used to drop the pairing in BOTH directions. Sync OFF must keep the
    /// device-local copy as the durable anchor; sync ON must restore the
    /// synced copy. Both directions must survive a restart.
    func testICloudToggleBothDirectionsSurvivesRestart() throws {
        try tryRequireDPKeychain()
        let identity = Ed25519Identity()
        // Paired with sync ON...
        try makeStore(syncsToICloud: true).save(identity)
        // ...toggle OFF, restart...
        try makeStore(syncsToICloud: false).save(identity)
        var loaded = try XCTUnwrap(try makeStore(syncsToICloud: false).load(),
                                   "key lost after toggling iCloud sync OFF")
        XCTAssertEqual(loaded.publicKeyRaw, identity.publicKeyRaw)
        // ...toggle back ON, restart.
        try makeStore(syncsToICloud: true).save(identity)
        loaded = try XCTUnwrap(try makeStore(syncsToICloud: true).load(),
                               "key lost after toggling iCloud sync back ON")
        XCTAssertEqual(loaded.publicKeyRaw, identity.publicKeyRaw)
    }

    /// The key must be readable at every instant — no delete-then-add window.
    /// (A crash mid-save must never lose the identity.)
    func testConcurrentSavesKeepSlotPopulated() throws {
        try tryRequireDPKeychain()
        let identity = Ed25519Identity()
        let store = makeStore(syncsToICloud: true)
        // Interleave saves and loads concurrently: with delete-then-add there
        // is a window where load() returns nil; upsert guarantees it never
        // sees an empty (or half-written) slot.
        let group = DispatchGroup()
        let queue = DispatchQueue(label: "keychain-test", attributes: .concurrent)
        let misses = AtomicCounter()
        for attempt in 0..<20 {
            group.enter()
            queue.async {
                defer { group.leave() }
                do {
                    try store.save(identity)
                    if try store.load() == nil { misses.increment() }
                } catch {
                    XCTFail("unexpected error: \(error)")
                }
                _ = attempt
            }
        }
        group.wait()
        XCTAssertEqual(misses.value, 0,
                       "load() saw an empty slot during saves — delete-then-add regression")
        let fresh = makeStore(syncsToICloud: true)
        XCTAssertEqual(try fresh.load()?.publicKeyRaw, identity.publicKeyRaw)
    }

    func testDeleteWipesSlot() throws {
        try tryRequireDPKeychain()
        let identity = Ed25519Identity()
        try makeStore(syncsToICloud: true).save(identity)
        try makeStore(syncsToICloud: true).delete()
        XCTAssertNil(try makeStore(syncsToICloud: true).load())
    }

    /// Explicit wipe of a slot with BOTH copies present, then re-pair with a
    /// NEW key — proves delete() is complete and re-pair starts clean.
    func testDeleteThenRekeyStartsClean() throws {
        try tryRequireDPKeychain()
        let first = Ed25519Identity()
        try makeStore(syncsToICloud: true).save(first)
        try makeStore(syncsToICloud: true).delete()
        let second = Ed25519Identity()
        try makeStore(syncsToICloud: true).save(second)
        let loaded = try XCTUnwrap(try makeStore(syncsToICloud: true).load())
        XCTAssertEqual(loaded.publicKeyRaw, second.publicKeyRaw)
        XCTAssertNotEqual(loaded.publicKeyRaw, first.publicKeyRaw)
    }

    #if os(macOS)
    /// Fresh install upgraded from a pre-per-device build: the key lives in
    /// the shared legacy slot only; `load()` must adopt it into this
    /// device's slot (same key preserved), and a restart must find it there.
    func testLegacySharedSlotMigratesOnFreshInstall() throws {
        try tryRequireDPKeychain()
        let sharedAccount = "owner.shared.\(UUID().uuidString)"
        let identity = Ed25519Identity()
        var addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service!,
            kSecAttrAccount as String: sharedAccount,
            kSecValueData as String: OwnerIdentityBlob.encode(identity),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        XCTAssertEqual(SecItemAdd(addQuery as CFDictionary, nil), errSecSuccess)

        // First launch on the new build: migrates, same key.
        let store = makeStore(syncsToICloud: true, legacyAccount: sharedAccount)
        let loaded = try XCTUnwrap(try store.load())
        XCTAssertEqual(loaded.publicKeyRaw, identity.publicKeyRaw)

        // Restart: finds it in the per-device slot (migrated up).
        let nextLaunch = makeStore(syncsToICloud: true, legacyAccount: sharedAccount)
        let again = try XCTUnwrap(try nextLaunch.load())
        XCTAssertEqual(again.publicKeyRaw, identity.publicKeyRaw)
    }
    #endif
}

/// Tiny atomic counter (no atomics dependency needed here).
final class AtomicCounter {
    private var count = 0
    private let lock = NSLock()
    var value: Int { lock.lock(); defer { lock.unlock() }; return count }
    func increment() { lock.lock(); defer { lock.unlock() }; count += 1 }
}