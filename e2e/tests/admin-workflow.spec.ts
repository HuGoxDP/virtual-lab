// e2e/tests/admin-workflow.spec.ts
//
// test-plan.md scenarios 214-216 (nocturne release 2, phase 5: DW-5.1, DW-5.5): the new admin driven through its
// UI with personal keys - sign in, edit, submit - plus what the unit suite cannot see: the real viewport at 390 px,
// a 300-character title in the real layout, a key revoked under a running session, and the browser's own dialogs.
//
//   214  sign-in by code, name and role, sign-out, `/admin/legacy` for moderators only
//   215  author: sign in -> edit Метадані -> submit for review (archive seeded through the key-parameterised helper)
//   216  unsaved edits survive a tab switch and ask before leaving; a revoked key returns to sign-in with the reason;
//        390 px drawer; a 300-character unbroken title keeps the layout
//
// Needs the full stack and the bootstrap ADMIN_TOKEN (it issues and revokes the keys it uses), like the rest of the suite.

import { expect, test, type Page } from '@playwright/test';
import {
  ADMIN_TOKEN,
  adminScenarios,
  cleanupE2EScenarios,
  createKey,
  createScenario,
  deleteScenario,
  firstCategorySlug,
  revokeKey,
  SMALL_ARCHIVE,
  uniqueScenarioId,
  uploadArchive,
  type IssuedKey,
} from '../helpers/api';
import { openSection, signedInWith, signInThroughForm } from '../helpers/admin-ui';

const row = async (id: string, code: string) => (await adminScenarios(code)).find(r => r.id === id);

/** No horizontal scrolling of the page itself: a long word must wrap inside its cell, not widen the layout. */
const pageOverflows = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

