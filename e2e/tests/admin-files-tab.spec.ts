// e2e/tests/admin-files-tab.spec.ts
//
// test-plan.md scenarios 223-224 (nocturne release 2, phase 6: DW-6.1, DW-6.2, DW-6.4): the Файл and Перевірка tabs
// in the real UI. An author's new archive for a published scenario is a pending version; a moderator accepts it from
// the Файл tab and students get it; the stored test run is read against the norms; and the old admin is gone.
//
// Needs the full stack and the bootstrap ADMIN_TOKEN (it issues and revokes the keys it uses). NOT run when this
// file was written: it needs a stack built from this branch.

import { expect, test } from '@playwright/test';
import {
  ADMIN_TOKEN,
  adminScenarios,
  cleanupE2EScenarios,
  createKey,
  createScenario,
  deleteScenario,
  firstCategorySlug,
  revokeKey,
  saveTestRun,
  uniqueScenarioId,
  updateScenario,
  uploadArchiveBytes,
  versionsOf,
  type IssuedKey,
} from '../helpers/api';
import { signedInWith } from '../helpers/admin-ui';
import { buildScenarioZip } from '../helpers/zip';

test.describe('files and checks tabs', () => {
  let key: IssuedKey;
  let id: string;

  test.beforeAll(async () => {
    await cleanupE2EScenarios();
  });

  /** A published scenario owned by the author's key, with version 1.0.0 current. */
  test.beforeEach(async () => {
    key = await createKey('files');
    id = uniqueScenarioId('files');
    const category = await firstCategorySlug();
    await createScenario({ id, title: 'E2E файли', category, description: 'Опис для публікації' }, key.token);
    await uploadArchiveBytes(id, buildScenarioZip({ id, version: '1.0.0' }), key.token);
    await updateScenario(id, { isPublished: true }); // the bootstrap moderator approves
  });

  test.afterEach(async () => {
    await deleteScenario(id);
    await revokeKey(key.id);
  });

  test('DW-6.1 an author\'s new archive for a published scenario waits as a pending version, with a retract button', async ({ page }) => {
    await signedInWith(page, key.token);
    await page.goto(`/admin/scenarios/${id}/files`);

    await page.locator('[data-role="archive-input"]').setInputFiles({
      name: 'v2.zip', mimeType: 'application/zip', buffer: buildScenarioZip({ id, version: '2.0.0' }),
    });

    const banner = page.locator('[data-role="pending-banner"]');
    await expect(banner).toContainText('Нова версія чекає на розгляд');
    await expect(banner.getByRole('button', { name: 'Відкликати версію' })).toBeVisible();
    await expect(banner.getByRole('button', { name: 'Прийняти' })).toHaveCount(0);
    await expect(page.locator('[data-role="versions"] tbody tr')).toHaveCount(2);

    // Students still get 1.0.0: the current version has not moved.
    const versions = await versionsOf(id, key.token);
    expect(versions.map(v => v.state).sort()).toEqual(['current', 'pending']);

    // The author takes it back.
    page.once('dialog', dialog => void dialog.accept());
    await banner.getByRole('button', { name: 'Відкликати версію' }).click();
    await expect(banner).toHaveCount(0);
    expect((await versionsOf(id, key.token)).map(v => v.state)).toEqual(['current']);
  });

  test('DW-6.4 a moderator accepts the pending version from the Файл tab and it becomes current', async ({ page }) => {
    await uploadArchiveBytes(id, buildScenarioZip({ id, version: '2.0.0' }), key.token);
    const before = await versionsOf(id);
    const pending = before.find(v => v.state === 'pending')!;
    expect(pending.manifestVersion).toBe('2.0.0');

    await signedInWith(page, ADMIN_TOKEN);
    await page.goto(`/admin/scenarios/${id}/files`);

    const banner = page.locator('[data-role="pending-banner"]');
    await expect(banner).toBeVisible();
    // The preview link plays the pending bytes and comes back to this tab.
    const href = await banner.getByRole('link', { name: 'Переглянути у viewer' }).getAttribute('href');
    expect(href).toContain(`draft=${pending.sha256}`);
    expect(decodeURIComponent(href!)).toContain(`returnTo=/admin/scenarios/${id}/files`);

    page.once('dialog', dialog => void dialog.accept());
    await banner.getByRole('button', { name: 'Прийняти' }).click();

    await expect(banner).toHaveCount(0);
    await expect(page.locator('[data-role="versions"] tbody tr[data-state="current"]')).toContainText('2.0.0');
    const after = await versionsOf(id);
    expect(after.find(v => v.id === pending.id)?.state).toBe('current');
    expect((await adminScenarios()).find(r => r.id === id)?.archiveSha256).toBe(pending.sha256);
  });

  /** The scenario back in draft with 1.1.0 current and 1.0.0 archived (a moderator's upload is current). */
  async function withArchivedVersion(): Promise<{ archivedId: number }> {
    await updateScenario(id, { isPublished: false });
    await uploadArchiveBytes(id, buildScenarioZip({ id, version: '1.1.0' }));
    const archived = (await versionsOf(id)).find(v => v.manifestVersion === '1.0.0')!;
    expect(archived.state).toBe('archived');
    return { archivedId: archived.id };
  }

  test('DW-6.1 a moderator restores an archived version', async ({ page }) => {
    const { archivedId } = await withArchivedVersion();
    await signedInWith(page, ADMIN_TOKEN);
    await page.goto(`/admin/scenarios/${id}/files`);

    page.once('dialog', dialog => void dialog.accept());
    await page.getByRole('button', { name: 'Відкотити' }).click();

    await expect(page.locator('[data-role="versions"] tbody tr[data-state="current"]')).toContainText('1.0.0');
    expect((await versionsOf(id)).find(v => v.id === archivedId)?.state).toBe('current');
  });

  test('DW-6.1 an author sees the history without restore or delete', async ({ page }) => {
    await withArchivedVersion();
    await signedInWith(page, key.token);
    await page.goto(`/admin/scenarios/${id}/files`);
    await expect(page.locator('[data-role="versions"] tbody tr')).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Відкотити' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Видалити' })).toHaveCount(0);
  });

  test('DW-6.2 Перевірка shows the stored checks, re-runs them and reads the test run against the norms', async ({ page }) => {
    const current = (await versionsOf(id)).find(v => v.state === 'current')!;
    await saveTestRun(id, current.id, {
      timeToFirstFrameMs: 3800, avgFps: 58, gpuMemoryBytes: 1.4 * 1024 ** 3, consoleErrors: 0, engineBuild: 'e2e', userAgent: 'e2e',
    });

    await signedInWith(page, ADMIN_TOKEN);
    await page.goto(`/admin/scenarios/${id}/checks`);

    await expect(page.locator('.verdict')).toContainText('Архів придатний до запуску');
    const norms = page.locator('[data-role="norms"]');
    await expect(norms.locator('tr[data-key="firstFrame"]')).toContainText('до 5 с');
    await expect(norms.locator('tr[data-key="fps"]')).toContainText('від 30');
    await expect(norms.locator('tr[data-key="gpu"] td.bad')).toContainText('1,4 ГБ');
    await expect(norms.locator('tr[data-key="errors"] td.ok')).toContainText('0');

    await page.getByRole('button', { name: 'Перевірити ще раз' }).click();
    await expect(page.locator('.toast')).toContainText('Перевірку виконано');

    // Phase 7 enabled the test run (decision #51): a moderator gets a live «Запустити тест». The run itself is
    // exercised in admin-moderation.spec.ts.
    await expect(page.getByRole('button', { name: 'Запустити тест' })).toBeEnabled();
  });

  test('DW-6.2 an author reads the results but has no button to run a test', async ({ page }) => {
    await signedInWith(page, key.token);
    await page.goto(`/admin/scenarios/${id}/checks`);
    await expect(page.locator('[data-role="no-run"]')).toContainText('Його виконує модератор');
    await expect(page.getByRole('button', { name: 'Запустити тест' })).toHaveCount(0);
  });
});

test.describe('the old admin is gone', () => {
  test('DW-6.4 /admin/legacy no longer serves the old screen: it lands on the list', async ({ page }) => {
    await signedInWith(page, ADMIN_TOKEN);
    await page.goto('/admin/legacy');
    await expect(page).toHaveURL(/\/admin\/scenarios$/);
    await expect(page.locator('app-admin')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Оновити' })).toHaveCount(0);
    await expect(page.locator('.sidebar').getByRole('link', { name: 'Старий інтерфейс' })).toHaveCount(0);
  });
});
