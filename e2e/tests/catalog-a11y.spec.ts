// e2e/tests/catalog-a11y.spec.ts
//
// test-plan.md §7 — the catalog half: F10 (modal focus trap, Esc, focus
// restoration) and F9 (portrait layout), plus keyboard operability from §4.8.
//
// None of this is assertable in a unit test: a focus trap is only real against
// a live document with actual layout, because the implementation filters on
// `offsetParent !== null` to skip hidden controls.

import { expect, test } from '@playwright/test';

/** Where focus currently is, as something readable in a failure message. */
async function focusDescriptor(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return '(none)';
    const label = el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? '';
    return `${el.tagName.toLowerCase()}.${el.className.split(' ')[0]}[${label}]`;
  });
}

test.describe('catalog accessibility', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.scenario-card').first()).toBeVisible();
  });

  test('a card is reachable and openable from the keyboard', async ({ page }) => {
    const firstCard = page.locator('.scenario-card').first();

    await firstCard.focus();
    await expect(firstCard).toBeFocused();

    // The card is a <button>, so Enter must open it — a div with a click handler
    // would pass a mouse test and fail this one.
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('opening the modal moves focus into it, Esc restores it (F10)', async ({ page }) => {
    const firstCard = page.locator('.scenario-card').first();
    await firstCard.focus();
    await page.keyboard.press('Enter');

    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();

    // Focus must land inside the dialog, or a keyboard user is left behind it.
    await expect
      .poll(async () => modal.evaluate((node, _) => node.contains(document.activeElement), null),
        { message: `focus stayed outside the dialog: ${await focusDescriptor(page)}` })
      .toBe(true);

    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();

    // And it must come back to the card that opened it.
    await expect(firstCard).toBeFocused();
  });

  test('Tab cycles inside the dialog rather than escaping it (F10)', async ({ page }) => {
    await page.locator('.scenario-card').first().click();

    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();

    const insideAfterTabs: boolean[] = [];
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      insideAfterTabs.push(
        await modal.evaluate(node => node.contains(document.activeElement))
      );
    }

    expect(
      insideAfterTabs.every(Boolean),
      `focus left the dialog on tab #${insideAfterTabs.indexOf(false) + 1}`
    ).toBe(true);
  });

  test('Shift+Tab wraps backwards inside the dialog (F10)', async ({ page }) => {
    await page.locator('.scenario-card').first().click();

    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();

    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(
        await modal.evaluate(node => node.contains(document.activeElement)),
        `focus left the dialog backwards on press #${i + 1}`
      ).toBe(true);
    }
  });

  test('clicking the backdrop closes, clicking the panel does not', async ({ page }) => {
    await page.locator('.scenario-card').first().click();

    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();

    // Inside the panel: must stay open.
    await modal.locator('.modal-title').click();
    await expect(modal).toBeVisible();

    // The overlay itself: only the backdrop closes, so aim at its corner.
    await page.locator('.modal-overlay').click({ position: { x: 5, y: 5 } });
    await expect(modal).toBeHidden();
  });

  test('search is labelled and filters server-side', async ({ page }) => {
    const search = page.getByLabel('Пошук сценаріїв');
    await expect(search).toBeVisible();

    await search.fill('zzzz-no-such-scenario');

    // An empty result must say so rather than render an empty grid.
    await expect(page.locator('.empty-state')).toBeVisible();
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
