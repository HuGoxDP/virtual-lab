# Virtual Lab — Test Plan

Scope: everything delivered in plan phases 0–4 (`docs/implementation-plan.md`), against the
working tree at 2026-08-01. This document defines **what must be tested, at which level, and what
counts as passing**. Executing it is Phase 5.

Today the repository has **zero automated tests**. Everything below was verified once, manually,
against a running stack; that is exactly the state this plan exists to replace. Where a behaviour
could not be verified without a browser, it is marked ⚠ and listed in §7.

---

## 1. Inventory of what must be covered

### 1.1 Backend (`backend/`)

| # | Feature | Where |
|---|---|---|
| B1 | Catalog read: published-only, category/`q` filter, `limit`/`offset`, `total`, categories | `server.js` `GET /api/catalog` |
| B2 | Single scenario read, published-only | `GET /api/catalog/:id` |
| B3 | Admin list: all rows incl. unpublished, storage + manifest metadata | `GET /api/admin/scenarios` |
| B4 | Catalog CRUD with partial update semantics | `POST`/`PUT`/`DELETE /api/catalog` |
| B5 | `requireAdmin`: bearer token, timing-safe compare, 401/403/503 | `server.js` |
| B6 | Download proxy addressed by scenario id; legacy flag | `GET /api/proxy-download` |
| B7 | Proxy hardening: per-hop allowlist, redirect cap, header timeout, size cap, content-type | `fetchAllowlisted`, `streamUpstreamToClient` |
| B8 | Rate limiting (proxy, telemetry) | `proxyLimiter`, `telemetryLimiter` |
| B9 | Content-addressed storage: hash, commit-by-rename, dedup, temp cleanup | `storage.js` |
| B10 | Archive validation: ZIP, manifest, required fields, entry point, id-mismatch warning | `archive-validation.js` |
| B11 | Archive upload (multipart) and import-from-source | `POST /api/scenarios/:id/archive[/import]` |
| B12 | Migration runner: ordering, idempotence, advisory lock, transactional failure | `migrations.js` |
| B13 | Telemetry: start, idempotent end, server-computed clamped duration, admin summary | `POST/GET /api/telemetry/*` |
| B14 | Resilience: `pool.on('error')`, graceful shutdown, health check | `server.js` |

### 1.2 Frontend (`frontend/src/app/`)

| # | Feature | Where |
|---|---|---|
| F1 | Catalog state: paging, append vs replace, `total`/`hasMore`, error reset | `services/scenario.service.ts` |
| F2 | Category mapping: API categories + icon lookup + default, "all" prepended | `scenario.service.ts` |
| F3 | Download URL resolution: local path direct, external → `?id=` | `resolveDownloadUrl` |
| F4 | Download with progress + abort mid-stream | `downloadScenarioZip` |
| F5 | Viewer state machine: `idle→downloading→loading-engine→running` / `error` / `unsupported` | `viewer.component.ts` |
| F6 | `loadToken` guard: a superseded load cannot overwrite a newer one | `viewer.component.ts` |
| F7 | WebGL2 probe, context-loss handling | `viewer.component.ts` |
| F8 | Restart from in-memory buffer (no re-download) | `restart()` |
| F9 | Catalog UI: debounced search, load-more, placeholder fallback | `catalog.component.ts` |
| F10 | Modal a11y: focus trap, Esc, focus restore | `onModalKeydown`, `openModal`/`closeModal` |
| F11 | Theme persisted and applied to `<html>` | `catalog.component.ts` |
| F12 | Admin: token in `sessionStorage`, list/create/edit/publish/delete, upload progress | `admin.component.ts`, `admin.service.ts` |
| F13 | Telemetry client: client id, start on running, end via `sendBeacon` | `telemetry.service.ts` |

### 1.3 Infrastructure

