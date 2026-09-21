/**
 * Owner-notify bridge: lets command handlers push TRANSIENT notices to
 * attached app owners (toasts) alongside the local `ctx.ui.notify`, without
 * importing index.ts's relay state (circular).
 *
 * index.ts registers the implementation at startup — a broadcast of
 * `extension_ui_request { method: "notify", notify_type, message }` to all
 * active peers, the same shape the ask-flow bridge and the `/unbien test
 * ask-notify` scenario already use, and the same transport the ask flows
 * ride to reach the phone.
 *
 * Deliberately fire-and-forget: a transient notice is best-effort feedback,
 * never a durable record (the command's durable effects arrive as their own
 * transcript frames / state changes).
 */
/** Wire-level level string: "info" | "warning" | "error" (unknown values are
 *  tolerated by the app - it maps them to the info styling). */
export type OwnerNotifyLevel = string
export type OwnerNotifyFn = (message: string, level: string) => void

let _hook: OwnerNotifyFn | null = null

export function setOwnerNotifyHook(fn: OwnerNotifyFn | null): void {
  _hook = fn
}

/** Notify attached app owners (toast) — no-op when no hook is registered
 *  (relay down / not yet started) or the broadcaster fails. Never throws. */
export function notifyOwners(message: string, level: string = "info"): void {
  try {
    _hook?.(message, level)
  } catch {
    /* best-effort */
  }
}

/**
 * CHAIN a ui bridge's notify with the owner broadcast. Called on the
 * runner's SHARED uiContext at session_start: every extension's
 * ctx.ui.notify (third-party extensions included) then renders on the host
 * surface (TUI panel when present, no-op when headless) AND reaches paired
 * app owners as transient toasts. Idempotent per object (guard flag).
 */
export function chainUiNotify<L extends string>(
  ui: { notify?: (message: string, level?: L) => void },
  broadcast: (message: string, level: string) => void,
): void {
  const anyUi = ui as {
    notify?: (message: string, level?: string) => void
    __unbienChained?: boolean
  }
  if (typeof anyUi.notify !== "function" || anyUi.__unbienChained) return
  const orig = anyUi.notify.bind(ui)
  anyUi.notify = (message: string, level?: string) => {
    orig(message, level)
    broadcast(message, level ?? "info")
  }
  anyUi.__unbienChained = true
}
