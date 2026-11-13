// e2e/smoke/health.spec.ts
//
// OPS1, D-11 (DW-3.2): the stack answers, and it is the release we deployed.
//
// `/api/health` carries `build.commit`, which the release compose sets from
// `VL_COMMIT` (research F-7). A smoke that only checked "200 ok" would pass
// against a stack that never took the new images — the rollback path's worst
// failure, because it looks healthy. So when `SMOKE_EXPECT_COMMIT` is set, the
// commit is part of the check.

import { expect, test } from "@playwright/test";

test("the stack is healthy and reports its build", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status(), "health answers 200").toBe(200);

  const body = await res.json();
  expect(body.status).toBe("ok");
  expect(body.db).toBe("connected");
  expect(body.build).toBeTruthy();
  expect(typeof body.build.version).toBe("string");
});

test("the deployed release is the expected commit", async ({ request }) => {
  const expected = process.env.SMOKE_EXPECT_COMMIT;
  const body = await (await request.get("/api/health")).json();
  const actual = body.build?.commit ?? null;

  if (!expected) {
    test.skip(true, "SMOKE_EXPECT_COMMIT is unset — the version is not pinned by this smoke");
    return;
  }
  // The message names both, because a red smoke is read by a human who has to
  // decide whether to roll back and needs to know what they would roll back from.
  expect(actual, `expected commit ${expected}, the stack reports ${actual}`).toBe(expected);
});

test("the catalog API is the public one, not an admin surface", async ({ request }) => {
  const res = await request.get("/api/catalog");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.scenarios), "the catalog lists scenarios").toBe(true);
  // An empty catalog is a red smoke with a message that says what to do about it.
  expect(
    body.summary.scenarios,
    "catalog is empty — publish the release first"
  ).toBeGreaterThan(0);
});
