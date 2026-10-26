// e2e/helpers/engine.ts
//
// Reads the engine's own instrumentation from INSIDE the sandboxed player frame.
//
// Since player-isolation the platform page holds no engine and has no import map: the scenario runs in
// an `<iframe sandbox>` on an opaque origin (/player/player.html). The frame itself imports the engine
// by absolute URL, so a test running code in that frame can `import()` the very same URL and receive the
// very same module instance the scenario uses - no test hook in production code, nothing hung on `window`.
// (Playwright evaluates in the frame's own context; the page's CSP/sandbox does not restrict it.)
//
// `drawCalls` from the engine's own profiler is a direct answer to "did it render?", where the alternative
// is screenshot diffing, which under SwiftShader is slow and flaky.

import type { Frame, Page } from '@playwright/test';

export const ENGINE_URL = '/assets/WebEngineTS.standalone.js';
export const PLAYER_PATH = '/player/player.html';

export interface EngineSnapshot {
  drawCalls: number | null;
  triangles: number | null;
  textureVramBytes: number | null;
  textureCount: number | null;
  gpu: string | null;
}

export interface EngineBuild {
  version: string;
  builtAt: string | null;
  isBuild: boolean;
}

/** The player frames currently attached to the page. */
export function playerFrames(page: Page): Frame[] {
  return page.frames().filter(f => f.url().includes(PLAYER_PATH));
}

/** The (single) live player frame; waits for it to exist. */
export async function playerFrame(page: Page, timeout = 30_000): Promise<Frame> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const frames = playerFrames(page);
    if (frames.length > 0) return frames[frames.length - 1];
    await page.waitForTimeout(100);
  }
  throw new Error('no player frame appeared');
}

/** What the engine bundle running in the player calls itself. */
export async function readEngineBuild(page: Page): Promise<EngineBuild> {
  const frame = await playerFrame(page);
  return frame.evaluate(async url => {
    const { BuildInfo } = await import(url);
    return { version: BuildInfo.version, builtAt: BuildInfo.builtAt, isBuild: BuildInfo.isBuild };
  }, new URL(ENGINE_URL, page.url()).href);
}

/**
 * One `MemoryProfiler` sample, taken inside the frame. `snapshot()` is a plain read: it does not open the
 * overlay or create the rAF loop the overlay owns, so it cannot perturb what it measures.
 */
export async function readEngineSnapshot(page: Page): Promise<EngineSnapshot> {
  const frame = await playerFrame(page);
  return frame.evaluate(async url => {
    const { MemoryProfiler } = await import(url);
    const report = MemoryProfiler.snapshot();
    return {
      drawCalls: report.renderStats?.drawCalls ?? null,
      triangles: report.renderStats?.triangles ?? null,
      textureVramBytes: report.renderer?.estimatedTextureVramBytes ?? null,
      textureCount: report.renderer?.textures ?? null,
      gpu: report.gpu ?? null,
    };
  }, new URL(ENGINE_URL, page.url()).href);
}

/**
 * Waits until the engine has actually drawn something.
 *
 * `.viewer-controls` only says the player reported "running"; a scene that throws on its first frame would
 * still get there. Draw calls are the evidence that a frame reached the GPU.
 */
export async function waitForFrames(page: Page, timeout = 60_000): Promise<EngineSnapshot> {
  const frame = await playerFrame(page, timeout);
  const url = new URL(ENGINE_URL, page.url()).href;
  await frame.waitForFunction(
    async u => {
      const { MemoryProfiler } = await import(u);
      return (MemoryProfiler.snapshot().renderStats?.drawCalls ?? 0) > 0;
    },
    url,
    { timeout, polling: 500 },
  );
  return readEngineSnapshot(page);
}

/** The overlay's DOM node and the engine's view of it, read inside the frame. */
export async function profilerState(page: Page): Promise<{ element: boolean; visible: boolean; allowed: boolean }> {
  const frame = await playerFrame(page);
  return frame.evaluate(async url => {
    const { MemoryProfiler } = await import(url);
    return {
      element: document.getElementById('webengine-profiler') !== null,
      visible: MemoryProfiler.isOverlayVisible,
      allowed: MemoryProfiler.diagnosticsAllowed,
    };
  }, new URL(ENGINE_URL, page.url()).href);
}

/** Forces a context loss in the frame the way a driver reset would, via the GL extension. */
export async function loseWebGLContext(page: Page): Promise<boolean> {
  const frame = await playerFrame(page);
  return frame.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const gl = canvas?.getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_lose_context');
    if (!ext) return false;
    ext.loseContext();
    return true;
  });
}

export const MB = 1024 * 1024;
