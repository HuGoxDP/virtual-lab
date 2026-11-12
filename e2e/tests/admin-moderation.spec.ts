// e2e/tests/admin-moderation.spec.ts
//
// test-plan.md scenario 231 (nocturne release 2, phase 7: DW-7.1 .. DW-7.4, DW-7.6): the whole path through the
// real UI with two browser contexts - a moderator issues an author's code on «Доступ» (shown once) -> the author
// uploads and submits -> the moderator publishes from the queue -> it is in the catalog -> the author uploads a new
// archive -> students still get the old one until the moderator accepts it -> the moderator revokes the code and
// it stops working. Also: the dashboard and Напрями.
//
// Needs the full stack and the bootstrap ADMIN_TOKEN (the moderator). NOT run against a stack that predates this
// phase's UI.

import { expect, test, type Page } from '@playwright/test';
import {
  ADMIN_TOKEN,
  BASE_URL,
  adminScenarios,
  cleanupE2EScenarios,
  createScenario,
  deleteScenario,
  firstCategorySlug,
  uniqueScenarioId,
  uploadArchiveBytes,
  E2E_ID_PREFIX,
} from '../helpers/api';
import { openSection, signInThroughForm } from '../helpers/admin-ui';
import { buildScenarioZip } from '../helpers/zip';

/** What students are served for `id` right now: the archive URL of the public catalog row, or null if unlisted. */
async function publicArchive(id: string): Promise<string | null> {
  const res = await fetch(`${BASE_URL}/api/catalog/${encodeURIComponent(id)}`);
  return res.ok ? (await res.json()).scenarioUrl : null;
}