| # | Feature | Where |
|---|---|---|
| I1 | nginx: SPA fallback, `^~ /scenarios/` precedence over the `.zip` regex | `nginx/nginx.conf` |
| I2 | Cache policy: `no-cache` on index.html, single immutable header on assets | `nginx/nginx.conf` |
| I3 | Security headers present on all three location types | `nginx/nginx.conf` |
| I4 | Body size limit, proxy timeouts | `nginx/nginx.conf` |
| I5 | Compose: healthchecks, dependency ordering, volume wiring (rw backend / ro frontend) | `docker-compose.yml` |
| I6 | Build hygiene: `.dockerignore` keeps host `node_modules` out of the image | `.dockerignore` |
| I7 | Secrets: `.env` untracked and ignored, `.env.example` has placeholders only | `.gitignore` |

---

## 2. Test levels and tooling

| Level | Tool | Runs against | Owns |
|---|---|---|---|
| **Unit** | `vitest` (frontend, already a devDependency), `node:test` (backend) | Pure functions, no I/O | F1–F4, F6, F9–F11, F13, B7 helpers, B9 hashing, B10 |
| **Integration** | `supertest` + a disposable Postgres | Express + real DB, no browser | B1–B6, B8, B11–B14 |
| **Component** | `vitest` + `jsdom` + Angular `TestBed` | Components with mocked services | F5, F7, F8, F12 |
| **System (E2E)** | Playwright against `docker compose up` | The whole stack in a real browser | The ⚠ items in §7, plus the two golden paths |
| **Static** | `tsc --noEmit`, `ng build`, `nginx -t` | Sources and config | Type safety, budgets, nginx syntax |

### 2.1 Prerequisites to fix before writing tests

1. `angular.json` declares `"test": { "builder": "@angular/build:unit-test" }` **with no options**;
   it has never run. Configure the runner against the existing `tsconfig.spec.json`.
2. The backend has no test script and no dev dependencies. Add `supertest` and a
   `docker-compose.test.yml` (or testcontainers) giving each run a throwaway database.
3. `server.js` starts listening on import. Export the `app` so `supertest` can drive it without
   binding a port, keeping `bootstrap()` for the real entry point.

### 2.2 Coverage targets

| Area | Line target | Rationale |
|---|---|---|
| `archive-validation.js`, `storage.js`, `migrations.js` | 90% | Pure-ish logic guarding data integrity; cheap to cover |
| `server.js` route handlers | 80% | Every status code in §4 must be exercised |
| `scenario.service.ts`, `telemetry.service.ts`, `admin.service.ts` | 85% | No DOM needed |
| Components | 60% | State machine and guards, not markup |
| Overall | 75% | Gate in CI |

---

## 3. Test data

- **`fixtures/valid-scenario.zip`** — `manifest.json` with all required fields plus
  `scripts/Scenario.js`. Build it in a fixture helper rather than committing a binary.
- **`fixtures/no-manifest.zip`**, **`invalid-json.zip`**, **`missing-fields.zip`**,
  **`missing-entrypoint.zip`**, **`not-a-zip.bin`**, **`zip-with-nested-manifest.zip`**
  (`sub/manifest.json` only — must be rejected, the manifest has to be at the root).
- **Seed**: 3 published + 2 unpublished scenarios across 2 categories, so paging, filtering and
  the published/unpublished split are all observable.

---

## 4. Test scenarios

Legend: **[U]** unit · **[I]** integration · **[C]** component · **[E]** E2E.

### 4.1 Catalog read (B1, B2, F1, F2)

**Happy path**
1. [I] `GET /api/catalog` → 200, only published rows, `total` equals their count.
2. [I] Response carries `categories` = distinct published categories, sorted by label.
3. [I] `?limit=2&offset=0` and `?limit=2&offset=2` return disjoint sets covering the page,
   stably across repeated calls (regression for §6.2).
4. [I] `?category=astronomy` narrows `scenarios` and `total` but **not** `categories`.
5. [I] `?q=соняч` matches case-insensitively on title and on description.
6. [U] `ScenarioService.loadCatalog` replaces the held list; `loadMore` appends.

**Edge cases**
7. [I] `?limit=5000` → applied limit is 100; `?limit=0`, `?limit=-1`, `?limit=abc` → default 24.
8. [I] `?offset` beyond `total` → empty `scenarios`, `total` unchanged.
9. [I] `?q=` with only whitespace behaves as no filter.
10. [I] `?q=%` and `?q=_` are treated as literal text, not `ILIKE` wildcards (regression for
    §6.1).
