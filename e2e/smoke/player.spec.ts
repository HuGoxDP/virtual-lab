// e2e/smoke/player.spec.ts
//
// OPS1, D-11: the scenario that plays is the scenario that renders. A page that
// loads a canvas is not a page that drew anything, so the check is the engine's
// own frame counter, observed *inside* the player frame.
//
// Why inside the frame and not one read from the test: three.js resets
// `renderer.info.render` at the start of every frame, so a count read from
// outside lands either before the frame's first draw call (0) or during it —
// a smoke that asserts on one such read is a coin toss, which was measured here
// on 2026-11-13 (three runs: pass, fail, fail, with the same code and the same
// stack). `waitForFrames` polls *in* the frame and only resolves once a nonzero
// count was actually observed, so the pass means the engine drew a frame.
//
// Read-only by construction: the only writes a page here makes are the viewer's
// telemetry, which `writes.ts` asserts.

import { expect, test } from "./writes";
import { readEngineSnapshot, waitForFrames } from "../helpers/engine";

test("a scenario renders in the player frame", async ({ page }) => {
  const list = await page.request.get("/api/catalog");
  const body = await list.json();
  const id = process.env.SMOKE_SCENARIO ?? body.scenarios[0].id;

  await page.goto(`/play/${id}`);
  await expect.poll(async () => (await page.frames()).some(f => f.url().includes("/player/")), {
    timeout: 30_000,
    message: "the player frame appeared",
  }).toBe(true);

  // The engine drew a frame (observed in-frame), and it named its renderer.
  await waitForFrames(page);
  const snapshot = await readEngineSnapshot(page);
  expect(snapshot.gpu, "the engine named its renderer").toBeTruthy();
});
