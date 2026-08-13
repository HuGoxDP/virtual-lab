// e2e/tests/ktx2.spec.ts
//
// R2's runtime half — the part `npm run verify:ktx2` cannot reach.
//
// That script proves the textures in the archive are genuinely supercompressed.
// It cannot prove the browser transcoded them, and that failure is silent: a
// wrong `ktx2TranscoderPath` breaks neither the build nor any unit test, and the
// planets still render — just from RGBA8 at eight times the VRAM.
//
// The engine exposes no transcoded-format field (MemoryReport has none, and
// `TextureFormat` is the authoring enum), so the evidence is the VRAM figure.
// For Benchscene3 the two outcomes are far enough apart to be unambiguous:
//
//     transcoded to BC1/BC7  ≈  36 MB
//     RGBA8 fallback         ≈ 279 MB
//
// Both numbers come from the same arithmetic verify-ktx2.mjs prints.

import { expect, test } from '@playwright/test';
import { adminScenarios, updateScenario } from '../helpers/api';
import { MB, readEngineSnapshot, waitForFrames } from '../helpers/engine';

/** The only archive in the release that ships .ktx2 at all. */
const KTX2_SCENARIO = 'benchscene3-solarsystem';

/** Halfway between the two outcomes, in the wide gap where nothing should land. */
const FALLBACK_THRESHOLD_MB = 150;

test.describe('KTX2 textures', () => {
  let wasPublished = false;

  test.beforeAll(async () => {
    const rows = await adminScenarios();
    const row = rows.find(r => r.id === KTX2_SCENARIO);

    test.skip(!row, `${KTX2_SCENARIO} is not in the catalog — publish a release first.`);

    // Bench scenes are unpublished by policy, and the viewer resolves scenarios
    // through the *public* catalog. Publish it for the duration of this file.
    wasPublished = !!row!.isPublished;
    if (!wasPublished) await updateScenario(KTX2_SCENARIO, { isPublished: true });
  });

  test.afterAll(async () => {
    if (!wasPublished) await updateScenario(KTX2_SCENARIO, { isPublished: false });
  });

  test('the transcoder is served where the viewer points it', async ({ request }) => {
    // The engine's default is /basis/; Angular publishes assets under /assets/,
    // so ViewerComponent overrides the path. If that override is ever dropped,
    // this is the check that notices.
    for (const file of ['basis_transcoder.js', 'basis_transcoder.wasm']) {
      const res = await request.get(`/assets/basis/${file}`);
      expect(res.status(), `/assets/basis/${file} must be served`).toBe(200);

      // Measure the body, not Content-Length: nginx gzips these and answers
      // chunked, so the header is absent even on a perfectly good response.
      expect((await res.body()).length, `${file} should not be empty`).toBeGreaterThan(1000);
    }

    // The engine's own default must still 404 — if it ever starts resolving,
    // the override in ViewerComponent has quietly stopped being load-bearing
    // and this test would no longer be testing anything.
    expect((await request.get('/basis/basis_transcoder.js')).status()).toBe(404);
  });

  test('a scenario that loads .ktx2 transcodes it instead of expanding it', async ({ page }) => {
    // Benchscene3 is the heaviest scene in the release — an 8192x4096 skybox
    // plus eleven 2048x1024 textures, on a software rasteriser.
    test.setTimeout(300_000);

    // Fetching the transcoder is the tell. It is served over HTTP from
    // /assets/basis/, so a run that decodes even one .ktx2 must request it;
    // the textures themselves come out of the ZIP and never touch the network.
    const transcoderRequests: string[] = [];
    page.on('request', request => {
      if (request.url().includes('basis_transcoder')) transcoderRequests.push(request.url());
    });

    const consoleErrors: string[] = [];
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await page.goto(`/play/${KTX2_SCENARIO}`);
    await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 200_000 });

    await waitForFrames(page, 200_000);

    // Textures are decoded lazily, so let the scene settle before measuring.
    await page.waitForTimeout(3_000);
    const snapshot = await readEngineSnapshot(page);
    const vramMB = (snapshot.textureVramBytes ?? 0) / MB;

    console.log(
      `texture VRAM: ${vramMB.toFixed(1)} MB across ${snapshot.textureCount} textures ` +
      `on ${snapshot.gpu}; transcoder fetched: ${transcoderRequests.length > 0}`
    );

    // ── the self-activating part ──────────────────────
    //
    // Right now nothing in the release actually loads a .ktx2. Benchscene3 ships
    // twelve of them and its manifest lists them as assets, but `Scenario.js`
    // asks for `stars_panorama.jpg` and the planet materials do the same — so
    // the KTX2 files are carried and never referenced, and the transcoder is
    // never invoked. That is ScenarioCreator's to fix, not this platform's.
    //
    // Skipping rather than failing keeps this from being a permanently red test
    // for another repository's defect. Skipping rather than deleting means the
    // day a scenario does reference .ktx2, this assertion switches itself on.
    test.skip(
      transcoderRequests.length === 0,
      'No scenario in the catalog references .ktx2 yet — Benchscene3 ships them ' +
      'unreferenced and loads the .jpg originals, so the transcoder is never invoked. ' +
      'Fix belongs in ScenarioCreator; this check activates itself once it lands.'
    );

    expect(
      vramMB,
      `texture VRAM is ${vramMB.toFixed(1)} MB — at or above ${FALLBACK_THRESHOLD_MB} MB means ` +
      `the transcoder loaded but textures still fell back to RGBA8`
    ).toBeLessThan(FALLBACK_THRESHOLD_MB);

    const transcoderErrors = consoleErrors.filter(text => /basis|ktx2|transcod/i.test(text));
    expect(transcoderErrors, 'no transcoder errors expected').toHaveLength(0);
  });
});
