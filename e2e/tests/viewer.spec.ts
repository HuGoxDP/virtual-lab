// e2e/tests/viewer.spec.ts
//
// test-plan.md §7 — the viewer half of "not verifiable without a browser".
//
// Covers F5 (progress actually advancing), F7 (no WebGL2, and context loss) and
// F8 (fullscreen, the profiler overlay, the build badge). Every one of these was
// previously confirmed only by reading the code.
//
// Release 1, phase 4 (test-plan 141-144; DW-4.1, 4.2, 4.4, 4.5): the loading screen and the HUD
// restyled as Nocturne prototype screens 2c / 2d — cancel and exit go to /scenario/:id, restart
// runs from the buffer, the hints leave at 390 px, error states keep their actions. The HUD has
// no diagnostics button (Phase 5 removes the code behind it).

import { expect, test, type Page } from '@playwright/test';
import { adminScenarios, smallestPublishedScenario } from '../helpers/api';
import { loseWebGLContext, readEngineBuild, waitForFrames } from '../helpers/engine';

/** The largest published scenario — the only one whose download is slow enough to watch. */
async function largestPublishedId(): Promise<string> {
  const rows = await adminScenarios();
  const published = rows
    .filter(r => r.isPublished && r.archiveBytes)
    .sort((a, b) => Number(b.archiveBytes) - Number(a.archiveBytes));

  if (published.length === 0) throw new Error('No published scenario with a stored archive.');
  return published[0].id;
}

/**
 * The cheapest scenario that still renders — used wherever the test is about the
 * viewer rather than the download, since the largest archive costs ~45s a run
 * under SwiftShader.
 */
async function smallestPublishedId(): Promise<string> {
  return (await smallestPublishedScenario()).id;
}

