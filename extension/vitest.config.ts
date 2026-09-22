import { defineConfig } from "vitest/config";

// Only override what we must: a shared setup file that gives every test a
// hermetic `UNBIEN_*` env (see vitest.setup.ts). Everything else stays on
// vitest defaults (node environment, default include globs).
export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    // 15s (vitest default is 5s): two npm-publish releases died on CI-only
    // timeouts of real connect-flow tests (received_images 2026-09-18,
    // relay _cmdStart 2026-09-22) - loaded runners need headroom, and a
    // single global bump retires the per-test whack-a-mole.
    testTimeout: 15_000,
  },
});
