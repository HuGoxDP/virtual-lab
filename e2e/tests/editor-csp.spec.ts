// e2e/tests/editor-csp.spec.ts
//
// Player isolation, phase 5 (DW-5.6; test-plan 175). The platform page lost its import map and the
// server-level `sub_filter` that stamped the CSP nonce on it. The editor (/editor/) still has an inline
// import map, so the filter moved into `location ^~ /editor/` in nginx/editor.conf. This asserts that,
// on the stack started WITH docker-compose.editor.yml:
//
//   - /editor/ carries csp-editor.conf's policy (a nonce, blob:, the font hosts),
//   - its import map carries `nonce="<the same value as in the header>"`, different on every response,
//   - and the platform root next to it has neither a nonce nor an import map.
//
// Skips when the running stack does not serve `/editor/` (the normal :8045 stack). Run it against the
// reproducible harness - one command to start, one to test, one to stop - see e2e/README.md:
//   docker compose -p vl-editor-csp -f e2e/editor-csp-harness/docker-compose.yml up --build -d
//   cd e2e && ADMIN_TOKEN=x E2E_BASE_URL=http://localhost:8046 npx playwright test editor-csp
//   docker compose -p vl-editor-csp -f e2e/editor-csp-harness/docker-compose.yml down --remove-orphans --rmi local

import { expect, test } from '@playwright/test';

test.describe('editor keeps its import-map nonce (DW-5.6)', () => {
  test.beforeAll(async ({ request }) => {
    const res = await request.get('/editor/', { maxRedirects: 0 });
    const html = res.status() === 200 ? await res.text() : '';
    test.skip(!html.includes('importmap'), 'The stack was started without docker-compose.editor.yml; /editor/ is not served.');
  });

  test('DW-5.6 /editor/ import map nonce equals the CSP nonce and changes per response', async ({ request }) => {
    const nonces = new Set<string>();
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await request.get('/editor/', { headers: { 'cache-control': 'no-cache' } });
      const csp = res.headers()['content-security-policy'];
      const html = await res.text();

      const fromHeader = csp.match(/'nonce-([A-Za-z0-9+/=_-]+)'/)?.[1];
      const fromTag = html.match(/<script type="importmap" nonce="([A-Za-z0-9+/=_-]+)"/)?.[1];
      expect(fromHeader, 'csp-editor.conf grants a nonce').toBeTruthy();
      expect(fromTag, 'the import map is stamped').toBeTruthy();
      expect(fromTag).toBe(fromHeader);
      expect(csp, 'csp-editor.conf, not csp.conf').toContain('fonts.googleapis.com');
      expect(csp).toMatch(/script-src[^;]*blob:/);
      nonces.add(fromHeader!);
    }
    expect(nonces.size).toBe(2);
  });

  test('DW-5.6 the platform root beside it has no nonce and no import map', async ({ request }) => {
    const res = await request.get('/');
    expect(res.headers()['content-security-policy']).not.toContain(`'nonce-`);
    expect(await res.text()).not.toContain('importmap');
  });
});
