// e2e/tests/nocturne-foundation.spec.ts
//
// Covers test-plan scenario 114 (DW-2.2). Scenario 119 (DW-2.6, the old admin's computed look) retired with the old
// admin in release 2, phase 6.
//
// Nocturne foundation (release 1, phase 2): the design system reached the page
// without disturbing what it must not touch.
//
//   DW-2.2  Inter is self-hosted: served from /assets/fonts/, no off-origin request.
//   (DW-2.6, the old admin kept its look under the legacy scope, retired with the old admin: release 2, phase 6.
//    The viewer half was retired in release 1, phase 4.)

import { expect, test } from '@playwright/test';
import { BASE_URL } from '../helpers/api';

test.describe('Nocturne foundation', () => {
  test('DW-2.2 Inter is served from /assets/fonts/ and nothing off-origin is fetched', async ({ page }) => {
    const fontResponses: string[] = [];
    const foreign: string[] = [];
    page.on('response', res => {
      const url = new URL(res.url());
      if (url.origin !== new URL(BASE_URL).origin) foreign.push(res.url());
      if (/\.woff2?$/.test(url.pathname)) fontResponses.push(`${res.status()} ${url.pathname}`);
    });

    await page.goto('/catalog');
    // Cyrillic forces the cyrillic subset; 500 is the heading weight.
    await page.evaluate(async () => {
      await document.fonts.load('400 16px Inter', 'Віртуальна лабораторія');
      await document.fonts.load('500 16px Inter', 'Віртуальна лабораторія');
    });

    expect(await page.evaluate(() => document.fonts.check('16px Inter'))).toBe(true);
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain('Inter');
    expect(fontResponses.length).toBeGreaterThan(0);
    for (const entry of fontResponses) expect(entry).toMatch(/^200 \/assets\/fonts\/inter-[a-z-]+-\d+\.woff2$/);
    expect(foreign).toEqual([]);
  });
});