11. [I] `?category=all` is treated as "no filter".
12. [U] `hasMore` is false when `scenarios.length === total`, true otherwise; `loadMore` is a
    no-op while `loading` is true (no double-append on a fast double click).
13. [U] A failed **append** keeps the already-loaded page; a failed **first** page clears it.
14. [U] Unknown category key falls back to the 📁 icon rather than rendering `undefined`.
15. [I] `GET /api/catalog/:id` for an unpublished row → 404 (not 200).
16. [I] Id containing spaces / `%` / `/`, URL-encoded → resolves to the right row.

### 4.2 Authentication (B5)

17. [I] No `Authorization` header → 401 on `POST`, `PUT`, `DELETE`, `/api/admin/scenarios`,
    `/api/telemetry/summary`, both archive endpoints.
18. [I] `Authorization: Bearer <wrong>` → 403.
19. [I] Correct token → 2xx.
20. [I] Header without the `Bearer ` prefix → 401.
21. [I] Token of the correct value but different length → 403, no crash
    (`timingSafeEqual` throws on length mismatch; the length guard must catch it).
22. [I] `ADMIN_TOKEN` unset → 503 on every admin route, while `GET`s stay 200.
23. [I] All `GET /api/catalog*` remain public with no header.

### 4.3 Download proxy (B6, B7, B8, F3)

24. [I] `?url=…` (the old parameter) → 400. The open-relay regression test.
25. [I] `?id=<unknown>` → 404; `?id=<unpublished>` → 404.
26. [I] `?id=<drive row>` with a stubbed upstream → 200, body relayed, `Content-Length` preserved.
27. [U] Redirect to an off-allowlist host → 403 and **no** request to that host.
28. [U] Redirect chain longer than 5 hops → 502.
29. [U] Redirect without a `Location` header → 502.
30. [U] Upstream `Content-Type: text/html` on the final response → 502 (a login page must never be
    relayed as an archive).
31. [U] Upstream larger than `MAX_ARCHIVE_BYTES` → stream aborted, connection destroyed; the
    partial file is **not** committed to storage.
32. [U] Upstream that stalls before headers → aborted at the header timeout; a slow but progressing
    **body** is *not* aborted (regression: an `AbortSignal.timeout` over the whole request would
    kill legitimate multi-minute downloads).
33. [I] `LEGACY_DRIVE_PROXY=false` → 410 for every request.
34. [I] Exceeding `PROXY_RATE_LIMIT` → 429 with `RateLimit-*` headers.
35. [U] `resolveDownloadUrl`: `/scenarios/x.zip` → unchanged; `https://drive…` → `?id=<catalog id>`,
    with the id URL-encoded.

### 4.4 Storage and archives (B9, B10, B11)

36. [I] Upload a valid ZIP → 201, `sha256` matches the file, object stored as `<sha256>.zip`,
    row updated to `storage_kind='local'` with `manifest_id`.
37. [I] Upload identical content again → `deduplicated: true`, still one object on disk.
38. [I] Upload to an unknown scenario → 404 **and the temp file is removed** (regression: an early
    `return` inside `try` leaked it until cleanup moved to `finally`).
39. [I] Each invalid fixture → 400 with its specific message, nothing added to `objects/`.
40. [U] Manifest id ≠ catalog id → `warnings` non-empty, upload still **succeeds** (regression: the
    original spec would have rejected every real archive).
41. [U] ZIP signature check accepts `PK\x03\x04`, `PK\x05\x06`, `PK\x07\x08`; rejects a text file
    renamed to `.zip`.
42. [I] Upload exceeding multer's `fileSize` → 413/400, no temp file left behind.
43. [I] `…/archive/import` on a row already `local` → 409.
44. [I] `…/archive/import` on a row with empty `scenario_url` → 400.
45. [U] `cleanStaleTemp` removes files older than the cutoff and leaves fresh ones (an in-flight
    upload must survive a concurrent sweep).
46. [I] Bytes served from `/scenarios/<sha>.zip` hash back to `<sha>`.

