import { loadPeers, type PairedPeer } from "./store.js"
import { loadOrCreateIdentity } from "./identity.js"
import { SessionClient } from "./client.js"
import { Shell } from "./tui.js"

/**
 * `unbien create-session <machine> [--dir <cwd>] [--name <session-name>]`
 *
 * Creates a NEW pi session on an idle machine: sends `ub.session_launch` to
 * that machine's control room, where the launcher daemon (remote_launch cap)
 * spawns a pi window via tmux/herdr — the same path the app's LaunchSessionSheet
 * uses. No live pi needs to be running; the daemon is the whole story.
 *
 * The new session joins the mesh once pi starts (same announce path as any
 * launch), so it shows up in `unbien connect --list` and the app — attach is
 * a separate, normal connect.
 */

/** Machine discovery: name (exact or prefix) or epk prefix, over paired peers. */
function resolveMachine(target: string): PairedPeer | null {
  const peers = loadPeers()
  if (peers.length === 0) return null
  if (!target) return peers[peers.length - 1] // last-paired, matching connect's default
  const t = target.toLowerCase()
  return (
    peers.find((p) => p.name?.toLowerCase() === t) ??
    peers.find((p) => p.name?.toLowerCase().startsWith(t)) ??
    peers.find((p) => p.epk.startsWith(target)) ??
    null
  )
}

interface LaunchOutcome {
  ok: boolean
  note: string
}

/** Send session_launch and await the daemon's error frame (or its absence). */
async function launchAndWait(
  client: SessionClient,
  cwd: string | undefined,
  name: string | undefined,
  timeoutMs = 8_000,
): Promise<LaunchOutcome> {
  return new Promise((resolve) => {
    let settled = false
    const onUb = (frame: Record<string, unknown>) => {
      if (settled) return
      const type = String(frame.type ?? "")
      if (type === "error") {
        settled = true
        resolve({
          ok: false,
          note: String(frame.message ?? frame.code ?? "launch rejected"),
        })
      }
      // The daemon sends no success ack (the new session announces itself via
      // its own room) — absence of an error frame within the window is success.
    }
    client.on("ub", onUb as (frame: Record<string, unknown>) => void)
    client.sendUb("session_launch", {
      ...(cwd ? { cwd } : {}),
      ...(name ? { name } : {}),
    })
    setTimeout(() => {
      if (settled) return
      settled = true
      client.off("ub", onUb as (frame: Record<string, unknown>) => void)
      resolve({ ok: true, note: "" })
    }, timeoutMs)
    })
}

export async function run(argv: string[]): Promise<void> {
  const flags = new Map<string, string>()
  let target = ""
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--dir") flags.set("dir", argv[++i] ?? "")
    else if (a === "--name") flags.set("name", argv[++i] ?? "")
    else if (a === "--relay") flags.set("relay", argv[++i] ?? "")
    else if (!a.startsWith("--")) target = a
  }

  if (loadPeers().length === 0) {
    console.error("no paired machines yet — run `/unbien pair` in a session, then `unbien connect '<invite>'`")
    Shell.exitAfterDrain(1)
  }
  const machine: PairedPeer | null = resolveMachine(target)
  if (!machine) {
    console.error(
      `no machine matching '${target}'. Known:` +
        loadPeers()
          .map((p) => `\n  ${p.name ?? p.epk.slice(0, 12)} (${p.epk.slice(0, 10)}…)`)
          .join(""),
    )
    Shell.exitAfterDrain(1)
    return // Shell.exitAfterDrain is async-drained; narrowing needs this
  }
  const label = machine.name ?? machine.epk.slice(0, 12)

  // One client per (relay, machine) — the invite's epk scopes the daemon.
  const relayUrl = flags.get("relay") ?? machine.relayUrl
  const keypair = loadOrCreateIdentity()
  const crypto = await import("node:crypto")
  const controlRoom = crypto
    .createHash("sha256")
    .update(String.fromCharCode(0) + "control" + String.fromCharCode(0) + machine.epk)
    .digest("base64url")
    .slice(0, 12)

  const client = new SessionClient(relayUrl, keypair, {
    token: "",
    epk: machine.epk,
    roomId: controlRoom,
  })
  try {
    await client.connect()
  } catch {
    console.error(`[relay] unreachable: ${relayUrl} (${label})`)
    Shell.exitAfterDrain(1)
  }

  const cwd = flags.get("dir") || undefined
  const name = flags.get("name") || undefined
  console.error(`launching pi on ${label}${cwd ? ` in ${cwd}` : ""}${name ? ` as '${name}'` : ""} …`)
  const outcome = await launchAndWait(client, cwd, name)

  if (!outcome.ok) {
    console.error(`launch rejected: ${outcome.note}`)
    Shell.exitAfterDrain(1)
  }

  // Machine name (stored) may differ from the daemon's hostname — query
  // presence for the authoritative hostname in the confirmation line.
  console.log(
    `launched on ${label}. The session joins the mesh when pi starts — ` +
      `attach with \`unbien connect ${machine.epk.slice(0, 8)} --list\`.`,
  )
  Shell.exitAfterDrain(0)
}

await run(process.argv.slice(2))
