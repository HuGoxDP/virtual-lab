// e2e/playwright.smoke.config.ts
//
// The fresh-install smoke (HO1): the same browser shape as the main config —
// Ukrainian locale, Kyiv timezone, one serial worker — but its own setup gate
// and its own spec set. The main suite refuses an empty catalog because it opens
// real scenarios; a fresh install has none by design, and this is the layer
// that can prove one works anyway. Read-only: nothing here writes to the stack.

import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8044';

export default defineConfig({
  testDir: './tests',
  testMatch: /smoke\.spec\.ts$/,
  globalSetup: './smoke-setup.ts',
  outputDir: './test-results',

  // Serial, like the main config: one stack, one browser, no contention.
  fullyParallel: false,
  workers: 1,

  // No scenario downloads or shader compiles here — a boot and a handful of
  // requests. The generous bound is for a cold SwiftShader page boot.
  timeout: 60_000,
  expect: { timeout: 15_000 },

  forbidOnly: !!process.env.CI,
  retries: 0,

  reporter: [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    locale: 'uk-UA',
    timezoneId: 'Europe/Kyiv',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
});