### 4.5 Migrations (B12)

47. [I] Fresh database → all migrations applied in filename order, recorded in `schema_migrations`.
48. [I] Second start → "Schema up to date", no statements re-run.
49. [I] A migration that raises → transaction rolled back, **not** recorded, process exits non-zero.
50. [I] Two backends starting simultaneously → the advisory lock serialises them; each migration is
    applied exactly once.
51. [I] Every migration is idempotent on its own (re-runnable against an already-migrated schema).

### 4.6 Telemetry (B13, F13)

52. [I] `POST /api/telemetry/session` with a known scenario → 201 and a `sessionId`.
53. [I] Unknown scenario → 404; missing `scenarioId` → 400.
54. [I] Malformed `clientId` → accepted with `client_id = NULL` (never rejected — telemetry must not
    block playback).
55. [I] `…/end` → 204 and `duration_ms` ≈ elapsed server time, `ended_at` set.
56. [I] Replaying `…/end` → 204 with `duration_ms` **unchanged** (the `WHERE ended_at IS NULL`
    guard is what makes this idempotent).
57. [I] `…/end` with a non-numeric or negative id → 400; unknown id → 204, no row touched.
58. [U] Duration is clamped to `MAX_SESSION_MS`; a session opened long ago cannot report 40 hours.
59. [I] Deleting a scenario leaves its sessions intact (no FK, by design).
60. [I] `GET /api/telemetry/summary` → per-scenario launches, completed, unique clients, **median**
    duration; admin-only.
61. [I] `?days=0`, `?days=-5`, `?days=9999` clamp to 1…365.
62. [U] `TelemetryService.startSession` closes a previous session first.
63. [U] A telemetry failure never throws into the caller (offline must still play).
64. [C] Session starts only when the viewer reaches `running`, not on `downloading` — a failed load
    must not count as a launch.

### 4.7 Viewer (F5–F8)

65. [C] Successful path drives `downloading → loading-engine → running`.
66. [C] Lookup failure → `error` with "Сценарій не знайдено"; a row with no archive →
    a distinct message.
67. [C] Progress callbacks update `progressPercent`; the value is observable through the signal
    (regression: field mutation under zoneless never repainted).
68. [C] `percent: -1` (unknown `Content-Length`) is normalised to 0, never rendered as `-1%`.
69. [C] Navigating to a second scenario mid-load: the first load's late resolution does **not**
    overwrite the second's state (`loadToken`).
70. [C] `ngOnDestroy` aborts the download, disposes the engine, ends the session and removes both
    window listeners.
71. [C] No WebGL2 → `unsupported`, and `new Application()` is never called.
72. [C] `webglcontextlost` → `contextLost` true, `app.stop()` called, `canRestart` false.
73. [C] `restart()` re-runs `loadScenarioFromBuffer` and issues **no** new network request.
74. [U] `ringOffset` = 264 at 0% and 0 at 100%.

### 4.8 Catalog UI and a11y (F9–F11)

75. [C] Typing fires **one** request after the debounce window, not one per keystroke.
76. [C] Changing category resets paging to offset 0.
77. [C] Image error → placeholder; a failing placeholder does not loop.
78. [E] Card is reachable by Tab and activates on Enter and Space.
79. [E] Modal open moves focus into the dialog; Tab cycles within it; Shift+Tab from the first
    element wraps to the last; Esc closes; focus returns to the originating card.
80. [C] Theme persists across reload and toggles `dark-theme` on `<html>`.

### 4.9 Admin (F12)

81. [C] No token → gate shown; valid token → list loads.
82. [C] A 401/403 from the API clears the stored token and returns to the gate.
83. [C] Token is written to `sessionStorage`, never `localStorage`.
84. [C] Upload reports progress and then hash/size; a mismatch warning is surfaced.
85. [C] Delete asks for confirmation and does nothing when declined.
86. [C] Create requires id, title, category, categoryLabel; id is immutable while editing.
87. [I] Publish toggle round-trip: hidden row absent from `/api/catalog`, present in
    `/api/admin/scenarios`.

### 4.10 Infrastructure (I1–I7)

