#!/usr/bin/env node
// e2e/scripts/make-covers.mjs
//
// P6: a cover for every published catalog row, from the scenario's own assets.
//
// There is no stock raster to lift: the release archives ship a skybox (2:1) at most,
// and `backend/preview-image.js` accepts only PNG/JPEG at 16:10 ±5% and ≥800 px wide —
// a raw asset would be refused. So the cover is the scenario's own rendered look: the
// player runs it, and the frame's canvas is screenshotted, letterboxed to 1280×800 and
// uploaded. What a student sees on the card is what they get.
//
// The bytes go to `POST /api/scenarios/:id/preview`, which stores them under their
// content hash at `/previews/<sha256>.png` — same origin, so the CSP allows them.
//
// Usage:
//   ADMIN_TOKEN=… node scripts/make-covers.mjs [--base-url http://localhost:8044]
//     [--only id,id] [--force]
// The base URL must point at a stack whose player runs; the ADMIN_TOKEN is the bootstrap
// moderator (an author or a moderator may POST a preview, nothing weaker).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};

const BASE = flag('base-url', process.env.E2E_BASE_URL ?? 'http://localhost:8044').replace(/\/+$/, '');
const ONLY = flag('only') ? new Set(flag('only').split(',').map(s => s.trim()).filter(Boolean)) : null;
const FORCE = args.includes('--force');
const TOKEN = process.env.ADMIN_TOKEN;

/** The app's engine bundle URL, read from the one place that holds it. */
function engineUrlFromFrontend() {
  const file = path.resolve('..', 'frontend', 'src', 'app', 'player', 'player-config.ts');
  const match = /ENGINE_URL = '([^']+)'/.exec(readFileSync(file, 'utf8'));
  if (!match) throw new Error(`ENGINE_URL not found in ${file}`);
  return match[1];
}

const rows = async () => {
  const res = await fetch(`${BASE}/api/catalog?limit=200`);
  if (!res.ok) throw new Error(`catalog: HTTP ${res.status}`);
  return (await res.json()).scenarios ?? [];
};

/** Waits until the engine running in the player reports drawn frames. */
async function waitForFrames(page, engineUrl, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const frame = page.frames().find(f => f.url().includes('/player/player.html'));
    if (frame) {
      try {
        const drawn = await frame.evaluate(async url => {
          const { MemoryProfiler } = await import(url);
          return (MemoryProfiler.snapshot().renderStats?.drawCalls ?? 0) > 0;
        }, new URL(engineUrl, page.url()).href);
        if (drawn) return frame;
      } catch { /* the frame is still booting */ }
    }
    await page.waitForTimeout(250);
  }
  throw new Error('no drawn frame appeared in the player');
}

/** The frame's canvas, letterboxed onto 1280×800 — exactly the aspect a preview needs. */
async function coverPng(page, engineUrl) {
  const frame = await waitForFrames(page, engineUrl);
  const canvas = frame.locator('canvas').first();
  await canvas.waitFor({ timeout: 30_000 });
  const shot = (await canvas.screenshot({ type: 'png' })).toString('base64');
  return page.evaluate(async b64 => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const out = document.createElement('canvas');
    out.width = 1280;
    out.height = 800;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#0b0e14';
    ctx.fillRect(0, 0, 1280, 800);
    const scale = Math.min(1280 / img.width, 800 / img.height);
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    ctx.drawImage(img, Math.round((1280 - w) / 2), Math.round((800 - h) / 2), w, h);
    return out.toDataURL('image/png').split(',')[1];
  }, shot);
}

async function upload(id, base64) {
  const body = new FormData();
  body.append('preview', new Blob([Buffer.from(base64, 'base64')], { type: 'image/png' }), 'cover.png');
  const res = await fetch(`${BASE}/api/scenarios/${id}/preview`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
    body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return await res.json();
}

const main = async () => {
  if (!TOKEN) {
    console.error('ADMIN_TOKEN is required — an author or a moderator may set a cover.');
    process.exit(1);
  }
  const engineUrl = engineUrlFromFrontend();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    for (const row of await rows()) {
      if (ONLY && !ONLY.has(row.id)) continue;
      if (row.imageUrl && !FORCE) {
        console.log(`skip ${row.id}: ${row.imageUrl}`);
        continue;
      }
      await page.goto(`${BASE}/play/${row.id}`, { waitUntil: 'domcontentloaded' });
      const { imageUrl, warnings } = await upload(row.id, await coverPng(page, engineUrl));
      console.log(`ok ${row.id}: ${imageUrl}${warnings?.length ? ` (${warnings.join('; ')})` : ''}`);
    }
  } finally {
    await browser.close();
  }
};

main().catch(error => {
  console.error(error.message ?? error);
  process.exit(1);
});
