// e2e/playwright.config.ts
//
// Browser tests against the composed stack — nginx, the API and the database
// as they actually run, not the Angular dev server. 208 unit tests cover the
// logic; none of them can see a rendered frame, a focus trap or a lost WebGL
// context, and `docs/test-plan.md` §7 is the list of what that leaves unproven.
//
// The stack is expected to be up already (`docker compose up -d`) — booting it
// per run would add minutes to every invocation. `global-setup.ts` fails fast
// with an explanation when it is not.

import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8044';

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  outputDir: './test-results',

  // These tests share one catalog: the admin path creates and deletes rows, and
  // the viewer path is heavy enough that parallel WebGL contexts contend for
  // SwiftShader. Serial is slower and honest.
  fullyParallel: false,
  workers: 1,

  // A scenario run means downloading an archive, unpacking it, compiling
  // shaders and rendering — under SwiftShader, on a cold cache.
  timeout: 90_000,
  expect: { timeout: 15_000 },

  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,

  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: process.env.CI ? 'retain-on-failure' : 'off',
    // The UI is Ukrainian; a mismatched locale would change date formatting.
    locale: 'uk-UA',
    timezoneId: 'Europe/Kyiv',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Headless Chromium reaches WebGL2 through ANGLE + SwiftShader and
        // reports ASTC, ETC and S3TC, so KTX2 transcoding has a real target
        // format here. Verified before these tests were written — without it
        // every viewer assertion would be testing the fallback path instead.
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
});
