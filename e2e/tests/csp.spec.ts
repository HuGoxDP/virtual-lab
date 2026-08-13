// e2e/tests/csp.spec.ts
//
// R6 — the Content Security Policy.
//
// **The acceptance test is that a scenario still renders with the policy on**,
// not that the header exists. A CSP that breaks the import map is worse than no
// CSP: "WebEngineTS" stops resolving and every scenario fails, while the header
// looks perfectly correct in a curl.
//
// Every directive was measured against the running app rather than guessed —
// notably `script-src blob:`, without which no scenario runs at all, because the
// engine executes a scenario's scripts from blob URLs.

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

    // Without blob: the engine cannot execute a scenario's scripts at all.
    expect(csp, 'script-src must allow blob:').toMatch(/script-src[^;]*\bblob:/);

    // Absent on purpose — see nginx/csp.conf. Present would mean someone
    // enabled KTX2 transcoding without revisiting the decision.
    expect(csp, `'unsafe-eval' is deliberately absent`).not.toContain(`'unsafe-eval'`);
  });

  test('the import map is allowed by a nonce that changes per response', async ({ request }) => {
    // The engine is resolved through an inline import map, which 'self' alone
    // would block. It has to be a nonce rather than a hash: Chromium matches
    // import maps by nonce only. If these ever stop agreeing, "WebEngineTS"
    // stops resolving and every scenario fails — while the header still looks
    // correct in a curl, which is why this is asserted rather than eyeballed.
    const nonces = new Set<string>();

    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await request.get('/', { headers: { 'cache-control': 'no-cache' } });
      const csp = res.headers()['content-security-policy'];
      const html = await res.text();

      const fromHeader = csp.match(/'nonce-([A-Za-z0-9+/=_-]+)'/)?.[1];
      const fromTag = html.match(/<script type="importmap" nonce="([A-Za-z0-9+/=_-]+)"/)?.[1];

      expect(fromHeader, 'the CSP should carry a nonce for the import map').toBeTruthy();
      expect(fromTag, 'nginx should stamp that nonce onto the import map tag').toBeTruthy();
      expect(fromTag, 'the tag and the header must agree within one response').toBe(fromHeader);

      nonces.add(fromHeader!);
    }

    // A fixed nonce is no better than 'unsafe-inline'.
    expect(nonces.size, 'the nonce must differ between responses').toBe(2);
  });

  test('applies to archives and manifests too', async ({ request }) => {
    // add_header does not inherit into a location that sets its own, so every
    // such location has to repeat it. Easy to add a location and forget.
    for (const path of ['/scenarios/', '/a/molecules.json']) {
      const res = await request.get(path);
      expect(res.headers()['content-security-policy'], `no CSP on ${path}`).toBeTruthy();
    }
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

    // The whole point: not that the header is present, but that the engine
    // still resolved through the import map and drew a frame under it.
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
