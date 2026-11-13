// e2e/playwright.smoke.config.ts
//
// The production smoke (OPS1, decision D-11): a read-only pass against a deployed
// stack, separate from the suite that builds and tears down its own world.
//
// The differences from playwright.config.ts are the point:
//   * no catalog setup — a smoke checks the one that is deployed, and an empty one
//     is a red smoke, not a fixture to fill;
//   * `E2E_BASE_URL` is required — a smoke that fell back to a default URL would
//     happily check a developer's laptop instead of the host it was sent to;
//   * every non-GET request a page makes is recorded by `smoke/writes.ts` and
//     fails the run outside the allow-list — "read-only" is a claim until it is
//     enforced.
//
//   E2E_BASE_URL=https://platform.example.invalid npm run smoke

import { defineConfig, devices } from "@playwright/test";

const BASE_URL = process.env.E2E_BASE_URL;
if (!BASE_URL) {
  throw new Error("E2E_BASE_URL is required: a smoke checks the stack it is pointed at, never a default");
}

export default defineConfig({
  testDir: "./smoke",
  // No catalog setup: the release has to be published before a smoke (DW-3.1).
  outputDir: "./smoke-results",
  reporter: [["list"]],

  fullyParallel: false,
  // One worker: a smoke is a handful of requests, and a second worker would only
  // double the load on the host it is meant to be quiet about.
  workers: 1,

  // A deployed stack may be on the far side of the world; these are generous but
  // still bounded, so an unreachable URL fails in under a minute (DW-3.2).
  timeout: 60_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: BASE_URL,
    // The viewer's own telemetry rows can be told apart from a human's (D-11).
    userAgent: `${devices["Desktop Chrome"].userAgent} VirtualLabSmoke/1`,
    // Self-signed certificates are normal on a fresh host; the operator opts in.
    ignoreHTTPSErrors: process.env.SMOKE_INSECURE_TLS === "1",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
