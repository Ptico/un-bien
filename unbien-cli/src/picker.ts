/**
 * Session picker built on pi's own `SelectList` — arrow-key highlight,
 * type-to-filter, and pi's list theme, rather than "enter a number".
 *
 * Rendering goes to stderr (raw mode) so stdout stays clean for transcripts.
 * Input: readline keypress events — arrows/enter/escape feed SelectList's own
 * handleInput (its keybindings decode the escape sequences); printable chars
 * drive type-to-filter. The legacy raw-"data" parsing ignored multi-byte
 * escape sequences entirely, which is why arrows never moved.
 */
import { getSelectListTheme, initTheme } from "@earendil-works/pi-coding-agent"
import { SelectList, type SelectItem } from "@earendil-works/pi-tui"
import { StdinBuffer } from "@earendil-works/pi-tui"
import type { RoomInfo } from "./client.js"

const MAX_VISIBLE = 12

let themeInitialized = false

/** The SDK's theme must be initialized before any get*Theme() call; the CLI
 *  has no interactive theme bootstrapping, so the default (no name) it is. */
function ensureTheme(): void {
  if (themeInitialized) return
  initTheme()
  themeInitialized = true
}

/**
 * Shared keypress wiring for the pickers: arrows/enter/escape feed the list's
 * own handleInput (keybindings decode the raw sequences); printable chars
 * drive type-to-filter; backspace trims; Ctrl-C cancels. Registers on the
 * input stream; returns the unsubscribe (finish must call it).
 * `paint(filter)` re-renders after any filter change.
 */
function wireKeys(
  input: NodeJS.ReadStream,
  list: { handleInput(data: string): void; setFilter(filter: string): void },
  paint: (filter: string) => void,
  finish: (value: null) => void,
): () => void {
  // pi-tui's own input decoder: buffers split escape sequences and emits
  // COMPLETE sequences — the same decoding pi's TUI pickers rely on. Hand-
  // parsing raw "data" chunks loses arrows whenever ESC and [A arrive apart.
  const buffer = new StdinBuffer()
  let filter = ""
  buffer.on("data", (sequence: string) => {
    // Navigation + confirm + cancel: the list's keybindings decode sequences.
    if (
      sequence === "\x1b[A" ||
      sequence === "\x1b[B" ||
      sequence === "\r" ||
      sequence === "\x1b"
    ) {
      return list.handleInput(sequence)
    }
    if (sequence === "\x7f" || sequence === "\b") {
      filter = filter.slice(0, -1)
      list.setFilter(filter)
      paint(filter)
      return
    }
    if (sequence === "\x03") return finish(null)
    // Printable run: type-to-filter (a paste arrives as one chunk).
    if (/^[\x20-\x7e]+$/.test(sequence)) {
      filter += sequence
      list.setFilter(filter)
      paint(filter)
    }
    // Anything else (mouse, kitty CSI-u, …): silently ignored.
  })
  const onData = (chunk: Buffer | string): void => {
    buffer.process(typeof chunk === "string" ? chunk : chunk.toString("utf8"))
  }
  input.on("data", onData)
  return () => {
    input.off("data", onData)
    buffer.destroy()
  }
}

/** Build picker items from session rooms: name (or id), deduped with a short
 *  session-id suffix so same-named sessions stay addressable. */
function buildItems(rooms: readonly RoomInfo[]): {
  items: SelectItem[]
  byValue: Map<string, RoomInfo>
} {
  const seen = new Map<string, number>()
  const items: SelectItem[] = []
  const byValue = new Map<string, RoomInfo>()

  for (const room of rooms) {
    const base = room.name ?? room.sessionId?.slice(0, 8) ?? room.room_id
    const count = (seen.get(base) ?? 0) + 1
    seen.set(base, count)
    const id = room.sessionId?.slice(0, 8) ?? room.room_id
    const value = count === 1 ? base : `${base} (${id})`
    items.push({
      value,
      label: room.parent ? `${value} (subagent)` : value,
      description: room.cwd ?? "",
    })
    byValue.set(value, room)
  }
  return { items, byValue }
}

/**
 * Renders on stderr in raw mode so stdout stays clean for the transcript.
 * Resolves to the chosen session, or null if cancelled.
 */
export function pickSession(
  rooms: readonly RoomInfo[],
): Promise<RoomInfo | null> {
  ensureTheme()
  const { items, byValue } = buildItems(rooms)
  const list = new SelectList(items, MAX_VISIBLE, getSelectListTheme())

  const input = process.stdin
  const output = process.stderr
  const width = output.columns ?? 100
  let lastHeight = 0

  const paint = (filter = "") => {
    if (lastHeight > 0) output.write(`\u001b[${lastHeight}A`)
    const lines = [
      `  filter: ${filter}\u001b[K`,
      ...list.render(width).map((line) => `${line}\u001b[K`),
    ]
    for (const line of lines) output.write(`${line}\n`)
    lastHeight = lines.length
  }

  return new Promise((resolve) => {
    const finish = (room: RoomInfo | null) => {
      offKeys()
      if (input.isTTY) input.setRawMode(false)
      // Deliberately NOT paused: the shell takes stdin over next, and a paused
      // stream there is a prompt box that renders but never sees a keystroke.
      output.write("\u001b[?25h")
      resolve(room)
    }

    const offKeys = wireKeys(input, list, paint, () => finish(null))

    list.onSelect = (item) => finish(byValue.get(item.value) ?? null)
    list.onCancel = () => finish(null)

    if (input.isTTY) input.setRawMode(true)
    paint()
  })
}

/**
 * Generic variant: raw-mode SelectList over caller-built items (the resume
 * chooser reuses this — its rows carry name/summary/recency, not RoomInfo).
 * Resolves the chosen `value`, or null if cancelled.
 */
export function pickRaw(items: readonly SelectItem[]): Promise<string | null> {
  ensureTheme()
  const list = new SelectList([...items], MAX_VISIBLE, getSelectListTheme())

  const input = process.stdin
  const output = process.stderr
  const width = output.columns ?? 100
  let lastHeight = 0

  const paint = (filter = "") => {
    if (lastHeight > 0) output.write(`\u001b[${lastHeight}A`)
    const lines = [
      `  filter: ${filter}\u001b[K`,
      ...list.render(width).map((line) => `${line}\u001b[K`),
    ]
    for (const line of lines) output.write(`${line}\n`)
    lastHeight = lines.length
  }

  return new Promise((resolve) => {
    const finish = (value: string | null) => {
      offKeys()
      if (input.isTTY) input.setRawMode(false)
      output.write("\u001b[?25h")
      resolve(value)
    }

    const offKeys = wireKeys(input, list, paint, () => finish(null))

    list.onSelect = (item) => finish(item.value)
    list.onCancel = () => finish(null)

    if (input.isTTY) input.setRawMode(true)
    paint()
  })
}
