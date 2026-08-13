// e2e/helpers/engine.ts
//
// Reads the engine's own instrumentation from inside the page.
//
// The trick that makes this possible: `index.html` carries an import map
// pointing "WebEngineTS" at /assets/WebEngineTS.standalone.js, and an import map
// applies to dynamic imports in the main world too. So a test can
// `await import('WebEngineTS')` and hold the very same module instance the app
// is using — no test hook in production code, and nothing hung off `window`.
//
// This matters because the alternative for "did it render?" is screenshot
// diffing, which under SwiftShader is both slow and flaky. `drawCalls` from the
// engine's own profiler is a direct answer.

import type { Page } from '@playwright/test';

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

/** What the engine bundle in this page calls itself. */
export async function readEngineBuild(page: Page): Promise<EngineBuild> {
  return page.evaluate(async () => {
    const { BuildInfo } = await import('WebEngineTS');
    return { version: BuildInfo.version, builtAt: BuildInfo.builtAt, isBuild: BuildInfo.isBuild };
  });
}

/**
 * One `MemoryProfiler` sample.
 *
 * Note this does **not** open the profiler overlay: `snapshot()` is a plain
 * read, so it does not create the rAF loop the overlay owns and cannot perturb
 * what it is measuring.
 */
export async function readEngineSnapshot(page: Page): Promise<EngineSnapshot> {
  return page.evaluate(async () => {
    const { MemoryProfiler } = await import('WebEngineTS');
    const report = MemoryProfiler.snapshot();

    return {
      drawCalls: report.renderStats?.drawCalls ?? null,
      triangles: report.renderStats?.triangles ?? null,
      textureVramBytes: report.renderer?.estimatedTextureVramBytes ?? null,
      textureCount: report.renderer?.textures ?? null,
      gpu: report.gpu ?? null,
    };
  });
}

/**
 * Waits until the engine has actually drawn something.
 *
 * `state() === 'running'` only says the scenario was handed to the engine; a
 * scene that throws on its first frame would still get there. Draw calls are
 * the evidence that a frame reached the GPU.
 */
export async function waitForFrames(page: Page, timeout = 60_000): Promise<EngineSnapshot> {
  await page.waitForFunction(
    async () => {
      const { MemoryProfiler } = await import('WebEngineTS');
      return (MemoryProfiler.snapshot().renderStats?.drawCalls ?? 0) > 0;
    },
    undefined,
    { timeout, polling: 500 }
  );

  return readEngineSnapshot(page);
}

/** Forces a context loss the way a driver reset would, via the GL extension. */
export async function loseWebGLContext(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas.webgl-canvas') as HTMLCanvasElement | null;
    const gl = canvas?.getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_lose_context');
    if (!ext) return false;
    ext.loseContext();
    return true;
  });
}

export const MB = 1024 * 1024;
