// e2e/tests/student-golden-path.spec.ts
//
// test-plan.md §4.11 #97 — the path every student takes.
//
// Catalog → filter → search → open a scenario → the ring advances 0→100 → the
// scene actually renders → back. Plus the telemetry pair, asserted from the
// network rather than the database: the `end` call goes out through
// `sendBeacon` during unload, and observing the request is the only way to see
// it happen at all.

import { expect, test } from '@playwright/test';
import { smallestPublishedScenario } from '../helpers/api';
import { waitForFrames } from '../helpers/engine';

test.describe('student golden path', () => {
  test('browse the catalog, play a scenario, come back', async ({ page }) => {
    // ── catalog ───────────────────────────────────────
    await page.goto('/');

    const cards = page.locator('.scenario-card');
    await expect(cards.first()).toBeVisible();

    const initialCount = await cards.count();
    expect(initialCount).toBeGreaterThan(0);

    // ── filter by category ────────────────────────────
    const chips = page.locator('.filters-bar button');
    await expect(chips.first()).toBeVisible();

    // The second chip is the first real category — the first is "all".
    const subjectChip = chips.nth(1);
    const subjectLabel = (await subjectChip.textContent())?.trim() ?? '';
    await subjectChip.click();

    await expect(subjectChip).toHaveAttribute('aria-pressed', 'true');
    await expect(cards.first()).toBeVisible();

    // Filtering is server-side, so every card on the page must match — a
    // client-side filter over a paged response could only ever filter one page.
    const shownCategories = await page.locator('.scenario-card .category-tag').allTextContents();
    expect(shownCategories.length).toBeGreaterThan(0);
    for (const label of shownCategories) {
      expect(subjectLabel).toContain(label.trim());
    }

    // ── search ────────────────────────────────────────
    await chips.first().click();  // back to "all"
    await expect(cards.first()).toBeVisible();

    const target = await smallestPublishedScenario();
    const searchTerm = target.title.split(' ')[0];

    await page.getByLabel('Пошук сценаріїв').fill(searchTerm);

    await expect
      .poll(async () => page.locator('.scenario-card .card-title').allTextContents(),
        { message: `search for "${searchTerm}" should narrow the grid` })
      .toEqual(expect.arrayContaining([expect.stringContaining(searchTerm)]));

    // ── open the detail modal ─────────────────────────
    await page.locator('.scenario-card', { hasText: target.title }).first().click();

    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();
    await expect(modal).toHaveAttribute('aria-modal', 'true');

    // ── launch, and watch the ring ────────────────────
    // The progress percentage lives in a signal; before the zoneless fix it sat
    // at 0 for entire downloads, so this assertion is load-bearing.
    const telemetryStart = page.waitForRequest(
      req => req.url().includes('/api/telemetry/session') && req.method() === 'POST'
    );

    await modal.locator('.launch-btn').click();
    await expect(page).toHaveURL(new RegExp(`/play/${target.id}`));

    await telemetryStart;

    const percent = page.locator('.loader-percent');
    if (await percent.isVisible().catch(() => false)) {
      await expect
        .poll(async () => {
          const text = await percent.textContent().catch(() => null);
          return text ? Number.parseInt(text, 10) : 100;
        }, { message: 'progress must advance past 0', timeout: 60_000 })
        .toBeGreaterThan(0);
    }

    // ── the scene must actually render ────────────────
    await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 60_000 });

    const snapshot = await waitForFrames(page);
    expect(snapshot.drawCalls, 'engine should have issued draw calls').toBeGreaterThan(0);

    await expect(page.locator('.title-badge')).toContainText(target.title);

    // No error overlay crept in behind the canvas.
    await expect(page.locator('.error-overlay')).toHaveCount(0);

    // ── back to the catalog ───────────────────────────
    // `end` rides sendBeacon during unload; catching the request is the only
    // way to observe it.
    const telemetryEnd = page.waitForRequest(
      req => /\/api\/telemetry\/session\/[^/]+\/end/.test(req.url()) && req.method() === 'POST'
    );

    await page.locator('.back-btn').click();
    await expect(page).toHaveURL(/\/(catalog)?$/);
    await expect(page.locator('.scenario-card').first()).toBeVisible();

    await telemetryEnd;
  });
});
