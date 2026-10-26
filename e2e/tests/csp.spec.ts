// e2e/tests/csp.spec.ts
//
// R6 — the Content Security Policy.
//
// **The acceptance test is that a scenario still renders with the policy on**,
// not that the header exists. A CSP that breaks the import map is worse than no
// CSP: "WebEngineTS" stops resolving and every scenario fails, while the header
// looks perfectly correct in a curl.
//
// Player isolation (phase 5): the platform page runs NO scenario code. Scenarios run in a sandboxed frame
// with its own policy, so this page's `script-src` is `'self'` alone - no `blob:`, no nonce - and
// `index.html` has no import map. (/editor/ keeps both; that is editor-csp.spec.ts.)

import { expect, test } from '@playwright/test';
import { smallestPublishedScenario } from '../helpers/api';
import { waitForFrames } from '../helpers/engine';

/** Directives that must be present, with why each one matters. */
const REQUIRED = [
  [`default-src 'self'`, 'nothing off-origin by default'],
  [`script-src-attr 'none'`, 'no inline event handlers'],
  [`object-src 'none'`, 'no plugins'],
  [`base-uri 'self'`, 'a stray <base> cannot repoint relative URLs'],
  [`frame-ancestors 'self'`, 'not framable by another site'],
  [`form-action 'self'`],
] as const;

/** Collects violations reported by the page while it runs. */
async function watchViolations(page: import('@playwright/test').Page): Promise<string[]> {
  const seen: string[] = [];

  await page.exposeFunction('__cspViolation', (entry: string) => { seen.push(entry); });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', event => {
      (window as any).__cspViolation(
        `${event.effectiveDirective} blocked ${String(event.blockedURI).slice(0, 80)}`
      );
    });
  });

  return seen;
}

test.describe('content security policy', () => {
  test('is served, with the directives that matter', async ({ request }) => {
    const csp = (await request.get('/')).headers()['content-security-policy'];

    expect(csp, 'the CSP header must be served').toBeTruthy();

    for (const [directive] of REQUIRED) {
      expect(csp, `missing directive: ${directive}`).toContain(directive);
    }

    // The page executes no scenario scripts, so neither blob: nor a nonce may be granted.
    const scriptSrc = csp.split(';').map((d: string) => d.trim()).find((d: string) => d.startsWith('script-src '));
    expect(scriptSrc, 'script-src is exactly the page origin').toBe(`script-src 'self'`);
    expect(csp, 'frame-src names the player frame only').toContain(`frame-src 'self'`);

    // Absent on purpose — see nginx/csp.conf. Present would mean someone
    // enabled KTX2 transcoding without revisiting the decision.
    expect(csp, `'unsafe-eval' is deliberately absent`).not.toContain(`'unsafe-eval'`);
  });

  test('DW-5.3 the page has no import map, no nonce and no inline script, response after response', async ({ request }) => {
    for (const path of ['/', '/index.html', '/play/solar-system']) {
      const res = await request.get(path, { headers: { 'cache-control': 'no-cache' } });
      const csp = res.headers()['content-security-policy'];
      const html = await res.text();

      expect(html, `${path} must be the SPA shell`).toContain('<app-root');
      expect(html, `${path}: no import map`).not.toContain('importmap');
      expect(html, `${path}: no nonce attribute`).not.toMatch(/ nonce=/);
      expect(csp, `${path}: no nonce in the CSP`).not.toContain(`'nonce-`);
      expect(csp, `${path}: no blob: in script-src`).not.toMatch(/script-src[^;]*blob:/);
      expect(html.match(/<script(?![^>]* src=)[^>]*>/g) ?? [], `${path}: no inline script`).toEqual([]);
    }
  });

  test('applies to archives and manifests too', async ({ request }) => {
    // add_header does not inherit into a location that sets its own, so every
    // such location has to repeat it. Easy to add a location and forget.
    for (const path of ['/scenarios/', '/a/molecules.json']) {
      const res = await request.get(path);
      expect(res.headers()['content-security-policy'], `no CSP on ${path}`).toBeTruthy();
    }
  });

  test('DW-4.4 every location carries the platform CSP (with frame-src), and /player/ carries the player CSP', async ({ request }) => {
    // The nonce differs per response; everything else must be identical across locations.
    const normalise = (csp: string) => csp.replace(/'nonce-[^']+'/, `'nonce-X'`);
    const platform = normalise((await request.get('/')).headers()['content-security-policy']);

    expect(platform, 'the viewer frames /player/player.html, same host only').toContain(`frame-src 'self'`);
    expect(platform).not.toContain('sandbox');

    for (const path of ['/index.html', '/scenarios/', '/a/molecules.json', '/a/objects/00/missing.js', '/api/health']) {
      const res = await request.get(path);
      expect(normalise(res.headers()['content-security-policy'] ?? ''), `CSP on ${path}`).toBe(platform);
    }

    const player = (await request.get('/player/player.html')).headers()['content-security-policy'];
    expect(player).toContain(`default-src 'none'`);
    expect(player).toContain('sandbox allow-scripts allow-pointer-lock');
    expect(player, 'the player must not inherit the platform policy').not.toContain(`frame-src`);
  });

  test('the catalog renders without violations', async ({ page }) => {
    const violations = await watchViolations(page);

    await page.goto('/');
    await expect(page.locator('.scenario-card').first()).toBeVisible();

    // Cover images are admin-supplied and may be off-origin, which is why
    // img-src allows https: — a violation here would mean the catalog is
    // showing placeholders instead of artwork.
    expect(violations, `catalog CSP violations:\n${violations.join('\n')}`).toEqual([]);
  });

  test('a scenario loads and renders with the policy on', async ({ page }) => {
    test.setTimeout(180_000);

    const violations = await watchViolations(page);
    const { id } = await smallestPublishedScenario();

    await page.goto(`/play/${id}`);
    await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 80_000 });

    // The whole point: not that the header is present, but that the engine still drew a frame - inside the
    // sandboxed player, under the player's own policy - while the page's policy is this strict.
    const snapshot = await waitForFrames(page);
    expect(snapshot.drawCalls, 'the scenario must still render under the CSP').toBeGreaterThan(0);

    expect(violations, `viewer CSP violations:\n${violations.join('\n')}`).toEqual([]);
  });

  test('the admin screen works with the policy on', async ({ page }) => {
    const violations = await watchViolations(page);

    await page.goto('/admin');
    await expect(page.locator('input[type="password"]').or(
      page.getByRole('button', { name: 'Оновити' })
    ).first()).toBeVisible();

    expect(violations, `admin CSP violations:\n${violations.join('\n')}`).toEqual([]);
  });
});
