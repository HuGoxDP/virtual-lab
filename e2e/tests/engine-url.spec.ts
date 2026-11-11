// path: e2e/tests/engine-url.spec.ts
//
// A10: the platform runs the engine from a versioned path. This suite runs
// beside the frontend checkout, so the version the stack serves must be the
// version the frontend depends on — pinned here the same way the app's own
// spec pins it, because two literals that must agree otherwise drift silently
// (the old path 404s, and the frame reports "Failed to fetch dynamically
// imported module" in a student's browser instead).

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';

import { ENGINE_URL } from '../helpers/engine';

const FRONTEND_ENGINE_PKG = path.resolve('..', 'frontend', 'node_modules', 'WebEngineTS', 'package.json');

test('the engine URL carries the version the frontend depends on', () => {
  if (!existsSync(FRONTEND_ENGINE_PKG)) {
    // Pointed at a stack whose frontend checkout is elsewhere: nothing to compare.
    test.skip(true, `no frontend dependency at ${FRONTEND_ENGINE_PKG}`);
  }
  const version = JSON.parse(readFileSync(FRONTEND_ENGINE_PKG, 'utf8')).version as string;
  expect(ENGINE_URL).toBe(`/engine/${version}/WebEngineTS.standalone.js`);
});

test('the engine URL is versioned, not the old /assets path', () => {
  expect(ENGINE_URL.startsWith('/engine/')).toBe(true);
  expect(ENGINE_URL.startsWith('/assets/')).toBe(false);
});
