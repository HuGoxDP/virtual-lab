// e2e/screenshot-scenarios.mjs
//
// One-off tool, not part of the Playwright suite: opens every published
// scenario in a real browser, waits for the engine's first drawn frame, and
// saves a screenshot of the canvas. Used to give the catalog real thumbnails
// instead of placeholders.
//
//   node screenshot-scenarios.mjs

import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const BASE_URL = process.env.BASE_URL || 'http://localhost:8044';
const OUT_DIR = path.join(import.meta.dirname, 'screenshots');

async function waitForFirstFrame(page, timeout = 60_000) {
  await page.waitForFunction(
    async () => {
      const { MemoryProfiler } = await import('WebEngineTS');
      return (MemoryProfiler.snapshot().renderStats?.drawCalls ?? 0) > 0;
    },
    undefined,
    { timeout, polling: 500 }
  );
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const catalogRes = await fetch(`${BASE_URL}/api/catalog`);
  const catalog = await catalogRes.json();

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  for (const scenario of catalog.scenarios) {
    const { id } = scenario;
    process.stdout.write(`[${id}] opening... `);
    try {
      await page.goto(`${BASE_URL}/play/${id}`, { waitUntil: 'domcontentloaded' });
      await waitForFirstFrame(page);
      // A few extra settle frames — the first drawn frame can still be mid-fade
      // or mid-camera-move for scenarios that animate their intro.
      await page.waitForTimeout(1500);

      // Hide the floating UI chrome (back button, title badge, restart/fullscreen)
      // so the thumbnail shows only the rendered scene.
      await page.evaluate(() => {
        for (const sel of ['.back-btn', '.title-badge', '.viewer-controls']) {
          document.querySelector(sel)?.style.setProperty('visibility', 'hidden');
        }
      });

      const canvas = page.locator('canvas.webgl-canvas');
      const file = path.join(OUT_DIR, `${id}.jpg`);
      await canvas.screenshot({ path: file, type: 'jpeg', quality: 90 });
      console.log(`saved ${file}`);
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
    }
  }

  await browser.close();
}

main();
