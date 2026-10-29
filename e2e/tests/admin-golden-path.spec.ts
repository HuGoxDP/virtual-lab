// e2e/tests/admin-golden-path.spec.ts
//
// test-plan.md §4.11 #98 and §7 (F12), and #136 (release 1, phase 3: DW-3.8, DW-3.10): the whole
// publishing round trip driven through the UI - sign in, create, upload, publish, it appears for students and
// plays.
//
// Release 2, phase 6 (DW-6.4): the old admin this spec used to drive is deleted. The round trip now runs on the new
// screens as the bootstrap moderator: the row is created through the API (the wizard, which creates rows from an
// archive's own manifest, has its own spec: admin-upload-wizard.spec.ts #222), the archive goes in through the
// Файл tab with a real file chooser, and the scenario is published from Публікація. "Delete" has no per-row button
// any more (it is a bulk action of the list), so the test ends with the API teardown.
//
// Every endpoint behind these screens is covered by the backend suite. The screens themselves were not.

import { expect, test } from '@playwright/test';
import {
  ADMIN_TOKEN,
  BASE_URL,
  cleanupE2EScenarios,
  createScenario,
  deleteScenario,
  SMALL_ARCHIVE,
  uniqueScenarioId,
} from '../helpers/api';
import { signInThroughForm } from '../helpers/admin-ui';
import { waitForFrames } from '../helpers/engine';

test.describe('admin golden path', () => {
  test.beforeAll(async () => {
    const removed = await cleanupE2EScenarios();
    if (removed > 0) console.log(`cleaned up ${removed} leftover e2e scenario(s)`);
  });

  test('create, upload, publish, play', async ({ page }) => {
    const id = uniqueScenarioId('golden');
    const title = 'E2E перевірка публікації';

    try {
      await createScenario({
        id, title, category: 'test', categoryLabel: 'Test',
        description: 'Створено автотестом.', fullDescription: 'Рядок каталогу, створений e2e-тестом.',
        features: [{ icon: 'atom', title: 'Е2Е-пункт', subtitle: 'Додано з форми' }],
      });

      await signInThroughForm(page, ADMIN_TOKEN);
      await page.goto(`/admin/scenarios/${id}/files`);

      // ── upload an archive through the Файл tab ────
      await page.locator('[data-role="archive-input"]').setInputFiles(SMALL_ARCHIVE);
      await expect(page.locator('[data-role="current-archive"]')).toBeVisible({ timeout: 60_000 });
      await expect(page.locator('[data-role="versions"] tbody tr')).toHaveCount(1);

      // ── publish ───────────────────────────────────
      const publicUrl = `${BASE_URL}/api/catalog/${encodeURIComponent(id)}`;
      expect((await fetch(publicUrl)).status, 'a draft is not in the public catalog').toBe(404);

      await page.getByRole('link', { name: 'Публікація' }).click();
      await page.getByRole('button', { name: 'Опублікувати' }).click();
      await expect(page.locator('.edit-head vl-status-pill')).toContainText('Опубліковано');

      await expect
        .poll(async () => (await fetch(publicUrl)).status,
          { message: 'the scenario should be reachable in the public catalog' })
        .toBe(200);

      // The entry reaches the student's scenario page.
      await page.goto(`/scenario/${id}`);
      await expect(page.locator('.feature')).toHaveCount(1);
      await expect(page.locator('.feature')).toContainText('Е2Е-пункт');
      await expect(page.locator('.feature')).toContainText('Додано з форми');

      // ── it plays ──────────────────────────────────
      await page.goto(`/play/${id}`);
      await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 80_000 });

      const snapshot = await waitForFrames(page);
      expect(snapshot.drawCalls, 'the uploaded scenario should render').toBeGreaterThan(0);
    } finally {
      await deleteScenario(id);
    }

    await expect
      .poll(async () => (await fetch(`${BASE_URL}/api/catalog/${encodeURIComponent(id)}`)).status,
        { message: 'a deleted scenario must leave the public catalog' })
      .toBe(404);
  });

  test('DW-3.8 up to six "Що всередині" entries; a seventh is blocked', async ({ page }) => {
    const id = uniqueScenarioId('feat');
    try {
      await createScenario({ id, title: 'Пункти', category: 'test', categoryLabel: 'Test' });
      await signInThroughForm(page, ADMIN_TOKEN);
      await page.goto(`/admin/scenarios/${id}/meta`);

      const add = page.getByRole('button', { name: 'Додати пункт' });
      for (let i = 0; i < 6; i++) await add.click();

      await expect(page.locator('.feature-row')).toHaveCount(6);
      await expect(add).toBeDisabled();
    } finally {
      await deleteScenario(id);
    }
  });

  test('the token never reaches localStorage or the URL', async ({ page }) => {
    await signInThroughForm(page, ADMIN_TOKEN);

    const leaked = await page.evaluate(() => ({
      local: Object.entries(localStorage).map(([k, v]) => `${k}=${v}`).join('|'),
      session: Object.keys(sessionStorage).join(','),
      url: location.href,
    }));

    // sessionStorage is where it is supposed to live - it dies with the tab.
    expect(leaked.local, 'the admin token must not be in localStorage').not.toContain(ADMIN_TOKEN);
    expect(leaked.url, 'the admin token must not be in the URL').not.toContain(ADMIN_TOKEN);
    expect(leaked.session.length, 'the token should be held in sessionStorage').toBeGreaterThan(0);
  });

  test('unpublished scenarios are visible to admin and nobody else', async ({ page }) => {
    await signInThroughForm(page, ADMIN_TOKEN);
    await page.goto('/admin/scenarios');

    // Bench scenes are unpublished by policy - the admin list must still show
    // them, and the public catalog must not.
    const benchRow = page.locator('tr.row', { hasText: 'benchscene3-solarsystem' });
    await expect(benchRow).toBeVisible();

    expect((await fetch(`${BASE_URL}/api/catalog/benchscene3-solarsystem`)).status).toBe(404);
  });
});