async function revokeByLabel(label: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/keys`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
  const { keys } = await res.json() as { keys: Array<{ id: number; label: string }> };
  for (const key of keys.filter(k => k.label === label)) {
    await fetch(`${BASE_URL}/api/keys/${key.id}/revoke`, { method: 'POST', headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
  }
}

test.describe('moderation: author to moderator to catalog', () => {
  let id: string;
  const keyLabel = `${E2E_ID_PREFIX}author-${Date.now()}`;

  test.beforeAll(async () => {
    await cleanupE2EScenarios();
  });

  test.afterAll(async () => {
    await deleteScenario(id);
    await revokeByLabel(keyLabel);
  });

  test('DW-7.6 issue a code, upload, submit, publish, new archive stays pending until accepted, revoke', async ({ page, browser }) => {
    id = uniqueScenarioId('mod');
    const category = await firstCategorySlug();

    // ---- the moderator issues the author's code (DW-7.4): shown once
    await signInThroughForm(page, ADMIN_TOKEN);
    await page.locator('.sidebar').getByRole('link', { name: 'Доступ' }).click();
    await page.locator('#key-label').fill(keyLabel);
    await page.locator('#key-role').selectOption('author');
    await page.locator('[data-action="issue"]').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const token = await dialog.locator('[data-role="token"]').inputValue();
    expect(token.length).toBeGreaterThan(20);
    await dialog.locator('[data-action="close"]').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(token);
    await expect(page.locator('tr', { hasText: keyLabel }).locator('[data-role="last-used"]')).toHaveText('ще не використовувався');

    // ---- the author (own browser context) creates a scenario, uploads v1 and submits it from the UI
    const authorContext = await browser.newContext({ baseURL: BASE_URL });
    const author: Page = await authorContext.newPage();
    try {
      await createScenario({ id, title: 'E2E модерація', category, description: 'Опис для модерації' }, token);
      await uploadArchiveBytes(id, buildScenarioZip({ id, version: '1.0.0' }), token);
      await signInThroughForm(author, token);
      await author.goto(`/admin/scenarios/${id}/publish`);
      await author.getByRole('button', { name: 'Подати на перевірку' }).click();
      await expect(author.locator('.status-pill').first()).toContainText('На перевірці');
      expect(await publicArchive(id)).toBeNull(); // not in the catalog yet

      // ---- the moderator sees it in the queue with its checks and publishes it (DW-7.1)
      await page.locator('.sidebar').getByRole('link', { name: 'Черга модерації' }).click();
      const card = page.locator(`.queue-card[data-id="${id}"]`);
      await expect(card).toBeVisible();
      await expect(card.locator('.check-chip').first()).toBeVisible();
      // The fixture has no cover, so the queue asks before publishing something with a gap (intended).
      const asked = new Promise<string>(resolve => page.once('dialog', d => { void d.accept(); resolve(d.message()); }));
      await card.locator('[data-action="approve"]').click();
      expect(await asked).toContain('Опублікувати все одно');
      await expect(card).toHaveCount(0);
      const firstUrl = await publicArchive(id);
      expect(firstUrl).toMatch(/^\/scenarios\/[0-9a-f]{64}\.zip$/);
      await expect(page.locator('[data-role="decisions"]')).toContainText('Опубліковано в каталозі');

      // ---- the author uploads a new archive: pending, students keep the old one
      await author.goto(`/admin/scenarios/${id}/files`);
      await author.locator('[data-role="archive-input"]').setInputFiles({
        name: 'v2.zip', mimeType: 'application/zip', buffer: buildScenarioZip({ id, version: '2.0.0' }),
      });
      await expect(author.locator('.banner-pending')).toBeVisible();
      expect(await publicArchive(id)).toBe(firstUrl);

      // ---- the queue lists it as a proposal; still the old archive until the moderator accepts
      // (the moderator's queue page was loaded before the upload, so it is opened afresh, as a moderator would)
      await page.reload();
      const proposal = page.locator(`.queue-card[data-id="${id}"]`);
      await expect(proposal.locator('[data-role="proposal"]')).toBeVisible();
      expect(await publicArchive(id)).toBe(firstUrl);
      await proposal.locator('[data-action="approve"]').click();
      await expect(proposal).toHaveCount(0);
      const secondUrl = await publicArchive(id);
      expect(secondUrl).toMatch(/^\/scenarios\/[0-9a-f]{64}\.zip$/);
      expect(secondUrl).not.toBe(firstUrl);

      // ---- the code has been used, the moderator revokes it, and it stops working (DW-7.4)
      await page.locator('.sidebar').getByRole('link', { name: 'Доступ' }).click();
      const keyRow = page.locator('tr', { hasText: keyLabel });
      await expect(keyRow.locator('[data-role="last-used"]')).not.toHaveText('ще не використовувався');
      page.once('dialog', d => void d.accept());
      await keyRow.locator('[data-action="revoke"]').click();
      await expect(keyRow).toContainText('Відкликано');
      const rejected = await fetch(`${BASE_URL}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
      expect(rejected.status).toBe(403);
      expect((await adminScenarios()).some(r => r.id === id)).toBe(true);
    } finally {
      await authorContext.close();
    }
  });

  test('DW-7.2 the dashboard is /admin and shows counts and activity', async ({ page }) => {
    await signInThroughForm(page, ADMIN_TOKEN);
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.locator('[data-role="greeting"]')).toContainText('Вітаємо');
    await expect(page.locator('.counter')).toHaveCount(4);
    await expect(page.locator('[data-role="queue"]')).toBeVisible();
  });

  test('DW-7.3 Напрями: add, hide and delete an empty category', async ({ page }) => {
    const slug = `e2e-cat-${Date.now()}`.slice(0, 50);
    await signInThroughForm(page, ADMIN_TOKEN);
    await page.locator('.sidebar').getByRole('link', { name: 'Напрями' }).click();
    await page.locator('#cat-label').fill('E2E напрям');
    await page.locator('#cat-slug').fill(slug);
    await page.locator('[data-action="add"]').click();
    const row = page.locator(`tr[data-slug="${slug}"]`);
    await expect(row).toBeVisible();
    await expect(row.locator('[data-action="delete"]')).toBeEnabled();
    await row.locator('[data-action="visibility"]').click();
    await expect(row.locator('[data-action="visibility"]')).toContainText('Сховано');
    page.once('dialog', d => void d.accept());
    await row.locator('[data-action="delete"]').click();
    await expect(row).toHaveCount(0);
  });
});

