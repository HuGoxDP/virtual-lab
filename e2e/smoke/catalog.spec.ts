// e2e/smoke/catalog.spec.ts
//
// OPS1, D-11: what a student sees is up. The catalog page lists the deployed
// scenarios and opens one, and the engine bundle it loads is served `immutable`
// — a content-addressed path cached for a year is the whole point, and a
// deployment that breaks the cache header quietly wastes every student's first
// minute on a download they already had.
//
// The page is visited with the write recorder installed, so the assertions about
// what a *page* does (not just the API) hold for the requests it makes.

import { expect, test } from "./writes";
import { readEngineBuild } from "../helpers/engine";

test("the catalog page lists the deployed scenarios", async ({ page }) => {
  const res = await page.request.get("/api/catalog");
  const body = await res.json();
  expect(body.scenarios.length, "catalog is empty — publish the release first").toBeGreaterThan(0);

  await page.goto("/catalog");
  // The page reads the same list the API answered with.
  await expect(page.locator(".scenario-card, .cards > *").first()).toBeVisible();
  await expect(page).toHaveTitle(/Virtual Lab|Каталог/i);
});

test("a scenario page opens and its player frame plays", async ({ page }) => {
  const res = await page.request.get("/api/catalog");
  const body = await res.json();
  const id = process.env.SMOKE_SCENARIO ?? body.scenarios[0].id;

  await page.goto(`/scenario/${id}`);
  await expect(page.locator("h1.title")).toBeVisible();

  // The launch control, the same one the student golden path clicks.
  await page.locator(".side .launch").click();
  await expect(page).toHaveURL(new RegExp(`/play/${id}`));

  // The frame that runs the scenario, and inside it the engine that answers.
  await expect.poll(async () => (await page.frames()).some(f => f.url().includes("/player/")), {
    timeout: 30_000,
    message: "the player frame appeared",
  }).toBe(true);

  const build = await readEngineBuild(page);
  expect(build.version, "the player bundle reports a version").toMatch(/^\d+\.\d+\.\d+/);
});

test("the engine bundle is served with an immutable cache header", async ({ request }) => {
  const res = await request.get("/engine/0.2.0/WebEngineTS.standalone.js");
  expect(res.status()).toBe(200);
  expect(res.headers()["cache-control"] ?? "", "the content-addressed bundle is cached")
    .toMatch(/immutable/);
});
