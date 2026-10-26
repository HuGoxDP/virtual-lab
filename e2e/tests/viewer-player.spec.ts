// e2e/tests/viewer-player.spec.ts
//
// Player isolation, phase 5 (DW-5.2, DW-5.4; test-plan 171-174): the viewer driving the sandboxed player,
// on the ZIP path and on `?stream=1`, plus the dirty cases (leaving mid-download / mid-load, a player that
// never handshakes, restart while paused) and ten round trips.
//
// The scenario's state is read INSIDE the frame (helpers/engine.ts); the page holds no engine.

import { expect, test, type Page } from '@playwright/test';
import { smallestPublishedScenario } from '../helpers/api';
import { ENGINE_URL, loseWebGLContext, playerFrame, playerFrames, profilerState, waitForFrames } from '../helpers/engine';

/** The scenario's clock, read in the frame: 0 means the player paused it. */
async function timeScale(page: Page): Promise<number> {
  return (await playerFrame(page)).evaluate(async url => {
    const { Time } = await import(url);
    return Time.timeScale as number;
  }, new URL(ENGINE_URL, page.url()).href);
}

/** Gives the host page (not the frame) the keyboard, as a click on the HUD title area would. */
async function focusHost(page: Page): Promise<void> {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.focus();
  });
  await page.locator('vl-viewer-hud .title-badge').click({ force: true });
  expect(await page.evaluate(() => document.activeElement?.tagName), 'the host page has the keyboard').not.toBe('IFRAME');
}

const MODES = [
  { name: 'ZIP', query: '', stream: false },
  { name: '?stream=1', query: '?stream=1', stream: true },
] as const;

