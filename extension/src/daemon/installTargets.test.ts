/**
 * Component install tests — target parsing, relay template rendering, and the
 * dispatch shape. The actual service activation (launchctl/systemctl/npm/cargo)
 * needs a real system; these test the pure logic around it.
 */
import { describe, expect, it } from "vitest"
import {
  RELAY_LAUNCHD_LABEL,
  RELAY_DEFAULT_PORT,
  renderRelayTemplate,
  relayLaunchdPlistPath,
  relaySystemdUnitPath,
  relayLogPath,
  relayStateDir,
  type RelayRenderVars,
} from "../daemon/relayService.js"
import { CLI_PACKAGE } from "../daemon/cliInstall.js"
import {
  parseInstallTarget,
  type InstallTarget,
} from "../commands/housekeeping.js"

// ── parseInstallTarget ──────────────────────────────────────────────────────

describe("parseInstallTarget", () => {
  it("bare / whitespace / all → all", () => {
    expect(parseInstallTarget("")).toBe<InstallTarget>("all")
    expect(parseInstallTarget("  ")).toBe<InstallTarget>("all")
    expect(parseInstallTarget("all")).toBe<InstallTarget>("all")
    expect(parseInstallTarget("ALL")).toBe<InstallTarget>("all")
  })

  it("component names map to themselves; aliases map", () => {
    expect(parseInstallTarget("relay")).toBe<InstallTarget>("relay")
    expect(parseInstallTarget("launcher")).toBe<InstallTarget>("launcher")
    expect(parseInstallTarget("daemon")).toBe<InstallTarget>("launcher")
    expect(parseInstallTarget("cli")).toBe<InstallTarget>("cli")
  })

  it("unknown → null", () => {
    expect(parseInstallTarget("bogus")).toBeNull()
    expect(parseInstallTarget("relay extra")).toBeNull()
  })
})

// ── relay template rendering ────────────────────────────────────────────────

const relayVars: RelayRenderVars = {
  relayBin: "/Users/tester/.cargo/bin/unbien-relay",
  port: 3000,
  home: "/Users/tester",
}

describe("renderRelayTemplate", () => {
  it("launchd: substitutes binary, port, home; pins the label + keepalive", () => {
    const out = renderRelayTemplate(
      `Label {RELAY_BIN} {PORT} {HOME} {RELAY_BIN}`,
      relayVars,
    )
    expect(out).toContain("/Users/tester/.cargo/bin/unbien-relay")
    expect(out).not.toContain("{RELAY_BIN}")
    expect(out).toContain("3000")
    expect(out).toContain("/Users/tester")
  })

  it("systemd: same tokens substitute", () => {
    const out = renderRelayTemplate(
      `ExecStart={RELAY_BIN}\nEnvironment="UNBIEN_RELAY_PORT={PORT}"\nEnvironment="HOME={HOME}"`,
      relayVars,
    )
    expect(out).toContain("ExecStart=/Users/tester/.cargo/bin/unbien-relay")
    expect(out).toContain('Environment="UNBIEN_RELAY_PORT=3000"')
    expect(out).toContain('Environment="HOME=/Users/tester"')
    expect(out).not.toContain("{")
  })
})

// ── relay identity constants ────────────────────────────────────────────────

describe("relay service identity", () => {
  it("label + port defaults", () => {
    expect(RELAY_LAUNCHD_LABEL).toBe("dev.unbien.relay")
    expect(RELAY_DEFAULT_PORT).toBe(3000)
  })

  it("paths live under the user's home (user-level service, no sudo)", () => {
    expect(relayLaunchdPlistPath()).toContain("Library/LaunchAgents")
    expect(relayLaunchdPlistPath()).toContain("dev.unbien.relay.plist")
    expect(relaySystemdUnitPath()).toContain(".config/systemd/user")
    expect(relaySystemdUnitPath()).toContain("unbien-relay.service")
  })

  it("log lives in the relay's own state root", () => {
    expect(relayLogPath()).toBe(`${relayStateDir()}/relay.log`)
    expect(relayStateDir()).toContain(".local/state/un-bien")
  })
})

// ── CLI package identity ────────────────────────────────────────────────────

describe("cli package", () => {
  it("installs the published CLI package", () => {
    expect(CLI_PACKAGE).toBe("@geohar/unbien-cli")
  })
})
