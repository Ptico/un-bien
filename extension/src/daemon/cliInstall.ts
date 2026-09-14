/**
 * CLI package install — `npm install -g @geohar/unbien-cli`.
 *
 * The terminal client (`unbien`) is its own npm package, separate from the
 * extension. `/unbien install cli` (and `all`) installs it globally so the
 * user gets the `unbien` bin on $PATH.
 *
 * Idempotent: npm install -g over an existing install upgrades to latest.
 * We verify the bin afterwards via `unbien --version` and report what landed.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

/** The published CLI package (see unbien-cli/package.json `name`). */
export const CLI_PACKAGE = "@geohar/unbien-cli"

export interface CliInstallResult {
  version: string | null
  log: string[]
}

export async function installCliPackage(
  onLog?: (line: string) => void,
): Promise<CliInstallResult> {
  const log: string[] = []
  const push = (l: string) => {
    log.push(l)
    onLog?.(l)
  }

  // npm is a sibling of node everywhere node is installed; resolve npm-cli.js
  // from process.execPath's tree so we don't depend on `npm` being on a
  // possibly-sparse PATH (same reasoning as findNodeBinary in install.ts).
  const npmCmd =
    process.platform === "win32" ? "npm.cmd" : "npm"
  push(`npm install -g ${CLI_PACKAGE} …`)

  const { stdout, stderr } = await execFileAsync(
    npmCmd,
    ["install", "-g", CLI_PACKAGE],
    { timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024 },
  ).catch((err) => {
    const detail =
      (err as { stderr?: string; message?: string }).stderr ??
      (err as { message?: string }).message ??
      String(err)
    throw new Error(
      `npm install -g ${CLI_PACKAGE} failed: ${detail}\n` +
        "  If npm isn't found, install Node from https://nodejs.org and retry.",
    )
  })
  for (const line of `${stdout}\n${stderr}`.split("\n")) {
    if (line.trim()) push(line.trim())
  }

  // Verify: `unbien --version` (win32: npm writes unbien.cmd shims).
  let version: string | null = null
  try {
    const bin = process.platform === "win32" ? "unbien.cmd" : "unbien"
    const { stdout: vOut } = await execFileAsync(bin, ["--version"], {
      timeout: 15_000,
    })
    version = vOut.trim() || null
    push(`verified: unbien ${version}`)
  } catch {
    push(
      "⚠ installed, but `unbien --version` failed — the npm global bin dir " +
        "may not be on $PATH. Open a new terminal and run `unbien --version`.",
    )
  }

  return { version, log }
}
