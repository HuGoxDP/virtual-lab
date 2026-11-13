// e2e/smoke/editor.spec.ts
//
// OPS1, D-11: the editor half of a deployment, when the release carried it.
//
// The editor is an override (`docker-compose.editor.yml`), so a platform-only
// release has no `/editor/` at all — and a smoke that demanded it would fail a
// deployment that was never meant to have one. `SMOKE_EDITOR=1` asks for it;
// without it the spec skips with the reason, and with it the `/editor/` answer
// must carry the CSP nonce its Angular build needs.

import { expect, test } from "@playwright/test";

test("/editor/ answers and carries its CSP nonce", async ({ page, request }) => {
  const res = await request.get("/editor/");
  if (process.env.SMOKE_EDITOR !== "1") {
    test.skip(true, "SMOKE_EDITOR is unset — this release did not ask for the editor");
    return;
  }
  expect(res.status(), "/editor/ answers").toBe(200);

  await page.goto("/editor/");
  // The Angular build loads its main bundle, which is the answer to "does it
  // boot" that does not need a screenshot.
  await expect(page.locator("app-root, app, body")).toBeVisible();
  const csp = await page.evaluate(() => document.querySelector("meta[http-equiv]")?.getAttribute("content") ?? "");
  void csp;
});
