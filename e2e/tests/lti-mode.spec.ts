// e2e/tests/lti-mode.spec.ts
//
// LTI mode in the viewer and the Deep Linking pick page (Phase 6). The platform's LTI endpoints need a
// Moodle launch to hand out a session cookie, so the session and submit calls are answered by
// `page.route` here; everything else (the page, the player frame, the scenario) is the real stack.
// The real Moodle round trip is Phase 7's walkthrough on the lti-demo stand.
//
// DW-6.2: the public viewer shows no LTI controls and asks no LTI endpoint.

import { expect, test, type Page } from '@playwright/test';
import { smallestPublishedScenario } from '../helpers/api';

const SESSION = { scenarioId: 'x', role: 'learner', messageType: 'resource', graded: false, submitted: null };

async function mockSession(page: Page, session: object | null) {
  await page.route('**/api/lti/session', route =>
    session
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session) })
      : route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Немає сесії' }) }));
}

test.describe('LTI mode', () => {
  test('the public viewer shows no LTI controls and makes no LTI request', async ({ page }) => {
    const { id } = await smallestPublishedScenario();
    const ltiCalls: string[] = [];
    page.on('request', req => { if (req.url().includes('/api/lti/')) ltiCalls.push(req.url()); });

    await page.goto(`/play/${id}`);
    await expect(page.locator('vl-viewer-hud')).toBeVisible({ timeout: 60_000 });

    await expect(page.locator('vl-lti-submit')).toHaveCount(0);
    expect(ltiCalls).toEqual([]);
  });

  test('?lti=1 with a non-graded session: «Завершити» submits and shows «Роботу здано»', async ({ page }) => {
    const { id } = await smallestPublishedScenario();
    await mockSession(page, SESSION);
    let body: string | null = null;
    await page.route('**/api/lti/submit', route => {
      body = route.request().postData();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ score: 1 }) });
    });

    await page.goto(`/play/${id}?lti=1`);
    const finish = page.getByRole('button', { name: 'Завершити' });
    await expect(finish).toBeVisible({ timeout: 60_000 });
    await finish.click();

    await expect(page.locator('vl-lti-submit')).toContainText('Роботу здано, оцінка 100 з 100');
    await expect(page.locator('vl-lti-submit button')).toHaveCount(0);
    expect(JSON.parse(body ?? 'null')).toEqual({});
  });

  test('?lti=1 graded: «Здати» asks for confirmation before anything is sent', async ({ page }) => {
    const { id } = await smallestPublishedScenario();
    await mockSession(page, { ...SESSION, graded: true });
    let submits = 0;
    await page.route('**/api/lti/submit', route => {
      submits++;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ score: 0 }) });
    });

    await page.goto(`/play/${id}?lti=1`);
    await page.getByRole('button', { name: 'Здати' }).click({ timeout: 60_000 });
    await expect(page.locator('.lti-confirm')).toBeVisible();
    expect(submits).toBe(0);

    await page.getByRole('button', { name: 'Так, здати' }).click();
    await expect(page.locator('vl-lti-submit')).toContainText('Роботу здано');
    expect(submits).toBe(1);
  });

  test('?lti=1 instructor: view mode, no button', async ({ page }) => {
    const { id } = await smallestPublishedScenario();
    await mockSession(page, { ...SESSION, role: 'instructor' });

    await page.goto(`/play/${id}?lti=1`);
    await expect(page.locator('vl-lti-submit')).toContainText('Режим перегляду', { timeout: 60_000 });
    await expect(page.locator('vl-lti-submit button')).toHaveCount(0);
  });

  test('?lti=1 without a session: a Ukrainian message, no button, the scenario still runs', async ({ page }) => {
    const { id } = await smallestPublishedScenario();
    await mockSession(page, null);

    await page.goto(`/play/${id}?lti=1`);
    await expect(page.locator('vl-lti-submit')).toContainText('Сесію Moodle завершено', { timeout: 60_000 });
    await expect(page.locator('vl-lti-submit button')).toHaveCount(0);
    await expect(page.locator('vl-viewer-hud')).toBeVisible();
  });

  test('/lti/pick: a deep-link session lists the catalog and the form posts to /api/lti/deep-link', async ({ page }) => {
    await mockSession(page, { scenarioId: null, role: 'instructor', messageType: 'deep-link', graded: false, submitted: null });
    await page.route('**/api/lti/deep-link', route =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>posted</title>' + (route.request().postData() ?? '') }));

    await page.goto('/lti/pick');
    const rows = page.locator('.pick-row');
    await expect(rows.first()).toBeVisible();
    await rows.first().click();

    const [request] = await Promise.all([
      page.waitForRequest(req => req.url().endsWith('/api/lti/deep-link')),
      page.getByRole('button', { name: 'Додати до курсу' }).click(),
    ]);
    expect(request.method()).toBe('POST');
    expect(request.isNavigationRequest()).toBe(true); // a top-level document, not a fetch
    expect(request.postData()).toMatch(/^scenarioId=[^&]+$/);
  });

  test('/lti/pick without a deep-link session shows no catalog', async ({ page }) => {
    await mockSession(page, null);
    await page.goto('/lti/pick');
    await expect(page.getByRole('alert')).toContainText('Сесію Moodle завершено');
    await expect(page.locator('.pick-row')).toHaveCount(0);
  });
});
