import Foundation
import os
@testable import UnBienCore

/// Scripted relay-server test double (Layer 1 of the protocol-test ladder).
///
/// Implements ``WebSocketChannel`` so ``RelayConnection`` can be driven
/// through its REAL state machines (handshake, pairing, rooms) without a
/// server process. Tests `push` inbound frames on cue — the channel queues
/// them, so push-before-send is safe and every flow is deterministic — and
/// inspect everything the connection sent via `sentLines`/`sentControls`/
/// `sentEnvelopes`.
///
/// This is the app-side half of integration testing: it proves the app
/// behaves correctly GIVEN correct relay frames. It does NOT prove the relay
/// itself agrees — that's relay-ci's job (Layer 2).
final class ScriptedRelayChannel: WebSocketChannel, @unchecked Sendable {
    struct ChannelClosedError: Error {}

    private final class State: @unchecked Sendable {
        var sent: [String] = []
        var inbox: [String] = []
        var waiters: [CheckedContinuation<String, Error>] = []
        var closed = false
    }

    /// Scoped unfair lock — `OSAllocatedUnfairLock.withLock` is async-safe
    /// (NSLock.lock()/unlock() are unavailable from async contexts).
    private let state = OSAllocatedUnfairLock(initialState: State())

    // MARK: - Test-side scripting + inspection

    /// Queue an inbound frame. Delivered to a parked `receive()` if one is
    /// waiting, else buffered for the next one. Safe to call before the
    /// connection has sent anything (frames queue in order).
    func push(_ line: String) {
        let waiter: CheckedContinuation<String, Error>? = state.withLock { st in
            guard !st.closed else { return nil }
            if !st.waiters.isEmpty {
                return st.waiters.removeFirst()
            }
            st.inbox.append(line)
            return nil
        }
        waiter?.resume(returning: line)
    }

    /// Deliver a routed ``ServerMessage`` the way the relay does:
    /// `{peer, room, ct}` with `ct = base64(JSON(message))`.
    func pushServer(_ message: ServerMessage, peer: String, room: String) throws {
        let bodyData = try JSONEncoder().encode(message)
        guard let body = String(bytes: bodyData, encoding: .utf8) else { return }
        let envelope = RoutedEnvelope(peer: peer, room: room,
                                      ct: Data(body.utf8).base64EncodedString())
        let lineData = try JSONEncoder().encode(envelope)
        guard let line = String(bytes: lineData, encoding: .utf8) else { return }
        push(line)
    }

    /// Everything the connection sent, in order.
    func sentLines() -> [String] {
        state.withLock { $0.sent }
    }

    /// Sent lines decoded as relay-control frames (hello/auth/subscribe/...).
    func sentControls() throws -> [RelayControlOut] {
        let lines = sentLines()
        return try lines.map { try JSONDecoder().decode(RelayControlOut.self, from: Data($0.utf8)) }
    }

    /// Sent lines that are routed application envelopes.
    func sentEnvelopes() throws -> [RoutedEnvelope] {
        let lines = sentLines()
        return try lines.compactMap { line in
            guard let object = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
                  object["ct"] != nil, object["peer"] != nil else { return nil }
            return try JSONDecoder().decode(RoutedEnvelope.self, from: Data(line.utf8))
        }
    }

    /// The decoded JSON body (`ct`) of every routed envelope, in send order.
    func sentEnvelopeBodies() throws -> [[String: Any]] {
        try sentEnvelopes().map { envelope in
            let data = try unwrap(Data(base64Encoded: envelope.ct), "ct not base64")
            return try unwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        }
    }

    private func unwrap<T>(_ value: T?, _ message: String = "") throws -> T {
        guard let value else { throw ChannelClosedError() }
        return value
    }

    // MARK: - WebSocketChannel

    func send(_ text: String) async throws {
        try state.withLock { state in
            guard !state.closed else { throw ChannelClosedError() }
            state.sent.append(text)
        }
    }

    func receive() async throws -> String {
        // Fast path: a queued frame.
        let queued: String? = state.withLock { queue in
            queue.inbox.isEmpty ? nil : queue.inbox.removeFirst()
        }
        if let queued { return queued }
        return try await withCheckedThrowingContinuation { continuation in
            state.withLock { state in
                if !state.inbox.isEmpty {
                    continuation.resume(returning: state.inbox.removeFirst())
                } else if state.closed {
                    continuation.resume(throwing: ChannelClosedError())
                } else {
                    state.waiters.append(continuation)
                }
            }
        }
    }

    func close() {
        let parked: [CheckedContinuation<String, Error>] = state.withLock { state in
            state.closed = true
            let waiters = state.waiters
            state.waiters = []
            return waiters
        }
        for waiter in parked { waiter.resume(throwing: ChannelClosedError()) }
    }

    func ping(timeout: TimeInterval) async throws {}
}