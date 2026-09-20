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
export type OwnerNotifyLevel = "info" | "warning" | "error"
export type OwnerNotifyFn = (message: string, level: OwnerNotifyLevel) => void

let _hook: OwnerNotifyFn | null = null

export function setOwnerNotifyHook(fn: OwnerNotifyFn | null): void {
  _hook = fn
}

/** Notify attached app owners (toast) — no-op when no hook is registered
 *  (relay down / not yet started) or the broadcaster fails. Never throws. */
export function notifyOwners(message: string, level: OwnerNotifyLevel = "info"): void {
  try {
    _hook?.(message, level)
  } catch {
    /* best-effort */
  }
}
