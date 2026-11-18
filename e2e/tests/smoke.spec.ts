// e2e/tests/smoke.spec.ts
//
// The fresh-install smoke (HO1, research decision D4): seven assertions, each
// naming the contract it pins, all reachable on a clean clone with an empty
// catalog. Read-only — nothing here creates, uploads or deletes. Run with
// `npm run smoke` (playwright.smoke.config.ts); `npm run selfhost-check` runs it
// against the stack it just built.

import { expect, test } from '@playwright/test';

test.describe('fresh-install smoke', () => {
  test('1. /api/health answers ok with the database connected and a build identity', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.db, 'a fresh install must reach its database').toBe('connected');
    expect(typeof body.build?.version, 'the API names its build').toBe('string');
  });

  test('2. the page boots: the SPA shell is served and Angular starts without a console or page error', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push(String(e)));

    const res = await page.goto('/');
    expect(res?.status()).toBe(200);
    expect(await res!.text()).toContain('<app-root');

    // The catalog page is the landing route; its empty state must render.
    await expect(page.locator('app-root')).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(errors, `boot errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('3. the engine bundle is served with the platform CSP, nosniff and immutable cache', async ({ request }) => {
    // The versioned path the player loads (A10). The main suite pins it against
    // the frontend dependency; here it only has to be served, with its headers.
    const res = await request.get('/engine/0.2.0/WebEngineTS.standalone.js');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-security-policy']).toContain(`default-src 'self'`);
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
    expect(res.headers()['cache-control']).toContain('immutable');
  });

  test('4. /player/player.html is served and refuses to run outside the viewer', async ({ page, request }) => {
    const res = await request.get('/player/player.html');
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain('player.js');

    // The guard the frame depends on: a top-level visit is opaque and refuses.
    await page.goto('/player/player.html');
    expect(await page.evaluate(() => window.origin)).toBe('null');
    await expect(page.locator('body')).toHaveText('This page only runs inside the scenario viewer.');
  });

  test('5. /api/catalog answers JSON with a numeric total — zero is the fresh-install state', async ({ request }) => {
    const res = await request.get('/api/catalog');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.total).toBe('number');
    expect(Array.isArray(body.items ?? body.scenarios ?? [])).toBe(true);
  });

  test('6. a write without a credential is refused with 401', async ({ request }) => {
    const res = await request.post('/api/keys', { data: { label: 'smoke', role: 'author' } });
    expect(res.status(), 'no credential → 401, never 200/500').toBe(401);
  });

  test('7. the bootstrap moderator works with ADMIN_TOKEN on a fresh install', async ({ request }) => {
    test.skip(!process.env.ADMIN_TOKEN, 'ADMIN_TOKEN is unset — the bootstrap check needs the token the stack was started with');
    const res = await request.get('/api/keys', { headers: { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` } });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.keys ?? body)).toBe(true);
  });
});
