// e2e/tests/admin-upload-wizard.spec.ts
//
// test-plan.md scenario 222 (nocturne release 2, phase 6: DW-6.3, DW-6.4): the upload wizard driven through the
// real UI with a personal key - ZIP -> draft with the manifest's fields -> Метадані -> Перевірка -> submit - and
// what the unit suite cannot see: the real file chooser, a real aborted request, a hostile manifest name in the
// real DOM, and that the draft survives leaving the wizard.
//
// Needs the full stack and the bootstrap ADMIN_TOKEN (it issues and revokes the keys it uses). NOT run when this
// file was written: it needs a stack built from this branch.

import { expect, test, type Page } from '@playwright/test';
import {
  adminScenarios,
  cleanupE2EScenarios,
  createKey,
  deleteScenario,
  revokeKey,
  uniqueScenarioId,
  type IssuedKey,
} from '../helpers/api';
import { signInThroughForm } from '../helpers/admin-ui';
import { buildScenarioZip } from '../helpers/zip';

const row = async (id: string, code: string) => (await adminScenarios(code)).find(r => r.id === id);

async function chooseArchive(page: Page, id: string, options: { name?: string; version?: string } = {}): Promise<void> {
  await page.locator('[data-role="archive-input"]').setInputFiles({
    name: `${id}.zip`,
    mimeType: 'application/zip',
    buffer: buildScenarioZip({ id, ...options }),
  });
}

test.describe('upload wizard', () => {
  let key: IssuedKey;
  let id: string;

  test.beforeAll(async () => {
    await cleanupE2EScenarios();
  });

  test.beforeEach(async ({ page }) => {
    key = await createKey('wizard');
    id = uniqueScenarioId('wiz');
    await signInThroughForm(page, key.token);
    await page.locator('.sidebar').getByRole('link', { name: 'Завантажити' }).click();
    await expect(page).toHaveURL(/\/admin\/upload$/);
  });

  test.afterEach(async () => {
    await deleteScenario(id);
    await revokeKey(key.id);
  });

  test('DW-6.3 ZIP -> draft with the manifest prefilled -> edit -> checks -> submit for review', async ({ page }) => {
    await chooseArchive(page, id, { name: 'E2E майстер', version: '0.9.0' });

    // Step 1: the draft exists on the server and the manifest's facts are shown.
    await expect(page.locator('[data-role="uploaded"]')).toContainText(id);
    await expect(page.locator('[data-role="manifest"]')).toContainText('E2E майстер');
    await expect(page.locator('[data-role="manifest"]')).toContainText('Scenario.js');
    expect((await row(id, key.token))?.status).toBe('draft');

    // Step 2: the form is the editor's, prefilled from the manifest; saving writes the change.
    await page.getByRole('button', { name: 'Метадані', exact: true }).click();
    await expect(page.locator('#meta-title')).toHaveValue('E2E майстер');
    await expect(page.locator('#meta-version')).toHaveValue('0.9.0');
    await page.locator('#meta-description').fill('Опис, написаний у майстрі');
    await page.getByRole('button', { name: 'Зберегти' }).click();
    await expect(page.locator('.toast')).toContainText('Зміни збережено');
    expect((await row(id, key.token))?.description).toBe('Опис, написаний у майстрі');

    // Step 3: the checks stored with the archive.
    await page.getByRole('button', { name: 'Перевірка', exact: true }).click();
    await expect(page.locator('.verdict')).toContainText('Архів придатний до запуску');

    // Step 4: submit; the scenario opens on its Публікація tab, in review.
    await page.getByRole('button', { name: 'Публікація', exact: true }).click();
    await page.getByRole('button', { name: 'Надіслати на модерацію' }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/scenarios/${id}/publish$`));
    await expect(page.locator('.edit-head vl-status-pill')).toContainText('На перевірці');
    expect((await row(id, key.token))?.status).toBe('review');
  });

  test('DW-6.3 leaving after step 1 keeps the draft, and the list shows it', async ({ page }) => {
    await chooseArchive(page, id);
    await expect(page.locator('[data-role="uploaded"]')).toBeVisible();

    await page.locator('.sidebar').getByRole('link', { name: 'Мої сценарії' }).click();
    await expect(page).toHaveURL(/\/admin\/scenarios$/);
    const listRow = page.locator('tr.row', { hasText: id });
    await expect(listRow).toBeVisible();
    await expect(listRow.locator('vl-status-pill')).toContainText('Чернетка');
    expect((await row(id, key.token))?.status).toBe('draft');
  });

  test('DW-6.3 cancelling during the upload aborts it and leaves no scenario behind', async ({ page }) => {
    // Hold the request open so there is something to cancel; the browser aborts it with the page's request.
    await page.route('**/api/scenarios/from-archive', () => { /* never answered */ });
    await chooseArchive(page, id);
    await expect(page.locator('.progress-card')).toBeVisible();

    await page.getByRole('button', { name: 'Скасувати' }).click();
    await expect(page.locator('.banner-warn')).toContainText('скасовано');
    await expect(page.locator('[data-role="uploaded"]')).toHaveCount(0);

    expect(await row(id, key.token), 'a cancelled upload must not leave a draft').toBeUndefined();
  });

  test('DW-6.3 a second archive with the same manifest id is refused with the server\'s words', async ({ page }) => {
    await chooseArchive(page, id);
    await expect(page.locator('[data-role="uploaded"]')).toBeVisible();

    await page.goto('/admin/upload');
    await chooseArchive(page, id);
    await expect(page.locator('.banner-error')).toContainText('вже існує');
  });

  test('DW-6.3 a manifest name with markup is shown as text and runs nothing', async ({ page }) => {
    const hostile = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
    await chooseArchive(page, id, { name: hostile });

    await expect(page.locator('[data-role="manifest"]')).toContainText(hostile);
    await expect(page.locator('h1')).toHaveText(hostile);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
  });

  test('DW-6.3 a file that is not a ZIP is refused before anything is sent', async ({ page }) => {
    let sent = false;
    page.on('request', req => { if (req.url().includes('/api/scenarios/from-archive')) sent = true; });
    await page.locator('[data-role="archive-input"]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
    await expect(page.locator('.banner-error')).toContainText('.zip');
    expect(sent).toBe(false);
  });
});
