#!/usr/bin/env node
/** Single front door: `unbien <command>`. */

const COMMANDS = new Map([
  ["connect", () => import("./connect.js")],
  ["replay", () => import("./replay.js")],
  ["pair", () => import("./pair.js")],
  ["relay", () => import("./relay.js")],
])

// --version/-V BEFORE subcommand dispatch: must answer even when nothing is
// installed/remembered yet — the extension's install verification calls
// exactly this to confirm the npm-global bin landed on PATH.
if (process.argv[2] === "--version" || process.argv[2] === "-V") {
  try {
    const { readFileSync } = await import("node:fs")
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    )
    console.log(pkg.version)
    process.exit(0)
  } catch {
    // Corrupted/missing package.json: report unknown rather than a stack trace.
    console.error("unbien (version unknown)")
    process.exit(0)
  }
}

const [command] = process.argv.slice(2)
// DEFAULT to `connect` when no subcommand given: the overwhelmingly common
// case is attaching to the machine (or resuming a remembered one); the usage
// banner still shows the full surface for discovery.
const verb = command ?? (COMMANDS.has("connect") ? "connect" : undefined)
const load = verb ? COMMANDS.get(verb) : undefined

if (!load) {
  console.error(
    `usage: unbien [command] [options]\n\n` +
      "  connect   attach to a live pi session over the relay (default)\n" +
      "  replay    render a captured envelope stream from a file\n" +
      "  pair      pair with a machine (paste its unbien:// invite)\n" +
      "  relay     manage remembered relays (add / remove / list)\n\n" +
      "run `unbien <command>` with no arguments for its options.",
  )
  process.exit(command ? 1 : 0)
}

// The subcommands parse `process.argv.slice(2)` themselves, so drop the verb.
if (verb) process.argv.splice(2, 1)
await load()
