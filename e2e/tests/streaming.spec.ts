// e2e/tests/streaming.spec.ts
//
// R8 / Phase 6 — does a scenario served as a manifest of individually-fetched
// files actually run, and is it faster to first frame than the same content
// served as one ZIP?
//
// This is the cheap proof the plan calls for: `StreamingAssetSource` takes any
// URL, so a directory of hashed files behind the existing nginx exercises the
// whole path — no `scenario_assets` table, no manifest endpoint, no viewer
// change. Design the schema after the path is known to work, not before.
//
// The comparison is meaningful because `Scenario.timeToFirstFrame` is reported
// by the engine on **both** paths, measured the same way from `run()`. Anything
// timed by the host instead would be comparing two different stopwatches.
//
// Requires the store to be populated:
//   cd backend && npm run import:assets

import { expect, test } from '@playwright/test';
import { BASE_URL } from '../helpers/api';
import { readEngineSnapshot, waitForFrames } from '../helpers/engine';

/** Where `import-release-assets.mjs` publishes manifests. */
const manifestUrl = (id: string) => `/a/${id}.json`;

interface RunResult {
  ok: boolean;
  error?: string;
  timeToFirstFrame: number;
  /** Draw calls at the moment of the first frame — before streaming finishes. */
  drawCallsAtFirstFrame: number;
  /** Draw calls once the scene has stopped changing. */
  drawCallsSettled: number;
  trianglesSettled: number;
  textureVramBytes: number;
  /** Live engine textures — driven by what loaded, not by what is on screen. */
  textureCount: number;
}

/**
 * Runs a scenario through the viewer (the sandboxed player) and reports what the engine measured.
 *
 * The page holds no engine any more, so the measurement is taken inside the player frame via the helpers
 * in engine.ts. `timeToFirstFrame` is the host's own stopwatch from navigation to the player reporting
 * "running" - the same on both paths, which is what the comparison needs.
 */
async function runScenario(
  page: import('@playwright/test').Page,
  how: { id: string; stream: boolean }
): Promise<RunResult> {
  const startedAt = Date.now();
  try {
    await page.goto(`/play/${how.id}${how.stream ? '?stream=1' : ''}`);
    await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 120_000 });
    const timeToFirstFrame = Date.now() - startedAt;
    const first = await waitForFrames(page, 120_000);

    // Wait for loading to stop. On the manifest path the remaining assets are still arriving here -
    // that is the whole design - so comparing at first frame would compare a half-loaded scene with a
    // complete one. Settle on the *asset* counters, not draw calls (this scene animates). Six seconds of
    // no change: the request queue is bounded, so a short stall looks exactly like "finished".
    let previous = '';
    let stableFor = 0;
    const settleBy = Date.now() + 180_000;
    while (stableFor < 24 && Date.now() < settleBy) {
      await page.waitForTimeout(250);
      const sample = await readEngineSnapshot(page);
      const current = `${sample.textureCount ?? 0}/${sample.textureVramBytes ?? 0}`;
      stableFor = current === previous ? stableFor + 1 : 0;
      previous = current;
    }
    const settled = await readEngineSnapshot(page);
    return {
      ok: true,
      timeToFirstFrame,
      drawCallsAtFirstFrame: first.drawCalls ?? 0,
      drawCallsSettled: settled.drawCalls ?? 0,
      trianglesSettled: settled.triangles ?? 0,
      textureVramBytes: settled.textureVramBytes ?? 0,
      textureCount: settled.textureCount ?? 0,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      timeToFirstFrame: -1,
      drawCallsAtFirstFrame: 0, drawCallsSettled: 0,
      trianglesSettled: 0, textureVramBytes: 0, textureCount: 0,
    };
  }
}

