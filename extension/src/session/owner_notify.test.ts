import { describe, expect, it, vi } from "vitest"
import { chainUiNotify, notifyOwners, setOwnerNotifyHook } from "./owner_notify.js"

describe("chainUiNotify", () => {
  it("chains: original notify AND broadcast both fire", () => {
    const orig = vi.fn()
    const broadcast = vi.fn()
    const ui = { notify: orig }

    chainUiNotify(ui, broadcast)
    ui.notify!("hello", "warning")

    expect(orig).toHaveBeenCalledWith("hello", "warning")
    expect(broadcast).toHaveBeenCalledWith("hello", "warning")
  })

  it("broadcast defaults the level to info", () => {
    const orig = vi.fn()
    const broadcast = vi.fn()
    const ui = { notify: orig }

    chainUiNotify(ui, broadcast)
    ui.notify!("plain")

    expect(broadcast).toHaveBeenCalledWith("plain", "info")
  })

  it("is idempotent per ui object (no double chaining)", () => {
    const orig = vi.fn()
    const broadcast = vi.fn()
    const ui = { notify: orig }

    chainUiNotify(ui, broadcast)
    chainUiNotify(ui, broadcast)
    ui.notify!("once")

    expect(orig).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledTimes(1)
  })

  it("headless ui (no notify member) is left untouched", () => {
    const ui = {}
    chainUiNotify(ui as { notify?: (m: string, l?: string) => void }, vi.fn())
    expect("notify" in ui).toBe(false)
  })
})

describe("notifyOwners", () => {
  it("is a no-op without a registered hook (never throws)", () => {
    setOwnerNotifyHook(null)
    expect(() => notifyOwners("anything", "warning")).not.toThrow()
  })

  it("routes through the registered hook with the level", () => {
    const hook = vi.fn()
    setOwnerNotifyHook(hook)
    try {
      notifyOwners("report", "warning")
      expect(hook).toHaveBeenCalledWith("report", "warning")
    } finally {
      setOwnerNotifyHook(null)
    }
  })
})
