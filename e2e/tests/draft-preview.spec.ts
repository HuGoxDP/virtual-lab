// e2e/tests/draft-preview.spec.ts
//
// test-plan.md scenario 197 (nocturne release 2, phase 3, DW-3.5): `/play/:id?draft=<sha256>` plays one
// archive version of a scenario that is NOT published (a draft has no public page), for its owner or a
// moderator - the viewer sends the session's bearer - and its exit goes to a validated relative
// `/admin...` `returnTo` (the Файл tab itself arrives in a later phase; only the validated path is checked here).
// Anonymous access to that version is a 404, and a hostile `returnTo` is ignored.
//
// Needs the full stack and the bootstrap ADMIN_TOKEN, like the rest of this suite.

import { expect, test } from '@playwright/test';
import {
  adminScenarios,
  BASE_URL,
  cleanupE2EScenarios,
  createScenario,
  deleteScenario,
  uniqueScenarioId,
  uploadArchive,
} from '../helpers/api';
import { waitForFrames } from '../helpers/engine';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN!;

test.describe('draft preview', () => {
  const id = uniqueScenarioId('draft');
  let sha = '';

  test.beforeAll(async () => {
    await cleanupE2EScenarios();
    // A new row is a draft: it stays out of the public catalog, which is the point of the preview.
    await createScenario({
      id, title: 'E2E draft preview', description: 'e2e', fullDescription: '',
      category: 'test', categoryLabel: 'Test',
    });
    await uploadArchive(id);
    sha = (await adminScenarios()).find(row => row.id === id)!.archiveSha256;
  });

  test.afterAll(async () => {
    await deleteScenario(id);
  });

  /** The session bearer is what the viewer sends; set it before the app boots, as signing in would. */
  async function signedIn(page: import('@playwright/test').Page) {
    await page.addInitScript(token => sessionStorage.setItem('adminToken', token), ADMIN_TOKEN);
  }

  test('DW-3.5 the draft is not public, and its version is a 404 without a credential', async ({ request }) => {
    expect((await request.get(`${BASE_URL}/api/catalog/${id}`)).status()).toBe(404);
    const anonymous = await request.get(`${BASE_URL}/api/catalog/${id}?version=${sha}`);
    expect(anonymous.status()).toBe(404);
    expect(anonymous.headers()['cache-control']).toContain('no-store');
  });

  test('DW-3.5 the owner or moderator plays the draft, and Вийти goes to the validated returnTo', async ({ page }) => {
    test.setTimeout(120_000);
    await signedIn(page);

    await page.goto(`/play/${id}?draft=${sha}&returnTo=${encodeURIComponent('/admin/scenarios?preview=1')}`);
    await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 80_000 });
    const snapshot = await waitForFrames(page);
    expect(snapshot.drawCalls, 'the draft archive renders').toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Вийти' }).click();
    // The exit target is the validated `returnTo`; the path is what is checked.
    await expect(page).toHaveURL(/\/admin\/scenarios\?preview=1$/);
  });

  test('DW-3.5 a returnTo that leaves /admin or the site is ignored: exit goes to the scenario page', async ({ page }) => {
    test.setTimeout(120_000);
    await signedIn(page);

    for (const returnTo of ['https://evil.example/', '//evil.example', '/catalog']) {
      await page.goto(`/play/${id}?draft=${sha}&returnTo=${encodeURIComponent(returnTo)}`);
      await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 80_000 });
      await page.getByRole('button', { name: 'Вийти' }).click();
      await expect(page).toHaveURL(new RegExp(`/scenario/${id}$`));
    }
  });

  test('DW-3.5 without a session the preview is an error screen, not a played scenario', async ({ page }) => {
    await page.goto(`/play/${id}?draft=${sha}`);
    await expect(page.getByText('Сценарій не знайдено.')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.viewer-controls')).toHaveCount(0);
  });

  test('DW-3.5 a malformed ?draft= is refused before any request', async ({ page }) => {
    await signedIn(page);
    await page.goto(`/play/${id}?draft=not-a-hash`);
    await expect(page.getByText('Посилання на чернетку некоректне.')).toBeVisible({ timeout: 30_000 });
  });
});
