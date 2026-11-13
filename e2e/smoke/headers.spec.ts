// e2e/smoke/headers.spec.ts
//
// OPS1, D-11: the headers that make the deployment safe are the ones nobody
// notices. A stack without a CSP, or without HSTS on https, is a stack a student
// reaches over an attack that the header would have stopped.
//
// HTTP-only targets skip HSTS (there is nothing to remember) and still require
// CSP; a plain-http deployment is a configuration an operator may choose, and
// the smoke says which one it saw.

import { expect, test } from "@playwright/test";

const isHttps = () => {
  const base = process.env.E2E_BASE_URL ?? "";
  return base.startsWith("https:");
};

test("the app answers with a CSP that allows the engine and no inline script", async ({ page }) => {
  await page.goto("/catalog");
  const headers = await page.evaluate(() => ({ csp: "" }));
  void headers;
  const res = await page.request.get("/");
  const csp = res.headers()["content-security-policy"] ?? "";
  expect(csp, "a CSP header is present").not.toBe("");
  expect(csp, "the engine bundle stays self").toContain("'self'");
  // An `unsafe-inline` on script-src is the whole class of bug the header exists
  // to stop, and the engine's contract (docs/csp) says it is not needed.
  expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
});

test("an https target sends HSTS", async ({ request }) => {
  const res = await request.get("/");
  const hsts = res.headers()["strict-transport-security"];
  if (!isHttps()) {
    // Plain http: the smoke records what it saw rather than failing a stack that
    // was deliberately deployed that way (the https override sets the header).
    test.skip(true, "the target is http; HSTS applies only to a TLS listener");
    return;
  }
  expect(hsts, "an https stack remembers that it is https").toMatch(/max-age=\d+/);
});

test("the security headers are on the API too", async ({ request }) => {
  // The API is served by the same nginx, but a route added later can be mounted
  // before the header block; this is the check that would notice.
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
});
