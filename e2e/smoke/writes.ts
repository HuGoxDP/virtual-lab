// e2e/smoke/writes.ts
//
// The recorder that makes "read-only" a fact rather than a claim (OPS1, D-11).
//
// A spec installs it with `recordWrites(page)`; the fixture listens to every
// request the page makes, keeps the ones whose method is not GET or HEAD, and on
// teardown fails the test for any that are not on the allow-list — and lists the
// allow-listed ones it did see, so a reader can tell what changed.
//
// The allow-list is the viewer's own telemetry, which a page it plays cannot help
// writing (`frontend/src/app/services/telemetry.service.ts`: `POST /api/telemetry/session`
// and `POST /api/telemetry/session/:id/end`). It is a default, overridable by
// `SMOKE_WRITE_ALLOW` (comma-separated `METHOD /path` entries), because a deployment
// that has a write a smoke legitimately makes should not require a code change.

import { test as base, expect } from "@playwright/test";

/** The viewer's telemetry, the only writes a read-only page must be able to make. */
export const DEFAULT_WRITE_ALLOW = [
  "POST /api/telemetry/session",
  "POST /api/telemetry/session/",
];

/** `METHOD /path` from the environment, or the default allow-list. */
export function allowList() {
  const raw = process.env.SMOKE_WRITE_ALLOW;
  if (!raw) return DEFAULT_WRITE_ALLOW;
  return raw.split(",").map(entry => entry.trim()).filter(Boolean);
}

/** Does `METHOD /path` carry an allowed prefix? */
function isAllowed(method, path, allowed) {
  const label = `${method.toUpperCase()} ${path}`;
  return allowed.some(prefix => label.startsWith(prefix));
}

/**
 * Extend `test` with the write recorder: the page's non-GET requests are
 * collected, and the test fails if one of them is outside the allow-list.
 *
 * `auto: true` matters: a fixture only runs when a test asks for it, so a spec
 * that forgets to destructure `writes` would silently lose the check — which is
 * exactly the failure DW-3.3 was written to catch, and it did (the first version
 * of this file had no `auto` and a deliberate POST passed).
 */
export const test = base.extend<{ writes: { seen: () => string[]; allowed: () => string[] } }>({
  writes: [async ({ page }, use) => {
    const recorded: string[] = [];
    page.on("request", request => {
      const method = request.method().toUpperCase();
      if (method === "GET" || method === "HEAD") return;
      const { pathname } = new URL(request.url());
      recorded.push(`${method} ${pathname}`);
    });

    const fixture = {
      seen: () => recorded,
      allowed: () => recorded.filter(entry => isAllowed(entry.split(" ")[0], entry.split(" ")[1] ?? "", allowList())),
    };
    await use(fixture);

    const allowed = allowList();
    // eslint-disable-next-line no-unreachable
    const refused = recorded.filter(entry => !isAllowed(entry.split(" ")[0], entry.split(" ")[1] ?? "", allowed));
    if (refused.length > 0) {
      // Named in the failure so the operator can add to the allow-list knowingly.
      expect(
        refused,
        `the smoke wrote to a route outside the allow-list: ${refused.join(", ")}`
      ).toEqual([]);
    }
  }, { auto: true }],
});

export { expect };