test.describe('streaming (manifest) scenario delivery', () => {
  test.beforeAll(async ({ request }) => {
    const res = await request.get(manifestUrl('molecules'));
    test.skip(
      !res.ok(),
      'Per-asset store is empty — run `cd backend && npm run import:assets` first.'
    );
  });

  test('the store serves manifests and objects with usable content types', async ({ request }) => {
    const res = await request.get(manifestUrl('molecules'));
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('application/json');

    const manifest = await res.json();

    // `scripts` + `entry` are what make a manifest runnable; one listing only
    // assets is a valid asset source but not a scenario.
    expect(manifest.entry, 'a runnable manifest needs an entry').toBeTruthy();
    expect(manifest.scripts?.length, 'a runnable manifest needs scripts').toBeGreaterThan(0);

    // Assets are addressed by `path` (+ optional `guid`) — *not* by an `id`, as
    // scenario-delivery-migration.md §3.1 sketches. That sketch predates the
    // engine and `parseStreamingManifest` rejects the shape it describes.
    for (const asset of manifest.assets ?? []) {
      expect(asset.path, 'assets are addressed by path').toBeTruthy();
      expect(asset).not.toHaveProperty('id');
    }

    // URLs are relative to the manifest's own directory — the engine joins them
    // onto it as a string rather than resolving them, so an absolute URL here
    // would be a bug, not a convenience.
    const entry = manifest.scripts.find((s: any) => s.path === manifest.entry);
    expect(entry.url, 'asset URLs must stay relative to the manifest').not.toMatch(/^[/a-z]+:|^\//);

    // A module served as application/zip is refused by the browser, which is
    // why /a/ does not force one type the way /scenarios/ does.
    const script = await request.get(`/a/${entry.url}`);
    expect(script.status()).toBe(200);
    expect(script.headers()['content-type']).toContain('javascript');

    // Objects are content-addressed, so they may be cached forever; the
    // manifest is named for the scenario and may not.
    expect(script.headers()['cache-control']).toContain('immutable');
    expect(res.headers()['cache-control']).toContain('no-cache');
  });

  test.describe('the viewer opts in, rather than defaulting', () => {
    /** Which URLs the page fetched, so the delivery path is observable. */
    function trackRequests(page: import('@playwright/test').Page) {
      const urls: string[] = [];
      page.on('request', r => urls.push(r.url()));
      return {
        usedManifest: () => urls.some(u => /\/a\/[^/]+\.json$/.test(u)),
        usedZip: () => urls.some(u => u.includes('/scenarios/') && u.endsWith('.zip')),
      };
    }

    test('the catalog advertises the manifest', async ({ request }) => {
      const detail = await (await request.get(`${BASE_URL}/api/catalog/molecules`)).json();
      expect(detail.manifestUrl, 'an imported scenario should advertise its manifest')
        .toBe(manifestUrl('molecules'));
      expect(detail.scenarioUrl, 'and keep its archive').toContain('/scenarios/');
    });

    test('without ?stream=1 it still downloads the ZIP', async ({ page }) => {
      const seen = trackRequests(page);

      await page.goto('/play/molecules');
      await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 80_000 });

      expect(seen.usedZip(), 'the default path must stay the archive').toBe(true);
      expect(seen.usedManifest(), 'the manifest must not be fetched by default').toBe(false);
    });

    test('with ?stream=1 it loads from the manifest instead', async ({ page }) => {
      const seen = trackRequests(page);

      await page.goto('/play/molecules?stream=1');
      await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 80_000 });

      expect(seen.usedManifest(), 'the flag should select the manifest').toBe(true);
      expect(seen.usedZip(), 'and skip the archive entirely').toBe(false);

      // The player restarts any source in a fresh frame, so a streamed run can restart too.
      await expect(page.getByRole('button', { name: 'Спочатку' })).toBeEnabled();
    });

    test('?stream=1 falls back to the ZIP when there is no manifest', async ({ page, request }) => {
      const setManifest = (value: string | null) => request.fetch(
        `${BASE_URL}/api/catalog/optics-lenses`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${process.env.ADMIN_TOKEN}`,
            'Content-Type': 'application/json',
          },
          data: { manifestUrl: value },
        }
      );

      // Withdrawing a manifest must not strand a scenario: the row keeps its
      // archive, and the flag then has nothing to select.
      await setManifest(null);

      try {
        const seen = trackRequests(page);

        await page.goto('/play/optics-lenses?stream=1');
        await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 80_000 });

        expect(seen.usedZip(), 'it should fall back to the archive').toBe(true);
      } finally {
        // Shared catalog: leaving it withdrawn would silently change what every
        // later run of this file is testing.
        await setManifest(manifestUrl('optics-lenses'));
      }
    });
  });

  test('a script-only scenario runs from a manifest', async ({ page }) => {
    test.setTimeout(180_000);
    const result = await runScenario(page, { id: 'molecules', stream: true });

    expect(result.error ?? '', 'manifest load should not throw').toBe('');
    expect(result.ok, 'the scenario should reach its first frame').toBe(true);
    expect(result.drawCallsSettled, 'the scenario should draw').toBeGreaterThan(0);

    console.log(
      `molecules (manifest): first frame ${result.timeToFirstFrame} ms, ` +
      `${result.drawCallsSettled} draw calls`
    );
  });

  // Two full runs of a 17 MB scene on a software rasteriser, while Docker runs
  // beside it. That is a measurement, not a pure function, and it is honest to
  // allow one retry rather than to pretend otherwise — the assertions below are
  // all equivalence checks, so a retry cannot turn a real failure green.
  test.describe.configure({ retries: 1 });

  test('an asset-heavy scenario renders the same scene from a manifest as from its ZIP', async ({ page, request }) => {
    test.setTimeout(600_000);

    const detail = await (await request.get(`${BASE_URL}/api/catalog/solar-system`)).json();
    const zipUrl: string = detail.scenarioUrl;
    expect(zipUrl, 'solar-system should have a stored archive').toBeTruthy();

    // ZIP first: it warms nothing the manifest run benefits from, since the two
    // fetch entirely different URLs.
    const zip = await runScenario(page, { id: 'solar-system', stream: false });
    expect(zip.error ?? '', 'ZIP load should not throw').toBe('');
    expect(zip.ok, 'the ZIP run should reach its first frame').toBe(true);

    const streamed = await runScenario(page, { id: 'solar-system', stream: true });
    expect(streamed.error ?? '', 'manifest load should not throw').toBe('');
    expect(streamed.ok, 'the streamed run should reach its first frame').toBe(true);
    expect(streamed.drawCallsSettled, 'the streamed run should draw').toBeGreaterThan(0);

    console.log(
      `solar-system — first frame: ZIP ${zip.timeToFirstFrame} ms, ` +
      `manifest ${streamed.timeToFirstFrame} ms ` +
      `(${(zip.timeToFirstFrame / streamed.timeToFirstFrame).toFixed(2)}x)\n` +
      `  draw calls at first frame: ZIP ${zip.drawCallsAtFirstFrame}, ` +
      `manifest ${streamed.drawCallsAtFirstFrame}\n` +
      `  draw calls settled:        ZIP ${zip.drawCallsSettled}, ` +
      `manifest ${streamed.drawCallsSettled}\n` +
      `  textures / VRAM:           ZIP ${zip.textureCount} / ` +
      `${(zip.textureVramBytes / 1048576).toFixed(1)} MB, ` +
      `manifest ${streamed.textureCount} / ` +
      `${(streamed.textureVramBytes / 1048576).toFixed(1)} MB`
    );

    // Same scene either way. This is the guarantee the platform can actually
    // make: swapping the delivery mechanism must not change what is rendered.
    expect(
      streamed.textureCount,
      'both paths should end up with the same textures loaded'
    ).toBe(zip.textureCount);

    // Draw calls get only a loose floor, not a tolerance. The scene animates,
    // so the sample lands at an arbitrary point in the orbit and frustum
    // culling moves the count — the ZIP path alone reported 25, 26 and 27 for
    // the same scene, and a ±4 window still failed under load. What is worth
    // catching is a streamed run that rendered almost nothing; the texture
    // count above is the assertion that the same content arrived.
    expect(
      streamed.drawCallsSettled,
      `the streamed scene barely drew: ZIP ${zip.drawCallsSettled}, ` +
      `manifest ${streamed.drawCallsSettled}`
    ).toBeGreaterThan(zip.drawCallsSettled * 0.5);

    // **Deliberately not asserted: that the manifest path reaches its first
    // frame sooner.** On this hardware the measurement will not support it.
    //
    // Two runs of the identical pair gave ZIP 1600 ms / manifest 1764 ms, then
    // ZIP 2106 ms / manifest 1654 ms — a 30% spread that swamps the effect being
    // looked for. Under SwiftShader, first-frame time is dominated by shader
    // compilation and software rasterisation, not by how the bytes arrived.
    //
    // The one stable observation across runs is that the streamed path is not
    // consistently ahead, which fits what the draw-call counts show: nothing was
    // deferred. solar-system's manifest does carry differentiated priorities
    // (1 critical, 6 high, 11 low), so the deferral has to be declined by the
    // scenario's own code loading everything before it first renders. Until
    // scenario code tolerates a late asset, this is a delivery change rather
    // than a latency one — and proving a latency win needs a real GPU.
    //
    // So bound it against a fixed ceiling, not against the ZIP run. A ratio
    // makes the assertion depend on how loaded the machine was during the
    // *other* run, which is how this failed intermittently in a full-suite pass
    // and passed on its own minutes later. An absolute limit still catches
    // something pathological without encoding the noise.
    expect(
      streamed.timeToFirstFrame,
      `streamed first frame took ${streamed.timeToFirstFrame} ms`
    ).toBeLessThan(60_000);

    // Recorded, not yet explained: the manifest path holds ~2.9x the texture
    // memory of the ZIP path for the same 19 textures — 269.8 MB against
    // 92.8 MB, reproducible across runs. Every solar-system asset has exactly
    // one LOD, so it is not a retained ladder, and the counts match exactly.
    //
    // It matters because it is the opposite of what a VRAM budget assumes, and
    // it is an engine-side behaviour this repo can measure but not diagnose.
    // Asserting only the direction keeps a regression visible without pinning a
    // number nobody has justified yet.
    expect(
      streamed.textureVramBytes,
      'streamed texture memory should not exceed the ZIP path by more than 4x'
    ).toBeLessThan(zip.textureVramBytes * 4);
  });
});