for (const mode of MODES) {
  test.describe(`player controls, ${mode.name}`, () => {
    let id = 'molecules'; // has a manifest and an archive in a populated stack

    test.beforeAll(async ({ request }) => {
      if (mode.stream) {
        const res = await request.get('/a/molecules.json');
        test.skip(!res.ok(), 'Per-asset store is empty - run `cd backend && npm run import:assets` first.');
      } else {
        id = (await smallestPublishedScenario()).id;
      }
    });

    test(`DW-5.2 ${mode.name}: runs in a sandboxed frame, focus goes to it, FPS is reported`, async ({ page }) => {
      const zipRequests: string[] = [];
      page.on('request', r => { if (/\/scenarios\/[^/]+\.zip/.test(r.url())) zipRequests.push(r.url()); });

      await page.goto(`/play/${id}${mode.query}`);
      await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 80_000 });

      const frames = playerFrames(page);
      expect(frames).toHaveLength(1);
      const sandbox = await page.locator('iframe').getAttribute('sandbox');
      expect(sandbox?.split(/\s+/).sort()).toEqual(['allow-pointer-lock', 'allow-scripts']);
      expect(await page.evaluate(() => (document.activeElement as HTMLIFrameElement | null)?.tagName), 'focus goes to the frame').toBe('IFRAME');

      await waitForFrames(page);
      await expect(page.locator('vl-viewer-hud .fps')).toHaveText(/^\d+ FPS$/, { timeout: 15_000 });
      expect(zipRequests.length > 0, 'the delivery path').toBe(!mode.stream);
    });

    /**
     * One key press is exactly one toggle: the HUD says so, the scenario clock agrees, and neither flips
     * back a moment later (a press delivered to both the player and the host page would do exactly that).
     */
    async function pressSpaceOnce(page: Page, expect_: { paused: boolean }): Promise<void> {
      await page.keyboard.press('Space');
      await expect(page.getByRole('button', { name: expect_.paused ? 'Продовжити' : 'Пауза' })).toBeVisible();
      await page.waitForTimeout(800);
      await expect(page.getByRole('button', { name: expect_.paused ? 'Продовжити' : 'Пауза' }), 'it did not flip back').toBeVisible();
      expect(await timeScale(page), 'the clock in the frame agrees').toBe(expect_.paused ? 0 : 1);
    }

    test(`DW-5.U1 ${mode.name}: Space with the frame focused (the default after load) pauses, then resumes - one press, one toggle`, async ({ page }) => {
      await page.goto(`/play/${id}${mode.query}`);
      await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 80_000 });
      await waitForFrames(page);

      // The viewer focuses the frame after load, so this key goes to the player inside it.
      expect(await page.evaluate(() => document.activeElement?.tagName), 'the frame has the keyboard').toBe('IFRAME');
      await pressSpaceOnce(page, { paused: true });
      expect(await page.evaluate(() => document.activeElement?.tagName), 'pausing did not move focus out of the frame').toBe('IFRAME');
      await pressSpaceOnce(page, { paused: false });
    });

    test(`DW-5.U1 ${mode.name}: Space with the host page focused pauses, then resumes - one press, one toggle`, async ({ page }) => {
      await page.goto(`/play/${id}${mode.query}`);
      await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 80_000 });
      await waitForFrames(page);

      await focusHost(page);
      await pressSpaceOnce(page, { paused: true });
      await pressSpaceOnce(page, { paused: false });
    });

    test(`DW-5.U1 ${mode.name}: the two routes interleave - frame Space, host Space and the HUD button all act on the same state`, async ({ page }) => {
      await page.goto(`/play/${id}${mode.query}`);
      await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 80_000 });
      await waitForFrames(page);

      await pressSpaceOnce(page, { paused: true }); // frame focused: the player pauses
      await page.getByRole('button', { name: 'Продовжити' }).click(); // the HUD button resumes (host -> player)
      await expect(page.getByRole('button', { name: 'Пауза' })).toBeVisible();
      expect(await timeScale(page)).toBe(1);
      await focusHost(page);
      await pressSpaceOnce(page, { paused: true }); // host focused: the host asks the player
      await page.locator('iframe').focus(); // back to the frame
      await pressSpaceOnce(page, { paused: false }); // the player resumes
    });

    test(`DW-5.2 ${mode.name}: restart builds a fresh frame - old one gone, no second archive request - and while paused comes back running`, async ({ page }) => {
      const zipRequests: string[] = [];
      page.on('request', r => { if (/\/scenarios\/[^/]+\.zip/.test(r.url())) zipRequests.push(r.url()); });

      await page.goto(`/play/${id}${mode.query}`);
      await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 80_000 });
      await waitForFrames(page);

      await page.getByRole('button', { name: 'Пауза' }).click();
      await expect(page.getByRole('button', { name: 'Продовжити' })).toBeVisible();

      const oldFrame = await playerFrame(page);
      const requestsBefore = zipRequests.length;
      await page.getByRole('button', { name: 'Спочатку' }).click();

      await expect.poll(() => oldFrame.isDetached(), { message: 'the old frame is removed' }).toBe(true);
      await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 80_000 });
      await waitForFrames(page);

      expect(playerFrames(page)).toHaveLength(1);
      expect(zipRequests.length, 'no second archive request').toBe(requestsBefore);
      await expect(page.getByRole('button', { name: 'Пауза' }), 'a fresh frame is not paused').toBeVisible();
      expect(await timeScale(page)).toBe(1);

      // The new frame has the keyboard (focus goes to it after each run), so Space works in it at once.
      expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('IFRAME');
      await page.keyboard.press('Space');
      await expect(page.getByRole('button', { name: 'Продовжити' })).toBeVisible();
      expect(await timeScale(page)).toBe(0);
    });

    test(`DW-5.2 ${mode.name}: fullscreen takes the host container, not the frame`, async ({ page }) => {
      await page.goto(`/play/${id}${mode.query}`);
      await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 80_000 });

      await page.getByRole('button', { name: 'На весь екран' }).click();
      await expect
        .poll(() => page.evaluate(() => document.fullscreenElement?.classList.contains('viewer-container') ?? false))
        .toBe(true);
      expect(await page.locator('iframe').getAttribute('allow')).toBe('autoplay');
      await page.getByRole('button', { name: 'На весь екран' }).click();
      await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
    });

    test(`DW-5.2 ${mode.name}: exit goes to the scenario page and leaves no frame`, async ({ page }) => {
      await page.goto(`/play/${id}${mode.query}`);
      await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 80_000 });
      await page.getByRole('button', { name: 'Вийти' }).click();
      await expect(page).toHaveURL(new RegExp(`/scenario/${id}$`));
      expect(playerFrames(page)).toHaveLength(0);
      await expect(page.locator('iframe')).toHaveCount(0);
    });

    test(`DW-5.2 ${mode.name}: a context loss inside the frame shows the overlay`, async ({ page }) => {
      await page.goto(`/play/${id}${mode.query}`);
      await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 80_000 });
      await waitForFrames(page);

      expect(await loseWebGLContext(page)).toBe(true);
      await expect(page.getByText('Графічний контекст втрачено')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Перезавантажити' })).toBeVisible();
    });

    test(`DW-5.2 ${mode.name}: no profiler overlay, with ?diag=1 as well`, async ({ page }) => {
      const sep = mode.query ? '&' : '?';
      await page.goto(`/play/${id}${mode.query}${sep}diag=1`);
      await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 80_000 });
      await waitForFrames(page);

      await page.keyboard.press('Backquote');
      await page.waitForTimeout(2000);
      expect(await profilerState(page)).toEqual({ element: false, visible: false, allowed: false });
      await expect(page.locator('#webengine-profiler')).toHaveCount(0);
      await expect(page.locator('.build-badge')).toBeVisible({ timeout: 15_000 });
    });
  });
}

