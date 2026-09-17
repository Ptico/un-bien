import { requireMachine, connectControlRoom, launchAndWait } from "./machine.js"
import { pickRaw } from "./picker.js"
import { Shell } from "./tui.js"

/**
 * `unbien resume-session <machine> [--dir <cwd>] [--filter <text>] [--all] [--name <session-name>]`
 *
 * Resume a stored session on a machine: the launcher daemon lists stored pi
 * sessions (pi's public SessionManager — per-directory or global scope,
 * filtered on name/first-message, sorted by recency), the CLI shows them in a
 * type-to-filter picker, and the chosen session is relaunched via
 * `session_launch {resume: <path>}` — pi reopens the file in a tmux/herdr
 * window and joins the mesh, attachable like any live session.
 */

interface StoredSession {
  path: string
  id: string
  name?: string
  summary: string
  cwd: string
  modified: string
  messageCount: number
}

function relTime(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime()
  const m = Math.round(delta / 60_000)
  if (m < 1) return "just now"
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

/** Send `sessions_list`, await the correlated result. */
async function listSessions(
  client: import("./client.js").SessionClient,
  params: { scope: "cwd" | "all"; cwd?: string; filter?: string },
  timeoutMs = 10_000,
): Promise<StoredSession[]> {
  const id = `sl-${Date.now()}`
  return new Promise((resolve) => {
    let settled = false
    function onUb(frame: Record<string, unknown>): void {
      if (settled) return
      const type = String(frame.type ?? "")
      if (type === "error") {
        // Daemon gate/launch rejections (unknown_peer, permission_denied…)
        // must reach the user — an empty list would read as "nothing stored".
        settled = true
        client.off("ub", onUb)
        console.error(`machine rejected the listing: ${String(frame.message ?? frame.code)}`)
        resolve([])
        return
      }
      if (type === "sessions_list_result" && frame.in_reply_to === id) {
        settled = true
        client.off("ub", onUb)
        resolve(Array.isArray(frame.sessions) ? (frame.sessions as StoredSession[]) : [])
      }
    }
    client.on("ub", onUb)
    // Relay-level refusals (unknown_peer from the fail-closed content gate)
    // arrive as TOP-LEVEL typed frames — relayControl, not ub.
    client.on("relayControl", (frame: Record<string, unknown>) => {
      if (String(frame.type ?? "") === "error") {
        console.error(
          `relay refused the listing: ${String(frame.code)}${frame.peer ? ` (peer ${String(frame.peer).slice(0, 12)}… not in the machine's allow-list?)` : ""}`,
        )
      }
    })
    client.sendUb("sessions_list", { id, ...params })
    setTimeout(() => {
      if (settled) return
      settled = true
      client.off("ub", onUb)
      console.error(
        "no reply from the machine (is the launcher daemon installed and the relay up?)",
      )
      resolve([])
    }, timeoutMs)
  })
}

export async function run(argv: string[]): Promise<void> {
  const flags = new Map<string, string>()
  let target = ""
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--dir") flags.set("dir", argv[++i] ?? "")
    else if (a === "--filter") flags.set("filter", argv[++i] ?? "")
    else if (a === "--name") flags.set("name", argv[++i] ?? "")
    else if (a === "--relay") flags.set("relay", argv[++i] ?? "")
    else if (a === "--all") flags.set("all", "1")
    else if (!a.startsWith("--")) target = a
  }

  const machine = requireMachine(target)
  const label = machine.name ?? machine.epk.slice(0, 12)
  const client = await connectControlRoom(machine, flags.get("relay"))

  const scope: "cwd" | "all" = flags.get("all") ? "all" : "cwd"
  const cwd = flags.get("dir") || undefined
  const filter = flags.get("filter") || undefined
  console.error(
    `stored sessions on ${label} (${scope === "all" ? "all directories" : cwd ?? "machine cwd"})…`,
  )
  const sessions = await listSessions(client, { scope, cwd, filter })
  if (sessions.length === 0) {
    console.error("no stored sessions matched.")
    Shell.exitAfterDrain(0)
    process.exit(0)
  }

  // Type-to-filter picker, recency order (the daemon sorts). Global scope
  // shows cwd per row — it's the disambiguator there.
  const items = sessions.map((s) => ({
    value: s.path,
    label: `${s.name ?? s.summary.slice(0, 56)} · ${relTime(s.modified)} · ${s.messageCount} msgs`,
    description: scope === "all" ? s.cwd : undefined,
  }))
  const picked = await pickRaw(items)
  if (!picked) {
    console.error("cancelled.")
    Shell.exitAfterDrain(0)
    process.exit(0)
  }
  const chosen = sessions.find((s) => s.path === picked)
  if (!chosen) {
    console.error("picked session vanished — retry.")
    Shell.exitAfterDrain(1)
    process.exit(1)
  }

  const name = flags.get("name") || undefined
  const outcome = await launchAndWait(client, {
    cwd: chosen.cwd || cwd,
    name,
    resume: chosen.path,
  })
  if (!outcome.ok) {
    console.error(`launch rejected: ${outcome.note}`)
    Shell.exitAfterDrain(1)
    process.exit(1)
  }
  console.log(
    `resuming ${chosen.name ?? chosen.id.slice(0, 8)} on ${label} — ` +
      `it joins the mesh when pi opens; attach with \`unbien connect ${machine.epk.slice(0, 8)} --list\`.`,
  )
  Shell.exitAfterDrain(0)
}

await run(process.argv.slice(2))
