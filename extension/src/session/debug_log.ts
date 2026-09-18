// File-based envelope debug log. The extension usually runs detached (no visible
// stderr), so gated diagnostics go to a file the user can `tail -f`.
// Enabled by the `debug.envelope` pref in the global config
// (`extensions/un-bien.json`) — NOT an env var, because the detached extension
// doesn't inherit a shell's env. Best-effort, never throws.

import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { loadConfig } from "../config.js"
import { unbienStateHome } from "../paths.js"

// Resolved lazily on first use (NOT at module load): the state root is
// resolved at call time so env overrides work, and resolving at import time
// would re-enter the one-time legacy-state migration during module init.
let logPath: string | undefined
function logFilePath(): string {
  if (logPath === undefined) {
    logPath = join(unbienStateHome(), "envelope-debug.log")
  }
  return logPath
}

// Resolved once: the debug pref is a dev switch, not something that flips
// mid-process, so we read the config file a single time on first use.
let enabled: boolean | undefined
function isEnabled(): boolean {
  if (enabled === undefined) enabled = loadConfig().debug?.envelope === true
  return enabled
}

/** Append a timestamped line to `<state>/envelope-debug.log` when the
 *  `debug.envelope` config pref is set. Safe inside SDK callbacks. */
export function envLog(msg: string): void {
  if (!isEnabled()) return
  try {
    const path = logFilePath()
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${new Date().toISOString()} ${msg}\n`)
  } catch {
    /* best-effort */
  }
}

// Resolved lazily on first use, same reasoning as logFilePath above.
let launcherLogPath: string | undefined
function launcherLogFilePath(): string {
  if (launcherLogPath === undefined) {
    launcherLogPath = join(unbienStateHome(), "launcher.log")
  }
  return launcherLogPath
}

// Resolved once: the launcher pref is the same kind of dev switch as the
// envelope one — not something that flips mid-process — so we read the config
// file a single time on first use. Restart the daemon to pick up a flip.
let launcherEnabled: boolean | undefined
function launcherIsEnabled(): boolean {
  if (launcherEnabled === undefined) {
    launcherEnabled = loadConfig().debug?.launcher === true
  }
  return launcherEnabled
}

/** Append a DATESTAMPED line to `<state>/launcher.log` — the launcher
 *  daemon's operational log. Gated on the `debug.launcher` config pref
 *  (SEPARATE from `debug.envelope` — enabling one must not drag in the
 *  other). With the pref off, only the service unit's stdout redirect
 *  (startup / shutdown / fatal) reaches the file. Best-effort, never
 *  throws. */
export function launcherLog(msg: string): void {
  if (!launcherIsEnabled()) return
  try {
    const path = launcherLogFilePath()
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${new Date().toISOString()} ${msg}\n`)
  } catch {
    /* best-effort */
  }
}
