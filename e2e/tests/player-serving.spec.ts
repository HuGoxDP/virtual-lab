// e2e/tests/player-serving.spec.ts
//
// Player isolation, phase 4 - nginx serves the engine's sandboxed player under /player/.
//
// The headers come from nginx, so this runs against a rebuilt stack, not the dev server. What is
// asserted is the contract the frame depends on: its own CSP (origin named explicitly, never
// 'self'), the `sandbox` directive that keeps it opaque when opened directly, `frame-ancestors
// 'self'`, no X-Frame-Options, and `ACAO: *` on everything the opaque frame loads, because its
// origin is the string `null` and a fetch from it is cross-origin to the very server that served it.

import { expect, test, type APIResponse } from '@playwright/test';

/** What the frame's own origin looks like to the server: the string `null`. */
const FROM_FRAME = { headers: { Origin: 'null' } };

const header = (res: APIResponse, name: string) => res.headers()[name];

test.describe('player serving', () => {
  test('DW-4.1 /player/player.html carries the player CSP, sandbox and frame-ancestors, and no X-Frame-Options', async ({ page, request }) => {
    // The browser's own idea of the origin, scheme and port included.
    await page.goto('/');
    const origin = await page.evaluate(() => location.origin);

    const res = await request.get('/player/player.html', FROM_FRAME);
    expect(res.status()).toBe(200);

    expect(header(res, 'content-security-policy')).toBe(
      `default-src 'none'; script-src ${origin} blob: 'unsafe-eval'; connect-src ${origin} blob:; ` +
      `img-src blob:; frame-ancestors 'self'; sandbox allow-scripts allow-pointer-lock`
    );
    expect(header(res, 'content-security-policy'), `'self' must not be used as a source`).not.toMatch(/(script|connect)-src[^;]*'self'/);
    expect(header(res, 'content-security-policy')).not.toContain('allow-same-origin');
    expect(header(res, 'x-frame-options'), 'X-Frame-Options would fight frame-ancestors').toBeUndefined();
    expect(header(res, 'x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toContain('player.js');
  });

  const ACAO_PATHS = [
    '/player/player.html',
    '/player/player.js',
    '/assets/WebEngineTS.standalone.js',
    '/assets/basis/basis_transcoder.js',
    '/assets/basis/basis_transcoder.wasm',
    // Not published as files under these names, but the header is `always`: a 404 for a missing
    // object or manifest must still be readable, or the frame reports a CORS error, not "not found".
    '/a/objects/00/missing.js',
    '/a/missing.json',
  ];

  for (const path of ACAO_PATHS) {
    test(`DW-4.1 ACAO: * on ${path}, requested from Origin: null`, async ({ request }) => {
      const res = await request.get(path, FROM_FRAME);
      expect(header(res, 'access-control-allow-origin')).toBe('*');
      if (!path.startsWith('/a/')) expect(res.status(), `${path} must exist`).toBe(200);
    });
  }

  test('DW-4.1 player.js is not taken by the static-asset regex block: it has the player headers, not the platform CSP', async ({ request }) => {
    const res = await request.get('/player/player.js', FROM_FRAME);
    expect(res.status()).toBe(200);

    // The regex block would add a 30-day immutable cache, X-Frame-Options and the platform CSP.
    expect(header(res, 'cache-control')).toBe('no-cache');
    expect(header(res, 'x-frame-options')).toBeUndefined();
    expect(header(res, 'content-security-policy')).toBeUndefined();
    expect(header(res, 'access-control-allow-origin')).toBe('*');
  });

  test('anything else under /player/ is refused, not answered by the SPA fallback', async ({ request }) => {
    for (const path of ['/player/', '/player/other.html', '/player/missing']) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(404);
      expect(await res.text(), `${path} must not return the platform page`).not.toContain('<app-root');
    }
  });

  test('the engine bundle and transcoder keep the platform CSP and their cache policy', async ({ request }) => {
    for (const path of ['/assets/WebEngineTS.standalone.js', '/assets/basis/basis_transcoder.wasm']) {
      const res = await request.get(path);
      expect(header(res, 'content-security-policy'), path).toContain(`default-src 'self'`);
      expect(header(res, 'x-content-type-options'), path).toBe('nosniff');
      expect(header(res, 'cache-control'), path).toBeTruthy();
    }
  });

  test('DW-4.2 a top-level visit to /player/player.html is opaque and the player refuses to run', async ({ page }) => {
    const messages: string[] = [];
    page.on('console', m => messages.push(m.text()));

    await page.goto('/player/player.html');

    // The header's `sandbox` made the document opaque although nothing framed it.
    expect(await page.evaluate(() => window.origin)).toBe('null');
    await expect(page.locator('body')).toHaveText('This page only runs inside the scenario viewer.');
    await expect.poll(() => messages.join('\n')).toContain('top-level page');
  });
});
