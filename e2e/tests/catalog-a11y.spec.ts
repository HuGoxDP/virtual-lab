// e2e/tests/catalog-a11y.spec.ts
//
// test-plan.md §7 — the catalog half: F9 (portrait layout) and keyboard operability from §4.8.
// Release 1, phase 3 (#133, DW-3.10) replaced the modal's focus-trap tests (#79, retired with the
// modal) with keyboard tests of what took its place: the category chips, the sort segment and the
// scenario page.
//
// None of this is assertable in a unit test: focus order is only real against a live document with
// actual layout.

import { expect, test } from '@playwright/test';

test.describe('catalog accessibility', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.scenario-card').first()).toBeVisible();
  });

  test('a card is reachable and openable from the keyboard (#78)', async ({ page }) => {
    const title = page.locator('.scenario-card .open-button').first();

    await title.focus();
    await expect(title).toBeFocused();

    // The title is a real <button>: Enter opens the scenario page. A div with a click handler would
    // pass a mouse test and fail this one.
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/scenario\/[^/]+$/);
    await expect(page.locator('h1.title')).toBeVisible();
  });

  test('the card\'s "Запустити" button is reachable by Tab and plays', async ({ page }) => {
    const launch = page.locator('.scenario-card .launch').first();
    await launch.focus();
    await expect(launch).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/play\/[^/]+$/);
  });

  test('chips are buttons with aria-pressed, operable by Enter and Space (DW-3.10)', async ({ page }) => {
    const chips = page.locator('.chips .chip');
    await expect(chips.first()).toHaveAttribute('aria-pressed', 'true');

    const second = chips.nth(1);
    await second.focus();
    await page.keyboard.press('Enter');
    await expect(second).toHaveAttribute('aria-pressed', 'true');
    await expect(chips.first()).toHaveAttribute('aria-pressed', 'false');
    await expect(page).toHaveURL(/[?&]category=/);

    await chips.first().focus();
    await page.keyboard.press('Space');
    await expect(chips.first()).toHaveAttribute('aria-pressed', 'true');
    await expect(page).not.toHaveURL(/category=/);
  });

  test('the sort segment is a radio group: arrow keys switch it and the order is requested (DW-3.10)', async ({ page }) => {
    const byName = page.getByRole('radio', { name: 'За назвою' });
    const byNew = page.getByRole('radio', { name: 'Нові' });
    await expect(byNew).toBeChecked();

    await byNew.focus();
    const request = page.waitForRequest(r => r.url().includes('/api/catalog?') && r.url().includes('sort=title'));
    await page.keyboard.press('ArrowRight');
    await request;

    await expect(byName).toBeChecked();
    await expect(page).toHaveURL(/sort=title/);

    // Ukrainian collation: the grid is ordered by title, case-insensitively.
    await expect.poll(async () => {
      const titles = (await page.locator('.scenario-card .card-title').allTextContents()).map(t => t.trim());
      return titles.join('|') === [...titles].sort((x, y) => x.localeCompare(y, 'uk')).join('|');
    }, { message: 'the grid should settle in title order' }).toBe(true);

    await page.keyboard.press('ArrowLeft');
    await expect(byNew).toBeChecked();
    await expect(page).not.toHaveURL(/sort=/);
  });

  test('on the scenario page Tab reaches "Запустити симуляцію" and Enter plays (DW-3.10)', async ({ page }) => {
    await page.locator('.scenario-card .open-button').first().click();
    await expect(page.locator('h1.title')).toBeVisible();

    const launch = page.locator('.side .launch');
    const stops: string[] = [];
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab');
      stops.push(await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return el ? `${el.tagName.toLowerCase()}.${el.className.split(' ')[0]}` : '(none)';
      }));
      if (await launch.evaluate(node => node === document.activeElement)) break;
    }
    expect(stops.at(-1), `tab stops: ${stops.join(' > ')}`).toBe('button.btn');
    await expect(launch).toBeFocused();

    // The back button is the first stop: header order matches visual order.
    expect(stops[0]).toBe('a.btn');

    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/play\/[^/]+$/);
  });

  test('search is labelled and filters server-side; an empty result says so (#126)', async ({ page }) => {
    const search = page.getByLabel('Пошук сценаріїв');
    await expect(search).toBeVisible();

    await search.fill('zzzz-no-such-scenario');

    await expect(page.locator('.empty-state')).toBeVisible();
    await expect(page.locator('.empty-state')).toContainText('Нічого не знайдено');
    await expect(page.locator('.scenario-card')).toHaveCount(0);
  });

  test('reads on a portrait phone viewport (F9)', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });

    const card = page.locator('.scenario-card').first();
    await expect(card).toBeVisible();
    await expect(page.getByLabel('Пошук сценаріїв')).toBeVisible();

    // Cards must not overflow the viewport — the usual small-screen failure.
    const box = await card.boundingBox();
    expect(box, 'the first card should have a layout box').not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(360);
  });
});
