# Un Bien — the un-bien companion app

SwiftUI companion (iOS 18+ / macOS 15+) for the
[un-bien](https://github.com/georgeharker/un-bien) extension: pair your
phone or Mac with machines running the Pi coding agent + un-bien, watch
sessions stream live, steer/fork/rename/terminate them remotely, launch
new sessions and resume stored ones.

## Setup

1. **Run a relay** — a small WebSocket hub the app and your machines
   connect to. Options: the `un-bien-relay` crate (`cargo install
   un-bien-relay`, default port 3000), Docker, or any host that can
   reach your machines (localhost, LAN, Tailnet, VPS).
2. **Add the relay in the app** — Settings → Add relay (`ws://host:3000`).
3. **Pair a machine** — scan the QR code the machine's un-bien extension
   offers (the `unbien://` deep link carries the pairing invite; you pick
   which relay to pair against).

## Home

The Home list shows your relays, and under each: the paired **machines**
(rows with a desktopcomputer icon) and their **live sessions** (tapping
one opens the transcript). Sessions stream tool calls, streaming text,
thinking blocks, and panels (plans, subagents) live.

### Machine row

- **＋ chip** (right side): start a *new* conversation on that machine —
  pick a working directory and optional name; the machine's configured
  backend (tmux/herdr) spawns pi.
- **Long-press** the row for the machine menu:
  - **New Conversation…** — same as the chip.
  - **Resume Session…** — pick from the machine's *stored* pi sessions
    (recency-ordered, type-to-filter, sortable) and relaunch one. The
    resumed chat auto-opens when it comes live. New in 1.2 — requires
    an up-to-date launcher daemon (see capability table below).

### In a session (transcript)

- Steer / queue follow-ups while the agent works; approve tool calls.
- **Fork from here / Clone / Branch** — fork at any conversation entry,
  duplicate a whole session, or branch in place (pi `/tree` semantics).
- **Model & thinking picker** — the slider control in the top bar.
- **Rename**, **End Chat…** (graceful remote terminate), subagent
  panels, plan panels.

### Slash commands

Text starting with `/` in the composer runs as a command **on the
machine** — the same dispatch the pi TUI uses. Built-ins with remote
equivalents work directly (`/compact`, `/new`, `/name <name>`,
`/thinking <level>`, `/model <term>`); `/unbien …` commands run as
registered; machine-local TUI commands (e.g. `/settings`, `/export`)
and unknown commands are **refused with a toast** rather than silently
reaching the model. Command output arrives as transient toasts at the
top of the screen.

## Capability gating

Features appear only when the machine advertises the matching
capability, so older extension/daemon versions degrade gracefully:

| Capability | Advertised by | Gates |
|---|---|---|
| `remote_launch` | presence daemon | the launch chip / New Conversation |
| `session_resume` | presence daemon | Resume Session… |
| `remote_terminate` | session | End Chat… |
| `models` / `thinking` | session | model & thinking pickers |

## Building & testing

```sh
xcodegen generate        # regenerates UnBien.xcodeproj (required after adding files)
open UnBien.xcodeproj    # UnBien-iOS / UnBien-macOS schemes
```

Command line:

```sh
swift build              # macOS build of the SwiftPM packages
swift test               # full suite (UnBienCore + UnBienApp)
```

Version lives in the generated `App/{iOS,macOS}/Info.plist`
(`CFBundleShortVersionString` / `CFBundleVersion`); App Store archives go
through `scripts/archive-appstore.sh` in the repo root.

## Diagnostics

The companion daemons log to `~/.local/state/un-bien/` on each machine —
enable them in the machine's `extensions/un-bien.json`:

```json
"debug": { "launcher": true, "relay": true }
```

`launcher.log` / `relay.log` then carry datestamped operational lines.
Restart the daemon after flipping a pref (each reads it once at startup).
