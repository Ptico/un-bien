import Foundation
import XCTest
@testable import UnBienCore

/// Layer-1 protocol flow tests: RelayConnection's REAL state machines
/// (handshake, pairing, room subscribe/reconcile) driven through a
/// ``ScriptedRelayChannel`` — no server, no sockets, fully hermetic.
///
/// What these prove: the app's behavior GIVEN correct/incorrect relay
/// frames. What they do NOT prove: that the Rust relay emits those frames —
/// that's relay-ci's job (Layer 2).
final class RelayProtocolFlowTests: XCTestCase {
    private let epk = "test-peer-epk"
    private let room = "test-room"

    private func makeConnection(
        on channel: ScriptedRelayChannel,
        identity: Ed25519Identity = Ed25519Identity()
    ) -> RelayConnection {
        RelayConnection(channel: channel, identity: identity)
    }

    private func pushChallenge(_ channel: ScriptedRelayChannel, nonce: Data) {
        let line = #"{"type":"challenge","nonce":"\#(Base64.standard(nonce))"}"#
        channel.push(line)
    }

    /// Await a task group race so a stuck flow fails the test instead of
    /// hanging it.
    private func awaitTask<T>(_ task: Task<T, Error>, timeout: TimeInterval = 5) async throws -> T {
        try await withThrowingTaskGroup(of: T?.self) { group in
            group.addTask { try await task.value }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                throw CancellationError()
            }
            let result = try await group.next()!
            group.cancelAll()
            return try XCTUnwrap(result, "timed out awaiting task")
        }
    }

    private func collect(_ stream: AsyncStream<InboundFrame>, upTo count: Int,
                         timeout: TimeInterval = 3) async -> [InboundFrame] {
        await withTaskGroup(of: [InboundFrame].self) { group in
            group.addTask {
                var frames: [InboundFrame] = []
                for await frame in stream {
                    frames.append(frame)
                    if frames.count >= count { break }
                }
                return frames
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                return []
            }
            let first = await group.next()!
            group.cancelAll()
            return first
        }
    }

    // MARK: - Handshake (hello → challenge → signed auth)

    func testHandshakeSendsHelloThenAuthSignedOverRawNonce() async throws {
        let channel = ScriptedRelayChannel()
        let identity = Ed25519Identity()
        var nonce = Data(count: 32)
        _ = nonce.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        pushChallenge(channel, nonce: nonce)

        let connection = makeConnection(on: channel, identity: identity)
        try await connection.authenticate()
        await connection.close()

        let lines = channel.sentLines()
        XCTAssertEqual(lines.count, 2, "expected hello then auth")
        let hello = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: Data(lines[0].utf8)) as? [String: Any])
        XCTAssertEqual(hello["type"] as? String, "hello")
        XCTAssertEqual(hello["pubkey"] as? String, identity.publicKeyBase64)
        XCTAssertEqual(hello["room_id"] as? String, "main")

        let auth = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: Data(lines[1].utf8)) as? [String: Any])
        XCTAssertEqual(auth["type"] as? String, "auth")
        let sigB64 = try XCTUnwrap(auth["sig"] as? String)
        let sig: Data = try XCTUnwrap(Base64.decodeTolerant(sigB64))
        XCTAssertTrue(Ed25519.verify(signature: sig, message: nonce,
                                     publicKeyRaw: identity.publicKeyRaw),
                      "auth must sign the DECODED challenge nonce (§10.2)")
    }

    func testHandshakeRelayRejectionSurfacesAsRejected() async throws {
        let channel = ScriptedRelayChannel()
        channel.push(#"{"type":"error","code":"unauthorized","message":"bad hello"}"#)
        let connection = makeConnection(on: channel)
        do {
            try await connection.authenticate()
            XCTFail("authenticate() must throw on relay error frame")
        } catch let RelayConnection.ConnectionError.rejected(code, message) {
            XCTAssertEqual(code, "unauthorized")
            XCTAssertEqual(message, "bad hello")
        }
        await connection.close()
    }

    // MARK: - Pairing (pair_request → pair_ok/pair_error)

    func testPairingRoundTripReturnsCorrelatedPairOk() async throws {
        let channel = ScriptedRelayChannel()
        pushChallenge(channel, nonce: Data(repeating: 7, count: 32))
        let connection = makeConnection(on: channel)
        try await connection.authenticate()

        let invite = PairingInvite(token: "tok-123", epk: epk, sessionName: "preview",
                                   roomID: room, relayURL: nil)
        let task = Task { try await connection.pair(invite: invite, deviceName: "test-phone",
                                                    requestID: "req-1") }
        // Noise the fake relay sends before the answer — must be skipped —
        // then a WRONG-correlation pair_ok (also skipped), then the real one.
        channel.push(#"{"type":"peer_online","peer":"someone-else"}"#)
        try channel.pushServer(
            .pairOk(inReplyTo: "wrong-id", sessionName: "wrong", sessionStartedAt: 0,
                    roomID: "wrong-room", harness: nil, hostname: nil),
            peer: epk, room: room)
        try channel.pushServer(
            .pairOk(inReplyTo: "req-1", sessionName: "un-bien", sessionStartedAt: 1_700_000_000,
                    roomID: room,
                    harness: Harness(name: "pi", version: "1"),
                    hostname: "devbox"),
            peer: epk, room: room)
        let result = try await awaitTask(task)
        await connection.close()

        XCTAssertEqual(result.sessionName, "un-bien")
        XCTAssertEqual(result.sessionStartedAt, 1_700_000_000)
        XCTAssertEqual(result.roomID, room)
        XCTAssertEqual(result.harness, Harness(name: "pi", version: "1"))
        XCTAssertEqual(result.hostname, "devbox")

        // The request went out as ONE routed pair_request to the invite's
        // epk/room, carrying the token, device name, and correlation id.
        let bodies = try channel.sentEnvelopeBodies()
        XCTAssertEqual(bodies.count, 1)
        XCTAssertEqual(bodies[0]["type"] as? String, "pair_request")
        XCTAssertEqual(bodies[0]["token"] as? String, "tok-123")
        XCTAssertEqual(bodies[0]["device_name"] as? String, "test-phone")
        XCTAssertEqual(bodies[0]["id"] as? String, "req-1")
        let envelope = try XCTUnwrap(try channel.sentEnvelopes().first)
        XCTAssertEqual(envelope.peer, epk)
        XCTAssertEqual(envelope.room, room)
    }

    func testPairingErrorSurfacesCodeAndMessage() async throws {
        let channel = ScriptedRelayChannel()
        pushChallenge(channel, nonce: Data(repeating: 7, count: 32))
        let connection = makeConnection(on: channel)
        try await connection.authenticate()

        let invite = PairingInvite(token: "stale", epk: epk, sessionName: nil,
                                   roomID: room, relayURL: nil)
        let task = Task { try await connection.pair(invite: invite, deviceName: "test-phone",
                                                    requestID: "req-1") }
        try channel.pushServer(
            .pairError(inReplyTo: "req-1", code: .tokenExpired, message: "token expired"),
            peer: epk, room: room)
        do {
            _ = try await awaitTask(task)
            XCTFail("pair() must throw on pair_error")
        } catch let RelayConnection.PairingError.failed(code, message) {
            XCTAssertEqual(code, .tokenExpired)
            XCTAssertEqual(message, "token expired")
        }
        await connection.close()
    }

    // MARK: - Rooms (subscribe snapshot + room_announced pushes)

    func testSubscribeSendsTheFourFrameSequence() async throws {
        let channel = ScriptedRelayChannel()
        pushChallenge(channel, nonce: Data(repeating: 7, count: 32))
        let connection = makeConnection(on: channel)
        try await connection.authenticate()

        try await connection.subscribe(peers: [epk])
        await connection.close()

        let controls = try channel.sentControls()
        XCTAssertEqual(controls.suffix(4), [
            .subscribePresence(peers: [epk]),
            .subscribeRooms(peers: [epk]),
            .presenceCheck(peers: [epk]),
            .roomsCheck(peers: [epk]),
        ])
    }

    func testRoomsSnapshotAndAnnounceFlowThroughEvents() async throws {
        let channel = ScriptedRelayChannel()
        pushChallenge(channel, nonce: Data(repeating: 7, count: 32))
        let connection = makeConnection(on: channel)
        try await connection.authenticate()

        let stream = await connection.events()
        // The relay's answers to rooms_check/subscribe: a snapshot AND a live
        // room_announced push. Both must demux into the events stream.
        channel.push(#"{"type":"rooms","peer":"\#(epk)","rooms":[{"room_id":"test-room","name":"Main","cwd":"/tmp/demo","started_at":42}]}"#)
        channel.push(#"{"type":"room_announced","peer":"\#(epk)","room_id":"test-room","name":"Main","cwd":"/tmp/demo","started_at":42}"#)

        let frames = await collect(stream, upTo: 2)
        await connection.close()

        XCTAssertEqual(frames.count, 2, "snapshot + announce should both arrive")
        let roomJSON = Data(
            #"{"room_id":"test-room","name":"Main","cwd":"/tmp/demo","started_at":42}"#.utf8)
        let expectedRoom = try XCTUnwrap(JSONDecoder().decode(RoomInfo.self, from: roomJSON))
        guard case let .control(.rooms(peer, rooms)) = frames[0] else {
            return XCTFail("expected rooms snapshot, got \(frames[0])")
        }
        XCTAssertEqual(peer, epk)
        XCTAssertEqual(rooms, [expectedRoom])
        guard case let .control(.roomAnnounced(announcedPeer, announcedRoom)) = frames[1] else {
            return XCTFail("expected room_announced, got \(frames[1])")
        }
        XCTAssertEqual(announcedPeer, epk)
        XCTAssertEqual(announcedRoom, expectedRoom)
    }

    func testRefreshRoomsSendsOnlyTheTwoCheckFrames() async throws {
        let channel = ScriptedRelayChannel()
        pushChallenge(channel, nonce: Data(repeating: 7, count: 32))
        let connection = makeConnection(on: channel)
        try await connection.authenticate()

        try await connection.refreshRooms(peers: [epk])
        await connection.close()

        let controls = try channel.sentControls()
        XCTAssertEqual(controls.suffix(2), [.presenceCheck(peers: [epk]), .roomsCheck(peers: [epk])])
    }

}