test.describe('dirty paths (DW-5.2)', () => {
  test('leaving mid-download aborts it and never starts a frame', async ({ page }) => {
    const { id } = await smallestPublishedScenario();
    await page.route('**/scenarios/*.zip', async route => {
      await new Promise(resolve => setTimeout(resolve, 4000));
      await route.continue().catch(() => undefined);
    });
    await page.goto(`/play/${id}`);
    await page.locator('vl-viewer-loading').getByRole('button', { name: 'Скасувати' }).click();
    await expect(page).toHaveURL(new RegExp(`/scenario/${id}$`));
    await page.waitForTimeout(5000);
    expect(playerFrames(page)).toHaveLength(0);
    await expect(page.locator('iframe')).toHaveCount(0);
  });

  test('leaving mid-load removes the frame; nothing is left running', async ({ page }) => {
    const { id } = await smallestPublishedScenario();
    // Hold the engine bundle back so the player sits in "loading" when we leave.
    await page.route('**/assets/WebEngineTS.standalone.js', async route => {
      await new Promise(resolve => setTimeout(resolve, 8000));
      await route.continue().catch(() => undefined);
    });
    await page.goto(`/play/${id}`);
    await expect(page.locator('iframe')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator('vl-viewer-loading .loader-stage')).toHaveText('Ініціалізація сцени');

    await page.locator('vl-viewer-loading').getByRole('button', { name: 'Скасувати' }).click();
    await expect(page).toHaveURL(new RegExp(`/scenario/${id}$`));
    await expect(page.locator('iframe')).toHaveCount(0);
    expect(playerFrames(page)).toHaveLength(0);

    await page.waitForTimeout(9000); // the late engine must not resurrect anything
    await expect(page.locator('iframe')).toHaveCount(0);
  });

  test('a player that never completes the handshake ends in the error state, not a spinner', async ({ page }) => {
    const { id } = await smallestPublishedScenario();
    await page.route('**/player/player.html', route =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>silent</title>' }));

    await page.goto(`/play/${id}`);
    const error = page.locator('.error-overlay [role="alert"]');
    await expect(error.getByRole('heading', { name: 'Помилка завантаження' })).toBeVisible({ timeout: 30_000 });
    await expect(error).toContainText('Відтворювач сценаріїв не відповів');
    await expect(page.locator('vl-viewer-loading')).toHaveCount(0);
    await expect(page.locator('iframe'), 'the failed frame is removed').toHaveCount(0);
    await error.getByRole('button', { name: 'Повернутись до каталогу' }).click();
    await expect(page).toHaveURL(/\/catalog/);
  });
});

test.describe('round trips (DW-5.4)', () => {
  test('DW-5.4 ten catalog -> viewer -> exit round trips leave no frame and no WebGL warnings, and the eleventh still renders', async ({ page }) => {
    test.setTimeout(600_000);
    const { id } = await smallestPublishedScenario();

    const warnings: string[] = [];
    page.on('console', m => { if (/too many active webgl contexts|webgl context.*lost/i.test(m.text())) warnings.push(m.text()); });

    for (let i = 0; i < 10; i++) {
      await page.goto(`/play/${id}`);
      await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 80_000 });
      await waitForFrames(page);
      await page.getByRole('button', { name: 'Вийти' }).click();
      await expect(page).toHaveURL(new RegExp(`/scenario/${id}$`));
      await expect(page.locator('iframe')).toHaveCount(0);
      expect(playerFrames(page), `round trip ${i + 1}`).toHaveLength(0);
    }

    // A context left behind would eventually evict the newest one; a fresh run must still draw.
    await page.goto(`/play/${id}`);
    await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 80_000 });
    const snapshot = await waitForFrames(page);
    expect(snapshot.drawCalls).toBeGreaterThan(0);
    expect(warnings, 'the browser never complained about WebGL contexts').toEqual([]);
  });
});
