#!/usr/bin/env node
/** `unbien pair <invite-uri>` — pair this CLI device with a machine's token.
 *
 * A thin standalone command: connect.ts's inline pairing (inside the full
 * session-attach flow) needs the relay connect + room plumbing; this is JUST
 * the pair-and-remember step, so re-pairing after a revoke (or pairing a
 * second machine) doesn't require a full connect round-trip.
 *
 * Usage:
 *   unbien pair <unbien://pair?t=…&epk=…&rm=…>
 *   unbien pair --name my-laptop <unbien://pair?t=…&epk=…&rm=…>
 */
import { SessionClient } from "./client.js"
import { loadOrCreateIdentity } from "./identity.js"
import { parseInvite } from "./invite.js"
import { rememberPeer, loadPeers, loadRelays } from "./store.js"

const args = process.argv.slice(2)
let name = "unbien-cli"
let relayFlag = ""
const positional: string[] = []

for (let i = 0; i < args.length; i++) {
  const arg = args[i]!
  if (arg === "--name" || arg === "-n") {
    name = args[++i] ?? name
  } else if (arg === "--relay" || arg === "-r") {
    relayFlag = args[++i] ?? ""
  } else if (arg === "--help" || arg === "-h") {
    console.log(
      "usage: unbien pair [--name <device-name>] <unbien://pair?t=…&epk=…&rm=…>\n" +
        "\n" +
        "  --name, -n   device name shown in the machine's /unbien devices list\n" +
        "               (default: unbien-cli)\n",
    )
    process.exit(0)
  } else {
    positional.push(arg)
  }
}

const raw = positional[0]
if (!raw) {
  // No invite given — show remembered machines for context
  const peers = loadPeers()
  if (peers.length > 0) {
    console.error(
      "Already paired with:\n" +
        peers
          .map((p) => `  ${p.name} (${p.epk.slice(0, 8)}…) → ${p.relayUrl}`)
          .join("\n") +
        "\n\nTo pair a new machine (or re-pair after a revoke), run /unbien pair\n" +
        "on the machine and paste the resulting unbien:// URI here.",
    )
  } else {
    console.error(
      "No paired machines yet. Run /unbien pair on the machine you want to\n" +
        "connect to, then: unbien pair <unbien://pair?t=…&epk=…&rm=…>",
    )
  }
  process.exit(1)
}

const invite = parseInvite(raw)
// Relay URL: the URI itself doesn't carry it (rm= is the room, not the relay)
// — same resolution as connect.ts: --relay flag, else UNBIEN_RELAY env.
let relayUrl = relayFlag || process.env["UNBIEN_RELAY"] || ""
if (!relayUrl) {
  // FALL BACK to the relay registry: if exactly one relay is remembered,
  // use it; if multiple, list them and ask for --relay.
  const relays = loadRelays()
  if (relays.length === 1) {
    relayUrl = relays[0]!.url
    console.error(
      `[pair] using remembered relay: ${relays[0]!.name} (${relayUrl})`,
    )
  } else if (relays.length > 1) {
    console.error(
      "Multiple relays remembered — pick one:\n" +
        relays.map((r) => `  --relay ${r.url}  (${r.name})`).join("\n"),
    )
    process.exit(1)
  } else {
    console.error(
      "No relay URL. Pass --relay <url>, set UNBIEN_RELAY, or add one:\n" +
        "  unbien relay add <url>",
    )
    process.exit(1)
  }
}

const keypair = loadOrCreateIdentity()
const client = new SessionClient(relayUrl, keypair, invite)

try {
  await client.connect()
  client.pair(name)
  rememberPeer({
    epk: invite.epk,
    relayUrl,
    name,
    pairedAt: new Date().toISOString(),
  })
  console.error(
    `[paired] ${name} → machine ${invite.epk.slice(0, 8)}… (relay ${relayUrl})\n` +
      "Run `unbien` (or `unbien connect`) to attach to sessions.",
  )
  client.close()
} catch (err) {
  console.error(
    `[pair] failed: ${err instanceof Error ? err.message : String(err)}`,
  )
  process.exit(1)
}
