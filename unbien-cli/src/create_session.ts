import { loadPeers } from "./store.js"
import { requireMachine, connectControlRoom, launchAndWait } from "./machine.js"
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
    console.error(
      "no paired machines yet — run `/unbien pair` in a session, then `unbien connect '<invite>'`",
    )
    Shell.exitAfterDrain(1)
    process.exit(1)
  }
  const machine = requireMachine(target)
  const label = machine.name ?? machine.epk.slice(0, 12)
  const client = await connectControlRoom(machine, flags.get("relay"))

  const cwd = flags.get("dir") || undefined
  const name = flags.get("name") || undefined
  console.error(
    `launching pi on ${label}${cwd ? ` in ${cwd}` : ""}${name ? ` as '${name}'` : ""} …`,
  )
  const outcome = await launchAndWait(client, { cwd, name })

  if (!outcome.ok) {
    console.error(`launch rejected: ${outcome.note}`)
    Shell.exitAfterDrain(1)
    process.exit(1)
  }

  console.log(
    `launched on ${label}. The session joins the mesh when pi starts — ` +
      `attach with \`unbien connect ${machine.epk.slice(0, 8)} --list\`.`,
  )
  Shell.exitAfterDrain(0)
}

await run(process.argv.slice(2))