// B6 (DW-6.4e): the two things phase 5 added to this flow — a code can be rotated from the
// access page (the old code stops working at once and the scenarios go with the key), and an
// approve is bound to the version the moderator actually reviewed.
test.describe('moderation: B6 rotation and a stale approve', () => {
  let id: string;
  const keyLabel = `${E2E_ID_PREFIX}rotate-${Date.now()}`;
  /** The code after the rotation, kept for the second test and for the teardown. */
  let code: string;

  test.beforeAll(async () => {
    await cleanupE2EScenarios();
  });

  test.afterAll(async () => {
    await deleteScenario(id);
    await revokeByLabel(keyLabel);
  });

  test('B6.5 rotate a code from «Доступ»: the old one is refused, the new one owns the scenario', async ({ page }) => {
    id = uniqueScenarioId('rot');
    const category = await firstCategorySlug();

    // ---- the moderator issues a code and gives it a scenario to own
    await signInThroughForm(page, ADMIN_TOKEN);
    await openSection(page, 'Доступ');
    await page.locator('#key-label').fill(keyLabel);
    await page.locator('#key-role').selectOption('author');
    await page.locator('[data-action="issue"]').click();
    const issueDialog = page.getByRole('dialog');
    await expect(issueDialog).toBeVisible();
    const issued = await issueDialog.locator('[data-role="token"]').inputValue();
    expect(issued).toMatch(/^vlk_[A-Za-z0-9_-]{20,}$/);
    await issueDialog.locator('[data-action="close"]').click();
    await expect(issueDialog).toHaveCount(0);

    await createScenario({ id, title: 'B6 ротація', description: 'Опис для ротації', category }, issued);
    await uploadArchiveBytes(id, buildScenarioZip({ id, version: '1.0.0' }), issued);
    // The list was read before the scenario existed, so it is refreshed: the count
    // is the key's ownership, read as a moderator sees it after the fact.
    await page.reload();
    // A rotation keeps the label, so a live row is the one that is not revoked.
    const keyRow = page.locator('tr', { hasText: keyLabel }).filter({ hasNotText: 'Відкликано' });
    await expect(keyRow).toHaveCount(1);
    await expect(keyRow.locator('[data-role="scenario-count"]')).toHaveText('1');

    // ---- rotate it: the replacement is shown once, the old code dies
    page.once('dialog', d => void d.accept());
    await keyRow.locator('[data-action="rotate"]').click();
    const rotateDialog = page.getByRole('dialog');
    await expect(rotateDialog).toBeVisible();
    const rotated = await rotateDialog.locator('[data-role="token"]').inputValue();
    expect(rotated).not.toBe(issued);
    await rotateDialog.locator('[data-action="close"]').click();
    await expect(page.locator('body')).not.toContainText(rotated);

    const oldCode = await fetch(`${BASE_URL}/api/auth/me`, { headers: { Authorization: `Bearer ${issued}` } });
    expect(oldCode.status).toBe(403);
    const me = await fetch(`${BASE_URL}/api/auth/me`, { headers: { Authorization: `Bearer ${rotated}` } });
    expect(me.status).toBe(200);
    expect((await me.json()).label).toBe(keyLabel);

    // ---- the scenario moved with the key: the new code owns it, the row still counts it
    const owned = (await adminScenarios(rotated)).filter(r => r.id === id);
    expect(owned).toHaveLength(1);
    expect(owned[0].ownerLabel).toBe(keyLabel);
    await expect(keyRow.locator('[data-role="scenario-count"]')).toHaveText('1');
    code = rotated;
  });

  test('B6.5 an archive swapped while the card is open is a 409 by name, then the fresh version publishes', async ({ page, browser }) => {
    // ---- the author submits, and the moderator opens the queue card (v1 is current)
    const authorContext = await browser.newContext({ baseURL: BASE_URL });
    const author: Page = await authorContext.newPage();
    try {
      await signInThroughForm(author, code);
      await author.goto(`/admin/scenarios/${id}/publish`);
      await author.getByRole('button', { name: 'Подати на перевірку' }).click();
      await expect(author.locator('.status-pill').first()).toContainText('На перевірці');

      // the moderator signs in on this test's own page and opens the queue while v1 is current
      await signInThroughForm(page, ADMIN_TOKEN);
      await openSection(page, 'Черга модерації');
      const card = page.locator(`.queue-card[data-id="${id}"]`);
      await expect(card).toBeVisible();
      await expect(card.locator('[data-action="viewer"]')).toBeVisible(); // the card names the current version

      // ---- the author swaps the archive under the moderator: withdraw, upload v2, submit again
      const move = async (action: string) =>
        fetch(`${BASE_URL}/api/scenarios/${id}/${action}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${code}` },
        });
      expect((await move('withdraw')).status).toBe(200);
      await uploadArchiveBytes(id, buildScenarioZip({ id, version: '2.0.0' }), code);
      expect((await move('submit')).status).toBe(200);

      // ---- the click is refused by name: nothing is published, the card reloads with v2
      page.on('dialog', d => void d.accept());
      await card.locator('[data-action="approve"]').click();
      await expect(card).toContainText('Архів змінився після перевірки');
      expect(await publicArchive(id)).toBeNull();

      // ---- the reloaded card publishes what is current now
      await card.locator('[data-action="approve"]').click();
      await expect(card).toHaveCount(0);
      expect(await publicArchive(id)).toMatch(/^\/scenarios\/[0-9a-f]{64}\.zip$/);
    } finally {
      await authorContext.close();
    }
  });
});
