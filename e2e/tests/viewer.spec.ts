// e2e/tests/viewer.spec.ts
//
// test-plan.md §7 — the viewer half of "not verifiable without a browser".
//
// Covers F5 (progress actually advancing), F7 (no WebGL2, and context loss) and
// F8 (fullscreen, the profiler overlay, the build badge). Every one of these was
// previously confirmed only by reading the code.

import { expect, test } from '@playwright/test';
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
          const label = document.querySelector('.loader-label')?.textContent ?? '';
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
    // the archive download, then the engine unpacking it ("Ініціалізація сцени",
    // then whatever the engine reports as its current operation). So progress is
    // monotonic *within* a phase, not across the pair — asserting one continuous
    // 0→100 ramp would be asserting a design the viewer does not have.
    const download = seen.filter(s => s.label.startsWith('Завантаження'));
    const engine = seen.filter(s => !s.label.startsWith('Завантаження'));

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
    test('no button and no build badge without ?diag=1', async ({ page }) => {
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

    test('with ?diag=1 the button toggles the profiler overlay', async ({ page }) => {
      const id = await smallestPublishedId();

      await page.goto(`/play/${id}?diag=1`);
      await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 80_000 });

      const isOpen = () => page.evaluate(async () => {
        const { MemoryProfiler } = await import('WebEngineTS');
        return MemoryProfiler.isOverlayVisible;
      });

      // Assert the flip rather than a fixed direction: with ?diag=1 the platform
      // leaves whatever the scenario did alone, so the starting state is content-
      // dependent.
      const before = await isOpen();

      await page.locator('.control-btn[aria-label="Показати діагностику"]').click();
      await expect.poll(isOpen).toBe(!before);
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
});
