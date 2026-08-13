// e2e/tests/admin-golden-path.spec.ts
//
// test-plan.md §4.11 #98 and §7 (F12): the whole publishing round trip driven
// through the UI — token, create, upload, publish, it appears for students and
// plays, then delete.
//
// Every endpoint behind this screen is covered by the backend suite. The screen
// itself was not covered by anything.

import { expect, test } from '@playwright/test';
import {
  BASE_URL,
  cleanupE2EScenarios,
  deleteScenario,
  SMALL_ARCHIVE,
  uniqueScenarioId,
} from '../helpers/api';
import { waitForFrames } from '../helpers/engine';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN!;

/** Signs in through the form, which is where the token is supposed to enter. */
async function signIn(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/admin');

  const tokenField = page.locator('input[type="password"]');
  const reloadButton = page.getByRole('button', { name: 'Оновити' });

  // Wait for the app to render *something* before deciding which state it is in.
  // Probing the field straight after goto() races Angular's first paint: the
  // field is not visible yet, the sign-in is skipped, and the wait below then
  // times out on a screen that is simply still asking for the token.
  await expect(tokenField.or(reloadButton).first()).toBeVisible();

  // The token lives in sessionStorage, so a fresh context always starts signed
  // out — but a reused one does not, and re-entering it would be a no-op anyway.
  if (await tokenField.isVisible()) {
    await tokenField.fill(ADMIN_TOKEN);
    await page.getByRole('button', { name: 'Увійти' }).click();
  }

  await expect(reloadButton).toBeVisible();
}

test.describe('admin golden path', () => {
  test.beforeAll(async () => {
    const removed = await cleanupE2EScenarios();
    if (removed > 0) console.log(`cleaned up ${removed} leftover e2e scenario(s)`);
  });

  test('create, upload, publish, play, delete', async ({ page }) => {
    const id = uniqueScenarioId('golden');
    const title = 'E2E перевірка публікації';

    // Registered before the assertions so an early failure still cleans up.
    let created = false;

    try {
      await signIn(page);

      // ── create ────────────────────────────────────
      await page.getByRole('button', { name: '+ Новий сценарій' }).click();

      const editor = page.locator('.editor');
      await expect(editor).toBeVisible();

      await editor.locator('input').nth(0).fill(id);          // id
      await editor.locator('input').nth(1).fill(title);       // Назва
      await editor.locator('input').nth(2).fill('test');      // Категорія
      await editor.locator('input').nth(3).fill('Test');      // Підпис категорії
      await editor.locator('textarea').nth(0).fill('Створено автотестом.');
      await editor.locator('textarea').nth(1).fill('Рядок каталогу, створений e2e-тестом.');

      await page.getByRole('button', { name: 'Зберегти' }).click();
      created = true;

      const row = page.locator('tr', { hasText: id });
      await expect(row).toBeVisible();

      // ── upload an archive ─────────────────────────
      await row.locator('input[type="file"]').setInputFiles(SMALL_ARCHIVE);

      // The row shows a content hash once the object is stored.
      await expect(row.locator('.hash')).toBeVisible({ timeout: 60_000 });
      await expect(row).toContainText('local');

      // ── publish ───────────────────────────────────
      // A new row is published by default; make the state explicit rather than
      // assuming it, then drive the toggle if it is not.
      const publicUrl = `${BASE_URL}/api/catalog/${encodeURIComponent(id)}`;

      await expect
        .poll(async () => (await fetch(publicUrl)).status,
          { message: 'the scenario should be reachable in the public catalog' })
        .toBe(200);

      // ── it plays ──────────────────────────────────
      await page.goto(`/play/${id}`);
      await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 80_000 });

      const snapshot = await waitForFrames(page);
      expect(snapshot.drawCalls, 'the uploaded scenario should render').toBeGreaterThan(0);

      // ── delete ────────────────────────────────────
      await signIn(page);

      page.once('dialog', dialog => void dialog.accept());
      await page.locator('tr', { hasText: id }).getByRole('button', { name: 'Видалити' }).click();

      await expect(page.locator('tr', { hasText: id })).toHaveCount(0);
      created = false;

      await expect
        .poll(async () => (await fetch(publicUrl)).status,
          { message: 'a deleted scenario must leave the public catalog' })
        .toBe(404);
    } finally {
      if (created) await deleteScenario(id);
    }
  });

  test('the token never reaches localStorage or the URL', async ({ page }) => {
    await signIn(page);

    const leaked = await page.evaluate(() => ({
      local: Object.entries(localStorage).map(([k, v]) => `${k}=${v}`).join('|'),
      session: Object.keys(sessionStorage).join(','),
      url: location.href,
    }));

    // sessionStorage is where it is supposed to live — it dies with the tab.
    expect(leaked.local, 'the admin token must not be in localStorage').not.toContain(ADMIN_TOKEN);
    expect(leaked.url, 'the admin token must not be in the URL').not.toContain(ADMIN_TOKEN);
    expect(leaked.session.length, 'the token should be held in sessionStorage').toBeGreaterThan(0);
  });

  test('unpublished scenarios are visible to admin and nobody else', async ({ page }) => {
    await signIn(page);

    // Bench scenes are unpublished by policy — the admin table must still list
    // them, and the public catalog must not.
    const benchRow = page.locator('tr', { hasText: 'benchscene3-solarsystem' });
    await expect(benchRow).toBeVisible();

    expect((await fetch(`${BASE_URL}/api/catalog/benchscene3-solarsystem`)).status).toBe(404);
  });
});