88. [E] `/scenarios/<sha>.zip` is served by nginx with `immutable`; `^~` beats the `.zip` regex.
89. [E] `/` and any SPA route → `Cache-Control: no-cache`; hashed asset → exactly **one**
    `Cache-Control` header (regression: `expires` + `add_header` emitted two).
90. [E] All three security headers present on `/`, on `/index.html` and on a hashed asset — nginx
    does not inherit `add_header` into a location that declares its own.
91. [E] Range request on an archive → 206.
92. [E] Upload larger than `client_max_body_size` → 413 from nginx, not a hung request.
93. [I] Compose: `frontend` waits for `backend` healthy; the archives volume is rw in `backend`
    and ro in `frontend` (a write from nginx's container must fail).
94. [Static] `docker compose build frontend` transfers a context of kilobytes, not the
    `node_modules` tree.
95. [Static] `git ls-files` contains no `.env`; `.env.example` holds only placeholders.
96. [Static] `nginx -t` passes.

### 4.11 Golden paths (E2E)

97. **Student**: open `/` → filter by category → search → open a scenario → progress ring advances
    from 0 to 100 → scene renders → back to catalog. Assert a telemetry row was created and closed.
98. **Teacher/admin**: `/admin` → enter token → create scenario → upload archive → publish →
    it appears in the public catalog and plays → delete.

---

## 5. Acceptance criteria per component

| Component | Accepted when |
|---|---|
| **Catalog API** | Scenarios 1–16 pass. Unpublished rows are unreachable through any public route. Paging is stable under concurrent writes (no row appears on two pages). |
| **Auth** | Scenarios 17–23 pass. No route mutates data without a valid token. No timing-based token oracle: comparison is length-guarded and constant-time. |
| **Download proxy** | Scenarios 24–35 pass. **No request leaves the server to a host outside the allowlist, on any hop.** A response that is not an archive is never relayed. |
| **Storage** | Scenarios 36–46 pass. `objects/` contains only files whose name equals their content hash. `tmp/` is empty after every completed request, success or failure. |
| **Archive validation** | Scenarios 39–41 pass. Every rejection names its cause. No invalid archive is ever committed. |
| **Migrations** | Scenarios 47–51 pass. A failed migration leaves the schema untouched and the process refuses to serve traffic. |
| **Telemetry** | Scenarios 52–64 pass. Duration never originates from the client. A telemetry outage does not affect playback. No personal data is stored. |
| **Viewer** | Scenarios 65–74 pass. Progress is monotonic and reaches 100%. The engine is disposed exactly once per mount. A superseded load never wins. |
| **Catalog UI / a11y** | Scenarios 75–80 pass. Every interactive element is keyboard-operable; the modal traps focus and restores it. |
| **Admin** | Scenarios 81–87 pass. The token never reaches `localStorage` or a URL. |
| **Infrastructure** | Scenarios 88–96 pass. |
| **Overall release gate** | All of the above, plus: coverage thresholds in §2.2 met; `ng build` clean; both golden paths green in CI on a fresh `docker compose up`. |

---

## 6. Defects found while writing this plan

Two were confirmed empirically against the running stack and fixed immediately; the scenarios above
now stand as regression tests rather than as known failures.

### 6.1 `ILIKE` wildcards in `q` were not escaped — **fixed**

`GET /api/catalog` built `` `%${query}%` `` and passed it to `ILIKE`, so a `q` of `%` matched every
row and `_` matched any single character. Measured before the fix: `?q=%` → `total: 4` and
`?q=_` → `total: 4`, while **zero** rows actually contain an underscore in title or description.
Not an injection risk (the value was always a bound parameter), but search results did not
correspond to what was typed.

Fixed with `escapeLikePattern()` (escapes `\`, `%`, `_`) plus `ESCAPE ''` on both predicates.
After: `?q=%` and `?q=_` → `total: 0`; `?q=Сонячна` → `total: 1`. Scenario 10 now passes.

### 6.2 Paging had no stable tiebreaker — **fixed**

`ORDER BY created_at DESC` is not a total order: rows sharing a timestamp (anything seeded in one
transaction — which is exactly the four seed rows) could be ordered differently between the page
query and the next, letting a row appear on two pages or on none. Fixed by adding `, id DESC`.
Scenario 3 now means something.

### 6.3 Orphaned archive objects — **fixed 2026-08-13**

Deleting or republishing a scenario left its object in `objects/` forever. By the time this was
implemented the leak was 52 MB of an 88.7 MB store — four orphans from R1's republish.

`GET /api/admin/storage` reports; `POST /api/admin/storage/gc` sweeps, dry-run unless
`{"dryRun": false}`. Reference counting is over `archive_sha256`, so the dedup hazard this entry
warned about is handled directly: a test uploads identical bytes under a second id, deletes that
row, and requires the object to survive because another row still points at it. Objects younger
than `GC_MIN_AGE_MS` are spared, since an upload commits its object before the row that references
it and would otherwise look exactly like an orphan.

### 6.4 Search does not cover the scenario id — **open, by decision**

`q` matches title and description only, as the previous client-side filter did. Typing a known id
finds nothing. Left as-is because it is unchanged behaviour, but worth a decision when the catalog
grows.

## 7. Not verifiable without a browser — **covered as of 2026-08-13**

These were implemented but confirmed only by reading the code and by checking that the production
build is clean. They were the argument for the Playwright layer, and `e2e/` is now that layer:
22 tests, one skipped by design.

| Item | Where it is now covered |
|---|---|
| Progress ring animating 0→100 during a real download (F5) | `viewer.spec.ts` |
| WebGL2-unavailable message (F7) | `viewer.spec.ts` — `getContext('webgl2')` stubbed to null |
| Context-loss overlay after `WEBGL_lose_context` (F7) | `viewer.spec.ts` |
| Fullscreen toggle and the `MemoryProfiler` overlay (F8) | `viewer.spec.ts` |
| Modal focus trap, Esc, focus restoration (F10) | `catalog-a11y.spec.ts` |
| Orientation hint on a portrait viewport (F9) | `viewer.spec.ts`, `catalog-a11y.spec.ts` |
| The `/admin` screen itself (F12) | `admin-golden-path.spec.ts` |
| `sendBeacon` firing on tab close (F13) | `student-golden-path.spec.ts` — asserted on the request |
| Golden paths #97 / #98 | `student-golden-path.spec.ts`, `admin-golden-path.spec.ts` |

Two things the browser layer found immediately, neither of which any unit test could have:

1. **A scenario could open the profiler overlay on a student.** `solar-system` calls
   `MemoryProfiler.showOverlay()` from its own code, so the platform's flagship scenario showed
   students a developer overlay of FPS and VRAM counters. The `?diag=1` gate governs the
   platform's button, not what content does once it is running — the viewer now closes it, and
   `viewer.spec.ts` holds the line.
2. **Nothing in the release actually loads a `.ktx2`.** Benchscene3 ships twelve of them and its
   manifest lists them, but `Scenario.js` asks for the `.jpg` originals, so the transcoder is
   never fetched and texture VRAM sits at 242.7 MB where transcoding would give ~36 MB. That is
   ScenarioCreator's to fix; `ktx2.spec.ts` skips with that reason and switches itself on when a
   scenario does reference one.

Note on the progress ring: it is **not** one continuous 0→100 ramp, and asserting that was wrong.
`progressPercent` is shared by two phases — the archive download, then the engine unpacking it —
and restarts between them. The test asserts monotonicity within each phase.

---

## 8. Suggested execution order

1. Fix §2.1 prerequisites — nothing else can run until the test targets exist.
2. Backend integration suite (§4.1–4.6) — highest defect yield per hour, and it covers the
   security-critical surfaces.
3. Frontend unit suite (§4.1 client half, §4.3 F3, §4.6 F13) — pure logic, no DOM.
4. Component suite (§4.7–4.9).
5. Playwright golden paths (§4.11) plus the §7 backlog.
6. CI: install → `ng build` → both suites → `docker compose build` → E2E against the stack.
7. Backfill regression tests for §6.1 and §6.2, then decide §6.3 (orphan sweep) and §6.4.