test.describe('admin workflow', () => {
  test.beforeAll(async () => {
    await cleanupE2EScenarios();
  });

  test.describe('sign-in and roles (#214)', () => {
    test('DW-5.1 a moderator code shows name and role, and sign-out clears the session', async ({ page }) => {
      await signInThroughForm(page, ADMIN_TOKEN);

      await expect(page.locator('.user-name')).toHaveText('bootstrap');
      await expect(page.locator('.user-role')).toHaveText('Модератор');
      await expect(page.locator('.sidebar').getByRole('link', { name: 'Черга модерації' })).toBeVisible();

      const stored = await page.evaluate(() => ({
        session: sessionStorage.getItem('adminToken'),
        local: JSON.stringify({ ...localStorage }),
        url: location.href,
      }));
      expect(stored.session).toBe(ADMIN_TOKEN);
      expect(stored.local, 'the code must never reach localStorage').not.toContain(ADMIN_TOKEN);
      expect(stored.url, 'the code must never reach the URL').not.toContain(ADMIN_TOKEN);

      await page.getByRole('button', { name: 'Вийти' }).click();
      await expect(page).toHaveURL(/\/admin\/login$/);
      expect(await page.evaluate(() => sessionStorage.getItem('adminToken'))).toBeNull();

      await page.goto('/admin');
      await expect(page).toHaveURL(/\/admin\/login$/);
    });

    test('DW-5.1 an author sees the author menu; /admin/legacy sends them back to their list', async ({ page }) => {
      const key = await createKey('author');
      try {
        await signInThroughForm(page, key.token);
        await expect(page.locator('.user-name')).toHaveText(key.label);
        await expect(page.locator('.user-role')).toHaveText('Автор');
        await expect(page.locator('.sidebar').getByRole('link', { name: 'Черга модерації' })).toHaveCount(0);

        await page.goto('/admin/legacy');
        await expect(page).toHaveURL(/\/admin\/scenarios$/);
        await expect(page.getByRole('button', { name: 'Оновити' })).toHaveCount(0);
      } finally {
        await revokeKey(key.id);
      }
    });

    test('DW-5.1 a moderator reaches the old admin at /admin/legacy', async ({ page }) => {
      await signedInWith(page, ADMIN_TOKEN);
      await page.goto('/admin/legacy');
      await expect(page.getByRole('button', { name: 'Оновити' })).toBeVisible();
    });

    test('DW-5.1 a revoked code is refused with a message and nothing is stored', async ({ page }) => {
      const key = await createKey('revoked');
      await revokeKey(key.id);

      await page.goto('/admin/login');
      await page.locator('#access-code').fill(key.token);
      await page.getByRole('button', { name: 'Увійти' }).click();

      await expect(page.locator('.plaque')).toContainText('Невірний або відкликаний');
      await expect(page).toHaveURL(/\/admin\/login$/);
      expect(await page.evaluate(() => sessionStorage.getItem('adminToken'))).toBeNull();
    });

    test('DW-5.1 empty input says so', async ({ page }) => {
      await page.goto('/admin/login');
      await page.getByRole('button', { name: 'Увійти' }).click();
      await expect(page.locator('.plaque')).toContainText('Введіть код');
    });
  });

  test.describe('an author at work (#215, #216)', () => {
    let key: IssuedKey;
    let id: string;

    test.beforeEach(async () => {
      key = await createKey('author');
      id = uniqueScenarioId('wf');
      const category = await firstCategorySlug();
      await createScenario({ id, title: 'E2E робочий процес', category, description: 'Старий опис' }, key.token);
      await uploadArchive(id, SMALL_ARCHIVE, key.token);
    });

    test.afterEach(async () => {
      await deleteScenario(id);
      await revokeKey(key.id);
    });

    test('DW-5.5 sign in -> edit -> submit for review', async ({ page }) => {
      await signInThroughForm(page, key.token);

      const listRow = page.locator('tr.row', { hasText: id });
      await expect(listRow).toBeVisible();
      await expect(listRow.locator('vl-status-pill')).toContainText('Чернетка');
      await listRow.getByRole('link', { name: 'E2E робочий процес' }).click();

      // Метадані: the live card follows the typing, Save writes only the changes.
      await page.locator('#meta-title').fill('E2E нова назва');
      await page.locator('#meta-description').fill('Новий короткий опис');
      await expect(page.locator('.live-card .title')).toHaveText('E2E нова назва');
      await expect(page.locator('.counter')).toContainText('19 / 160');
      await page.getByRole('button', { name: 'Зберегти' }).click();
      await expect(page.locator('.toast')).toContainText('Зміни збережено');
      await expect(page.locator('.edit-head h1')).toHaveText('E2E нова назва');

      const saved = await row(id, key.token);
      expect(saved?.title).toBe('E2E нова назва');
      expect(saved?.description).toBe('Новий короткий опис');

      // Публікація: submit, and the history says so.
      await page.getByRole('link', { name: 'Публікація' }).click();
      await page.getByRole('button', { name: 'Подати на перевірку' }).click();
      await expect(page.locator('.edit-head vl-status-pill')).toContainText('На перевірці');
      await expect(page.locator('.history')).toContainText('Надіслано на модерацію');
      expect((await row(id, key.token))?.status).toBe('review');

      // In review, an author's only move is to take it back.
      await expect(page.getByRole('button', { name: 'Відкликати з перевірки' })).toBeVisible();
    });

    test('DW-5.5 unsaved edits survive a tab switch and ask before leaving', async ({ page }) => {
      await signedInWith(page, key.token);
      await page.goto(`/admin/scenarios/${id}/meta`);

      await page.locator('#meta-title').fill('Назва, якої ще немає на сервері');
      await page.getByRole('link', { name: 'Публікація' }).click();
      await expect(page.locator('vl-scenario-publish')).toBeVisible();
      await page.getByRole('link', { name: 'Метадані' }).click();
      await expect(page.locator('#meta-title')).toHaveValue('Назва, якої ще немає на сервері');

      // Declining the prompt keeps the page and the edit.
      page.once('dialog', dialog => void dialog.dismiss());
      await openSection(page, 'Завантажити');
      await expect(page).toHaveURL(new RegExp(`/admin/scenarios/${id}/meta$`));
      await expect(page.locator('#meta-title')).toHaveValue('Назва, якої ще немає на сервері');

      // Accepting leaves.
      page.once('dialog', dialog => void dialog.accept());
      await openSection(page, 'Завантажити');
      await expect(page).toHaveURL(/\/admin\/upload$/);
    });

    test('DW-5.5 a key revoked under a running session returns to sign-in with the reason', async ({ page }) => {
      await signInThroughForm(page, key.token);
      await openSection(page, 'Завантажити');
      await expect(page).toHaveURL(/\/admin\/upload$/);

      await revokeKey(key.id);
      await openSection(page, 'Мої сценарії'); // the list asks the API, which no longer knows the code

      await expect(page).toHaveURL(/\/admin\/login$/);
      await expect(page.locator('.plaque')).toContainText('недійсний або відкликаний');
      expect(await page.evaluate(() => sessionStorage.getItem('adminToken'))).toBeNull();
    });

    test('DW-5.5 a reload with a revoked code also lands on sign-in with the reason', async ({ page }) => {
      await signInThroughForm(page, key.token);
      await revokeKey(key.id);
      await page.reload();
      await expect(page).toHaveURL(/\/admin\/login$/);
      await expect(page.locator('.plaque')).toContainText('недійсний або відкликаний');
    });
  });

  test.describe('at 390 px (#216)', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('DW-5.5 the sidebar is a drawer behind the burger', async ({ page }) => {
      await signedInWith(page, ADMIN_TOKEN);
      await page.goto('/admin/scenarios');

      const burger = page.getByRole('button', { name: 'Меню' });
      await expect(burger).toBeVisible();
      await expect(page.locator('.sidebar')).toBeHidden();
      expect(await pageOverflows(page), 'the list must not widen the page').toBe(false);

      await burger.click();
      await expect(page.locator('.sidebar')).toBeVisible();
      await expect(burger).toHaveAttribute('aria-expanded', 'true');

      await page.locator('.sidebar').getByRole('link', { name: 'Завантажити' }).click();
      await expect(page).toHaveURL(/\/admin\/upload$/);
      await expect(page.locator('.sidebar')).toBeHidden();

      await burger.click();
      await page.keyboard.press('Escape');
      await expect(page.locator('.sidebar')).toBeHidden();
    });

    test('DW-5.5 a 300-character unbroken title keeps the layout in the list and the editor', async ({ page }) => {
      const id = uniqueScenarioId('long');
      const title = 'Ж'.repeat(300);
      try {
        await createScenario({ id, title, category: 'test', categoryLabel: 'Test', author: 'Я'.repeat(300) });
        await signedInWith(page, ADMIN_TOKEN);

        await page.goto('/admin/scenarios');
        await expect(page.locator('tr.row', { hasText: id })).toBeVisible();
        expect(await pageOverflows(page), 'the list must not widen the page').toBe(false);

        await page.goto(`/admin/scenarios/${id}/meta`);
        await expect(page.locator('.live-card .title')).toBeVisible();
        await expect(page.locator('.edit-head h1')).toHaveText(title);
        expect(await pageOverflows(page), 'the editor must not widen the page').toBe(false);
      } finally {
        await deleteScenario(id);
      }
    });
  });
});