test.describe('viewer', () => {
  test('progress advances from 0 to 100 during a real download (F5)', async ({ page }) => {
    const id = await largestPublishedId();

    // Watch every repaint rather than polling: a poll can miss all the
    // intermediate values on a fast localhost transfer and prove nothing.
    // Before the zoneless fix this stayed at 0 for the whole download, because
    // the callbacks assigned to plain fields instead of signals.
    const seen: Array<{ percent: number; label: string }> = [];

    await page.exposeFunction('__recordPercent', (percent: number, label: string) => {
      seen.push({ percent, label });
    });

    await page.addInitScript(() => {
      const observe = () => {
        const observer = new MutationObserver(() => {
          const el = document.querySelector('.loader-percent');
          if (!el?.textContent) return;
          const parsed = Number.parseInt(el.textContent, 10);
          const label = document.querySelector('.loader-stage')?.textContent ?? '';
          if (!Number.isNaN(parsed)) (window as any).__recordPercent(parsed, label);
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      };
      if (document.body) observe();
      else document.addEventListener('DOMContentLoaded', observe);
    });

    await page.goto(`/play/${id}`);
    await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 80_000 });

    expect(seen.length, 'progress should have been rendered at least once').toBeGreaterThan(0);

    // The ring is shared by two phases and deliberately restarts between them:
    // the archive download ("Отримання даних із сервера"), then the engine
    // unpacking it ("Ініціалізація сцени"). So progress is
    // monotonic *within* a phase, not across the pair — asserting one continuous
    // 0→100 ramp would be asserting a design the viewer does not have.
    const download = seen.filter(s => s.label === 'Отримання даних із сервера');
    const engine = seen.filter(s => s.label !== 'Отримання даних із сервера');

    expect(download.length, 'the download phase should report progress').toBeGreaterThan(0);
    expect(Math.max(...download.map(s => s.percent)), 'download must reach 100%').toBe(100);

    for (const [name, phase] of [['download', download], ['engine', engine]] as const) {
      const percents = phase.map(s => s.percent);
      const backwards = percents.filter((value, i) => i > 0 && value < percents[i - 1]);
      expect(backwards, `${name} progress went backwards: ${percents.join(',')}`).toHaveLength(0);
    }
  });

  test('reports no WebGL2 instead of throwing (F7)', async ({ page }) => {
    // Deny only webgl2 — the probe runs before the Application constructor, and
    // without it the student sees a raw exception string.
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type: string, ...rest: unknown[]) {
        if (type === 'webgl2') return null;
        return (original as any).apply(this, [type, ...rest]);
      } as typeof original;
    });

    await page.goto('/play/solar-system');

    await expect(page.getByText('Браузер не підтримує WebGL 2')).toBeVisible();
    await expect(page.locator('.loading-overlay')).toHaveCount(0);
  });

  test('shows the context-loss overlay after a driver reset (F7)', async ({ page }) => {
    const id = await smallestPublishedId();

    await page.goto(`/play/${id}`);
    await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 80_000 });
    await waitForFrames(page);

    expect(await loseWebGLContext(page), 'WEBGL_lose_context should be available').toBe(true);

    await expect(page.getByText('Графічний контекст втрачено')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Перезавантажити' })).toBeVisible();
  });

  test.describe('diagnostics are a launch option, not a student control (F8)', () => {
    test('no diagnostics button in the HUD, and no build badge without ?diag=1', async ({ page }) => {
      const id = await smallestPublishedId();

      await page.goto(`/play/${id}`);
      await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 80_000 });

      await expect(page.locator('.build-badge')).toHaveCount(0);
      await expect(page.locator('.control-btn[aria-label="Показати діагностику"]')).toHaveCount(0);
    });

    test('a scenario cannot open the profiler on a student', async ({ page }) => {
      // Regression test for a real defect this suite found: `solar-system` calls
      // MemoryProfiler.showOverlay() from its own scenario code, so students
      // opening the platform's flagship scenario were shown a developer overlay
      // of FPS and VRAM counters. Gating the button cannot stop that — the
      // scenario is arbitrary engine code — so the viewer now closes it.
      await page.goto('/play/solar-system');
      await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 80_000 });
      await waitForFrames(page);

      await expect
        .poll(async () => page.evaluate(async () => {
          const { MemoryProfiler } = await import('WebEngineTS');
          return MemoryProfiler.isOverlayVisible;
        }), { message: 'the profiler overlay must not be open without ?diag=1' })
        .toBe(false);
    });

    test('with ?diag=1 the badge names the running engine build', async ({ page }) => {
      const id = await smallestPublishedId();

      await page.goto(`/play/${id}?diag=1`);
      await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 80_000 });

      const badge = page.locator('.build-badge');
      await expect(badge).toBeVisible();

      // The badge must agree with what the bundle says about itself — the whole
      // point is that it identifies the build, not that it renders some string.
      const build = await readEngineBuild(page);
      expect(build.isBuild, 'a packed bundle should report isBuild').toBe(true);
      await expect(badge).toContainText(build.version);
    });

    test('with ?diag=1 the HUD still has no diagnostics button, and the platform leaves the profiler alone', async ({ page }) => {
      // The HUD renders no diagnostics control any more; `?diag=1` only lifts the policy that
      // closes a scenario's own overlay. `solar-system` opens it itself, so with the flag it stays open.
      await page.goto('/play/solar-system?diag=1');
      await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 80_000 });
      await waitForFrames(page);

      await expect(page.locator('.control-btn[aria-label="Показати діагностику"]')).toHaveCount(0);
      await expect
        .poll(() => page.evaluate(async () => {
          const { MemoryProfiler } = await import('WebEngineTS');
          return MemoryProfiler.isOverlayVisible;
        }), { message: "with ?diag=1 the scenario's own overlay must not be closed" })
        .toBe(true);
    });
  });

  test('fullscreen toggles and restores (F8)', async ({ page }) => {
    const id = await smallestPublishedId();

    await page.goto(`/play/${id}`);
    await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 80_000 });

    const fullscreenButton = page.locator('.control-btn[aria-label="На весь екран"]');
    await fullscreenButton.click();

    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement !== null),
        { message: 'requestFullscreen should take effect' })
      .toBe(true);

    // Exit through the same control, not Escape: headless Chromium does not wire
    // Escape to exitFullscreen, and the button is what the component owns anyway.
    await fullscreenButton.click();

    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement !== null))
      .toBe(false);
  });

  test('shows the rotate hint on a portrait phone (F9)', async ({ page }) => {
    const id = await smallestPublishedId();

    await page.setViewportSize({ width: 390, height: 780 });
    await page.goto(`/play/${id}`);
    await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 80_000 });

    await expect(page.locator('.orientation-hint')).toBeVisible();

    await page.setViewportSize({ width: 780, height: 390 });
    await expect(page.locator('.orientation-hint')).toBeHidden();
  });

  // ── release 1, phase 4: loading screen and HUD ─────────────────────────────────────────────

  /** Holds the archive request back so the loading screen stays up long enough to inspect. */
  async function delayArchive(page: Page, ms: number): Promise<void> {
    await page.route('**/scenarios/*.zip', async route => {
      await new Promise(resolve => setTimeout(resolve, ms));
      await route.continue().catch(() => undefined);
    });
  }

  test('DW-4.1 shows the loading screen (ring, title, byte line, stage, cancel), then the HUD', async ({ page }) => {
    const target = await smallestPublishedScenario();
    await delayArchive(page, 1500);

    await page.goto(`/play/${target.id}`);

    const loading = page.locator('vl-viewer-loading');
    await expect(loading).toBeVisible();
    await expect(loading.locator('.loader-percent')).toHaveText(/^\d+%$/);
    await expect(loading.locator('.loader-title')).toHaveText(target.title);
    await expect(loading.locator('.loader-bytes'))
      .toHaveText(/^Завантаження архіву — \d+,\d( з \d+,\d)? МБ$/);
    await expect(loading.locator('.loader-stage')).toHaveText(/\S/);
    await expect(loading.getByRole('button', { name: 'Скасувати' })).toBeVisible();

    await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 80_000 });
    await expect(page.locator('vl-viewer-loading')).toHaveCount(0);
    await expect(page.locator('vl-viewer-hud .title-text')).toHaveText(target.title);
  });

  test('DW-4.1 "Скасувати" aborts the download and returns to the scenario page', async ({ page }) => {
    const target = await smallestPublishedScenario();
    await delayArchive(page, 4000);

    // Record the abort of the archive fetch itself: a navigation alone proves nothing about it.
    await page.addInitScript(() => {
      const w = window as unknown as { __archiveAborted: boolean };
      w.__archiveAborted = false;
      const original = window.fetch;
      window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
        if (String(input).includes('/scenarios/')) {
          init?.signal?.addEventListener('abort', () => { w.__archiveAborted = true; });
        }
        return original.call(this, input, init);
      };
    });

    await page.goto(`/play/${target.id}`);
    await page.locator('vl-viewer-loading').getByRole('button', { name: 'Скасувати' }).click();

    await expect(page).toHaveURL(new RegExp(`/scenario/${target.id}$`));
    // An SPA route change keeps the document, so the flag set by the abort listener is still readable.
    expect(await page.evaluate(() => (window as unknown as { __archiveAborted: boolean }).__archiveAborted))
      .toBe(true);
  });

  test('DW-4.2 the HUD has Ukrainian aria-labels, and "Вийти" returns to the scenario page', async ({ page }) => {
    const target = await smallestPublishedScenario();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/play/${target.id}`);
    await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 80_000 });

    await expect(page.getByRole('button', { name: 'Спочатку' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'На весь екран' })).toBeVisible();
    // Pause and the FPS slot belong to the isolated player host: nothing student-visible is faked.
    await expect(page.getByRole('button', { name: 'Пауза' })).toHaveCount(0);
    await expect(page.locator('vl-viewer-hud .fps')).toHaveCount(0);

    await page.getByRole('button', { name: 'Вийти' }).click();
    await expect(page).toHaveURL(new RegExp(`/scenario/${target.id}$`));
  });

  test('DW-4.2 the hints show on a wide screen and are gone at 390 px, where the controls stay reachable', async ({ page }) => {
    const target = await smallestPublishedScenario();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/play/${target.id}`);
    await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 80_000 });

    const hints = page.locator('vl-viewer-hud .hints');
    await expect(hints).toBeVisible();
    await expect(hints).toContainText('Обертати');
    await expect(hints).toContainText('Масштаб');
    // Space does nothing in the page yet, so it must not be advertised.
    await expect(hints).not.toContainText('Space');

    await page.setViewportSize({ width: 390, height: 780 });
    await expect(hints).toBeHidden();

    const box = async (selector: string) => (await page.locator(selector).boundingBox())!;
    const exit = await box('vl-viewer-hud button.exit');
    const controls = await box('vl-viewer-hud .viewer-controls');
    const title = await box('vl-viewer-hud .title-badge');
    for (const b of [exit, controls, title]) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(390);
    }
    // The title drops below the buttons instead of overlapping them.
    expect(title.y).toBeGreaterThanOrEqual(Math.max(exit.y + exit.height, controls.y + controls.height));
    await page.getByRole('button', { name: 'На весь екран' }).click({ trial: true });
  });

  test('DW-4.4 restart re-runs the scenario from the buffer, with no second archive download', async ({ page }) => {
    const target = await smallestPublishedScenario();
    let archiveRequests = 0;
    let sessions = 0;
    page.on('request', req => {
      if (/\/scenarios\/[^/]+\.zip/.test(req.url())) archiveRequests++;
      if (req.url().endsWith('/api/telemetry/session') && req.method() === 'POST') sessions++;
    });

    await page.goto(`/play/${target.id}`);
    await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 80_000 });
    await expect.poll(() => sessions).toBe(1);

    const restart = page.getByRole('button', { name: 'Спочатку' });
    await expect(restart).toBeEnabled();
    await restart.click();

    // A second launch is counted only once a scene reached running again — proof the run happened.
    await expect.poll(() => sessions, { timeout: 80_000 }).toBe(2);
    await expect(page.locator('.viewer-controls')).toBeVisible();
    expect(archiveRequests, 'restart must reuse the buffer').toBe(1);
  });

  test('DW-4.5 an unknown scenario shows the Nocturne error state with its way out', async ({ page }) => {
    await page.goto('/play/no-such-scenario');

    const error = page.locator('.error-overlay [role="alert"]');
    await expect(error.getByRole('heading', { name: 'Помилка завантаження' })).toBeVisible();
    await expect(error).toContainText('Сценарій не знайдено');

    await error.getByRole('button', { name: 'Повернутись до каталогу' }).click();
    await expect(page).toHaveURL(/\/catalog/);
  });

  test('DW-4.5 the unsupported state is a Nocturne panel with its way out', async ({ page }) => {
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type: string, ...rest: unknown[]) {
        if (type === 'webgl2') return null;
        return (original as any).apply(this, [type, ...rest]);
      } as typeof original;
    });
    await page.goto('/play/solar-system');

    const panel = page.locator('.error-overlay [role="alert"]');
    await expect(panel.getByRole('heading', { name: 'Браузер не підтримує WebGL 2' })).toBeVisible();
    // Nocturne: Inter on the dark `--color-bg`.
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.error-overlay h1')!).fontFamily))
      .toContain('Inter');
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.error-overlay')!).backgroundColor))
      .toBe('rgb(22, 24, 38)');

    await panel.getByRole('button', { name: 'Повернутись до каталогу' }).click();
    await expect(page).toHaveURL(/\/catalog/);
  });
});
