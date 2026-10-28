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
| ~~B6~~ | ~~Download proxy~~ — deleted 2026-08-13; now only that it stays 404 | `archives-and-telemetry.test.js` |
| ~~B7~~ | ~~Proxy hardening~~ — the code it guarded is gone | — |
| B8 | Rate limiting (telemetry) | `telemetryLimiter` |
| B9 | Content-addressed storage: hash, commit-by-rename, dedup, temp cleanup | `storage.js` |
| B10 | Archive validation: ZIP, manifest, required fields, entry point, id-mismatch warning; scene/prefab format and `manifestVersion` major the player reads, also at `import:assets` and `publish:release` | `archive-validation.js`, `player-formats.js` |
| B11 | Archive upload (multipart). ~~import-from-source~~ deleted 2026-08-13 | `POST /api/scenarios/:id/archive` |
| B12 | Migration runner: ordering, idempotence, advisory lock, transactional failure | `migrations.js` |
| B13 | Telemetry: start, idempotent end, server-computed clamped duration, admin summary | `POST/GET /api/telemetry/*` |
| B14 | Resilience: `pool.on('error')`, graceful shutdown, health check + API build | `server.js` |
| B15 | Storage report and garbage collection: refcount, dedup, age grace | `GET`/`POST /api/admin/storage*` |
| B16 | `manifest_url`: exposed beside `scenario_url`, withdrawable without stranding the row | `GET /api/catalog/:id` |

### 1.2 Frontend (`frontend/src/app/`)

| # | Feature | Where |
|---|---|---|
| F1 | Catalog state: paging, append vs replace, `total`/`hasMore`, error reset | `services/scenario.service.ts` |
| F2 | Category mapping: API categories + icon lookup + default, "all" prepended | `scenario.service.ts` |
| F3 | Download URL resolution — now trivial: every archive is same-origin, the proxy fallback is deleted | `resolveDownloadUrl` |
| F4 | Download with progress + abort mid-stream | `downloadScenarioZip` |
| F5 | Viewer state machine: `idle→downloading→loading-engine→running` / `error` / `unsupported` | `viewer.component.ts` |
| F6 | `loadToken` guard: a superseded load cannot overwrite a newer one | `viewer.component.ts` |
| F7 | WebGL2 probe, context-loss handling | `viewer.component.ts` |
| F8 | Restart from in-memory buffer (no re-download) | `restart()` |
| F9 | Catalog UI: debounced search, load-more, URL-backed filters, empty/error states | `catalog.component.ts` |
| ~~F10~~ | ~~Modal a11y~~ — the modal is gone (release 1, phase 3); its job is done by the scenario page, F14 | — |
| ~~F11~~ | ~~Theme persisted~~ — dark theme only; the test is now that no `theme` key is written | — |
| F14 | Scenario page `/scenario/:id`: fields, hidden blocks, not-found/error, copy link | `pages/scenario/` |
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
- **`sceneVersion2`** (a `*.scene.json` with `version: 2`) and **`unknownManifestMajor`**
  (`manifestVersion: "2.0"`) — both refused with 400 and nothing stored; built by
  `test/helpers/fixtures.js`, like the rest.
- **Seed**: 3 published + 2 unpublished scenarios across 2 categories, so paging, filtering and
  the published/unpublished split are all observable.

---

## 4. Test scenarios

Legend: **[U]** unit · **[I]** integration · **[C]** component · **[E]** E2E.

### 4.1 Catalog read (B1, B2, F1, F2)

**Happy path**
1. [I] `GET /api/catalog` → 200, only published rows, `total` equals their count.
2. [I] Response carries `categories` = visible categories with at least one published scenario,
   each `{category, categoryLabel, icon, count}`, in `sort_order` (changed by Nocturne release 1;
   see §4.12 #100-101).
3. [I] `?limit=2&offset=0` and `?limit=2&offset=2` return disjoint sets covering the page,
   stably across repeated calls (regression for §6.2).
4. [I] `?category=astronomy` narrows `scenarios` and `total` but **not** `categories` or `summary`
   (the unfiltered counts; see §4.12 #101).
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
18. [I] `Authorization: Bearer <wrong>` → 403 (counted against the address; see 183).
19. [I] Correct token → 2xx.
20. [I] Header without the `Bearer ` prefix → 401.
21. [I] Token of the correct value but different length → 403, no crash
    (`timingSafeEqual` throws on length mismatch; the length guard must catch it).
22. [I] **Superseded by 180 (release 2, phase 2):** with `ADMIN_TOKEN` unset the bootstrap is off — its value
    is just an unknown token (403), personal keys still work, and nothing answers 503; `GET`s stay 200.
23. [I] All `GET /api/catalog*` remain public with no header.

### 4.3 Download proxy — **deleted 2026-08-13, scenarios 24–35 retired**

The proxy and the import-from-URL endpoint are gone, along with the URL rewriting,
confirmation-page scraping, host allowlist and redirect follower they were built on. Every catalog
row is served from local storage, so none of it had a caller.

Scenarios 24–35 covered code that no longer exists. What replaced them is one test that the
surface **stays** gone — `the server no longer fetches archives from anywhere` asserts both routes
404 and that upload still works. That is the regression worth keeping: the proxy was an open relay
once, when it took the upstream URL from the client.

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
42. [I] Upload exceeding `MAX_ARCHIVE_BYTES` → 413 (Ukrainian message), no temp file left behind;
    exactly the limit is accepted (see §4.12 #107).
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
77. [C] Image error → fallback. Now: the card falls back to the category gradient
    (`scenario-card.component.spec.ts`, #117), the scenario page likewise (#128).
78. [E] Card title is reachable by Tab and opens the scenario page on Enter.
79. ~~Modal focus trap~~ — **retired 2026-10-24 with the modal**; keyboard coverage of what replaced
    it is #133.
80. ~~Theme persists~~ — **retired with the theme toggle**; replaced by #127 (no `theme` key).

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

### 4.12 Nocturne release 1: catalog data and API (phase 1)

Specs: `catalog-api.test.js`, `archive-limit.test.js`, unit `catalog-input.test.js`.

99. [I] Migration 006 applied twice: one category per distinct scenarios.category, prototype
    icons (folder otherwise), sort_order = Ukrainian label order x 10, features defaults [].
100. [I] Catalog item carries archiveBytes (number, null without an archive), updatedAt,
    features; categories.label beats the scenario's own label; categories are
    {category, categoryLabel, icon, count} in sort_order; summary present.
101. [I] summary and category count do not change with category/q; a category with
    is_visible = false or only unpublished rows is absent from categories and
    summary.categories, while its published scenarios still list.
102. [I] sort=title orders Ґанок, Єнот, Іграшка, Їжак, Яблуко (and Latin titles) correctly;
    sort=new is created_at DESC, id DESC; no sort equals new.
103. [I] limit 0/1/100/101 and offset past the end under both sorts; pages disjoint and
    complete; sort=, sort=DROP, sort[]=a&sort[]=b and similar fall back to new; q with
    % / _ stays literal (a title containing 100% is found by 100%; this caught a
    pre-existing ESCAPE clause that SQL read as an empty string).
104. [I] related: same category first, newest first, at most 2, never itself, never unpublished,
    topped up from other categories; empty for a one-scenario catalog.
105. [I] GET /api/catalog/:id for an unpublished, unknown or %2F id -> 404.
106. [I] GET /api/config -> 209715200 by default (fresh process), MAX_ARCHIVE_BYTES honoured,
    junk value falls back to the default.
107. [I] Archive of exactly the limit accepted; limit + 1 byte -> 413 and an empty temp dir; the row is
    untouched; no token -> 401 before any size check; other multer failures -> 400.
108. [I] Admin features accepted: 6 items, title 60, subtitle 90, subtitle absent, icon 40 chars;
    PUT replaces, a PUT without features keeps them; admin list returns them.
109. [I] Admin features rejected with 400: 7 items, icon Atom / ../x / 41 chars, empty or
    61-char title, 91-char subtitle, non-array, item null; nothing is written.
110. [I] An unknown slug creates its category (label from categoryLabel, else the slug) at max + 10;
    a known slug keeps its label; a 404 or 409 leaves no category behind; non-array stored
    features reads []; a slug without a category row still lists (no chip).
111. [U] validateFeatures, parseSort (incl. __proto__/constructor), parseMaxArchiveBytes.

### 4.13 Nocturne release 1: foundation (phase 2)

Numbered in phase 3, which owns this document. Specs: `frontend/src/styles/nocturne-styles.spec.ts`,
`frontend/src/app/ui/**`, `e2e/tests/nocturne-foundation.spec.ts`.

112. [U] Tokens, component classes and keyframes carry the design file's values; the page ground is
     #161826; no light theme rules remain (DW-2.1).
113. [U] Every Inter face in the stylesheet points at a file that ships (DW-2.2, stylesheet half).
114. [E] Inter is served from `/assets/fonts/`; no request leaves the origin (DW-2.2).
115. [C] `<vl-icon>` draws every hosted icon from the generated path data, inherits colour and size,
     falls back for an unknown name; the committed data equals what the generator produces (DW-2.3).
116. [C] `<vl-site-header>` (both brand modes, slot order) and `<vl-site-footer>` (DW-2.4; since phase 5
     the footer is the copyright bar only - see #147).
117. [C] `<vl-scenario-card>` (open vs launch, gradient fallback), toast service and host (announced,
     self-hiding), `categoryGradient` (stable per slug) (DW-2.4).
118. [U] `formatBytes`, `formatDate` (Kyiv, own month names), `pluralUk` (DW-2.5).
119. [E] The old `/admin` and the viewer error screen keep their computed look under the legacy scope
     (DW-2.6).

### 4.14 Nocturne release 1: catalog and scenario page (phase 3)

Specs: `catalog-query.spec.ts`, `platform-config.service.spec.ts`, `scenario.service.spec.ts`,
`catalog.component.spec.ts`, `scenario.component.spec.ts`, `admin.component.spec.ts`;
`catalog-scenario-page.spec.ts`, `catalog-a11y.spec.ts`, `student-golden-path.spec.ts`,
`admin-golden-path.spec.ts`.

120. [U] The URL query ↔ filter conversion round-trips; defaults are dropped from the URL; junk,
     repeats, unknown `sort`, over-long `q` fall back (DW-3.2).
121. [U] `ScenarioService`: `sort=title` sent only when non-default; summary and chips with icon and
     count in API order; chips survive a failed request; load more keeps the query (DW-3.1, DW-3.2).
122. [U] Responses resolving out of order: the newest filter wins, an older failure shows no error,
     an older answer does not end `loading`, a stale append is dropped (DW-3.2).
123. ~~`PlatformConfigService`~~ - **retired 2026-10-26 (phase 5)**: the footer's archive limit was its
     only consumer; `GET /api/config` stays on the backend (#111, API tests).
124. [C] Catalog: header "Увійти"/"Панель", chips (icon, count, order, `aria-pressed`), "Знайдено N",
     card grid (DW-3.1). The hero and the footer limit were removed in phase 5 (#147).
125. [C] Catalog: sort segment drives `sort`; deep link → request; chip/sort/search write the URL
     (search replaces history after the debounce); the search box is not overwritten mid-word; Back
     and return from a scenario page reload the filter; load more keeps the query (DW-3.1, DW-3.2).
126. [C] Catalog: no results → "Нічого не знайдено" (not flashed before the first answer), reset
     clears the URL and the box; 500 → error state, retry reloads the same filter (DW-3.3).
127. [C] Catalog: no dialog, no theme toggle, no `theme` key; card → `/scenario/:id`, "Запустити" →
     `/play/:id` by id alone; a scenario without an archive opens its page (DW-3.6).
128. [C] Scenario page: every field, meta table rows (version, author, size, updated, ID), features,
     related links, breadcrumbs, `document.title`, logo-only header with back and crumbs; features
     `[]`, related `[]`, no `scenarioUrl`, missing fields → their blocks absent; id with `/` and
     Cyrillic encoded (DW-3.4).
129. [C] Scenario page: 404 → not-found, 500 / network → error and retry, loading state, an answer for
     an id the visitor left is dropped; "Каталог" returns with the filter (DW-3.4, DW-3.2).
130. [C] Copy link: clipboard ok → absolute URL + toast; Clipboard API missing or rejected → readonly
     selected input, no toast (DW-3.5). The download link was removed in phase 5 (#147).
131. [C] `/admin` editor: add up to six entries (seventh blocked), icons from `ICON_NAMES`, edit and
     remove, empty subtitle dropped on save, existing entries copied not shared, server 400 shown
     (DW-3.8).
132. [E] Student golden path through the scenario page (filter → search → page → Back keeps the query
     → launch → viewer); real counters equal the API; URL round trip and Back (DW-3.1, DW-3.2, DW-3.10).
133. [E] Keyboard: chips are buttons with `aria-pressed` (Enter, Space); sort radios (arrows) request
     the order; Tab on the scenario page reaches "Запустити симуляцію" (DW-3.10).
134. [E] 390 × 844: no horizontal page scroll on either page, chips scroll on their own, the scenario
     page's launch bar stays in view (DW-3.7).
135. [E] Loading the catalog and a scenario page makes no off-origin request (DW-3.9).
136. [E] Admin golden path with a "Що всередині" entry that reaches the scenario page; seventh entry
     blocked; server 400 shown and nothing created (DW-3.8, DW-3.10).
137. [E] Catalog empty state and error state with retry against the real stack (DW-3.3).

#### Viewer — loading screen and HUD (release 1, phase 4)

138. [U] `viewer-format.spec.ts`: the byte line — known total ("3,2 з 48,2 МБ"), unknown total (0 / null /
     NaN gives "X МБ"), loaded greater than total (total dropped, never "5 з 3"), no archive (empty);
     `readFlag` (`?diag` / `?stream` parsing, moved out of `ViewerComponent` unchanged) (DW-4.1, DW-4.7).
139. [U] `viewer-loading.component.spec.ts`: inputs → percent, title, byte line, stage, bar and ring offset
     (percent clamped, NaN → 0); byte line hidden without a download; "Скасувати" emits `cancel`
     (DW-4.1, DW-4.7).
140. [U] `viewer-hud.component.spec.ts`: exit, title, restart / fullscreen with Ukrainian `aria-label`s; FPS
     slot only when `fps` is a number (0 counts); pause button and the "Space — пауза" hint only with
     `canPause` (label swaps while paused); every button fires its output; restart disabled, not
     hidden, without `canRestart`; **Space does nothing in the page** (pause arrives with player-isolation
     phase 5) (DW-4.2, DW-4.4, DW-4.7).
141. [E] `viewer.spec.ts`: loading screen (ring percent, title, "Завантаження архіву — X з Y МБ", stage,
     "Скасувати") then the HUD; "Скасувати" aborts the archive `fetch` and lands on `/scenario/:id`
     (DW-4.1).
142. [E] `viewer.spec.ts`: HUD at 1440 px — aria-labels, ~~no pause button and no FPS slot, hints without
     Space~~ (**superseded by 164-171**: the pause button and the FPS slot are now driven by the player),
     "Вийти" → `/scenario/:id`; at 390 px the hints are hidden and exit / title / buttons stay
     inside the viewport without overlapping (DW-4.2).
143. [E] `viewer.spec.ts`: restart on a ZIP run is enabled and re-runs from the buffer (second telemetry
     launch, one archive request); `streaming.spec.ts`: ~~disabled with `?stream=1`~~ - **superseded by 168**:
     a streamed run restarts in a fresh frame (DW-4.4).
144. [E] `viewer.spec.ts`: unknown scenario → Nocturne error panel with its way back; no WebGL 2 → Nocturne
     panel (Inter, `--color-bg`); forced context loss → panel with "Перезавантажити" (existing test, F7)
     (DW-4.5).

#### Trimmed pages and the profiler switched off (release 1, phase 5)

Specs: `viewer-profiler.spec.ts`, `viewer.component.spec.ts`, `viewer-hud.component.spec.ts`,
`site-footer.component.spec.ts`, `catalog.component.spec.ts`, `scenario.component.spec.ts`;
`viewer.spec.ts`, `catalog-scenario-page.spec.ts`.

145. [E] `viewer.spec.ts`: solar-system, with and without `?diag=1`, shows no profiler overlay (no
     `#webengine-profiler`, `isOverlayVisible` false, gate shut) now and 2.5 s later; Backquote opens
     nothing; `?diag=1` shows the build stamp; a scenario that re-opens the gate and the overlay after
     load is shut again; no diagnostics button in the HUD (DW-5.3).
146. [E] `catalog-scenario-page.spec.ts`: no `.hero` on `/`, no `.footer-inner`, copyright bar present, no
     admin link in the footer, `/admin` reachable by URL (DW-5.1); the scenario page has no download link
     and no `.launch-note`, "Копіювати посилання" toasts and the launch button opens `/play/:id`
     (DW-5.2).
147. [C] Catalog: no `.hero`; footer: no `.footer-inner`, no admin link, no ZIP note, copyright bar from
     `site.config.ts`; scenario page: no `.download` / `a[download]`, no `.launch-note`, launch button
     stays (DW-5.1, DW-5.2).
148. [U] `viewer-profiler.spec.ts` (real `MemoryProfiler`): `lockProfiler` shuts the gate, a locked gate
     makes `showOverlay` / `toggleOverlay` / `enableToggle` and Backquote inert, `enforceProfilerOff`
     closes an open overlay and a re-opened gate, idempotent; `viewer.component.spec.ts`: the viewer sets
     `diagnosticsAllowed = false` on init without and **with** `?diag=1`, `?diag=1` renders only the build
     stamp, no `toggleDiagnostics`, destroy leaves it shut; HUD: no diagnostics output (DW-5.3).

#### Viewer — load pipeline and restart, unit (release 1, phase 4 fix-forward)

`viewer-lifecycle.spec.ts`, with the player host (the protected `createPlayerHost` seam returns a fake `PlayerHost`; `supportsWebGL2` stubbed) and
`ScenarioService` / `TelemetryService` replaced by doubles.

149. [U] `exit()`: `/scenario/:id` with a route id (also after a failed lookup), `/catalog` without one; the
     loader's "Скасувати" exits and destroying the view aborts the archive download without showing an error
     (DW-4.1, DW-4.2).
150. [U] ~~`canRestart` and the HUD restart button: ZIP run enabled; streamed run (`?stream=1`) disabled, and
     `restart()` there does nothing~~ - **superseded 2026-10-27 by 168** (a streamed run restarts in a fresh frame);
     still current: `?stream=1` without a `manifestUrl` falls back to the ZIP; false after
     context loss and while a restart is loading (DW-4.4).
151. [U] `restart()`: same buffer re-run, one download, second telemetry launch; engine failure → error screen
     (Error and non-Error); no-op before an archive has loaded (DW-4.4).
152. [U] `setState` byte-signal reset and the loader feed: fetch stage with bytes and ring percent, "N з N" in the
     engine stage, everything reset on running; unknown total; streamed run keeps the byte signals null
     (DW-4.1).
153. [U] Failures and stale loads: lookup failure, missing archive, failed download, ZIP and streamed engine
     failure (no telemetry launch), a superseded restart cannot overwrite a newer result (DW-4.5).

#### Viewer — profiler lock and guard, unit (release 1, phase 5 fix-forward)

Same harness; only the guard's `setInterval`/`clearInterval` are faked (`vi.useFakeTimers({ toFake })`).

154. [U] `diagnosticsAllowed` is false at the moment the engine receives each load (ZIP, streamed, restart),
     with and without `?diag=1`, even when the test opened the gate first; `?diag=1` still shows the build
     stamp with the gate shut (DW-5.3).
155. [U] A scenario that re-opened the gate during load (ZIP and streamed) is closed the moment the run starts,
     with a warning; a well-behaved scenario produces none (DW-5.3).
156. [U] The 1000 ms guard: a re-opened gate stays open at 999 ms and is closed at 1000 ms; an opened overlay is
     hidden; repeats on later ticks; one interval across load and restarts; armed at load start so a load
     that re-opens the gate and then fails is still closed on the tick; none before a load begins (DW-5.3).
157. [U] Destroy: `clearInterval` fires, no timer remains, a gate re-opened afterwards is not re-closed, the
     gate is left shut, and a streamed load still in flight cannot re-arm the guard (DW-5.3).

#### Player isolation, phase 4: serving the player (additive)

Specs: `e2e/tests/player-serving.spec.ts`, `e2e/tests/csp.spec.ts`; the unit change is in
`viewer-profiler.spec.ts` / `viewer-lifecycle.spec.ts`. The headers come from nginx, so the e2e runs
need a rebuilt stack.

158. [E] `/player/player.html`: CSP naming the browser's own `scheme://host:port` (never `'self'`),
     `sandbox allow-scripts allow-pointer-lock` without `allow-same-origin`, `frame-ancestors 'self'`,
     no `X-Frame-Options` (DW-4.1).
159. [E] `Access-Control-Allow-Origin: *` for a request with `Origin: null` on `player.html`,
     `player.js`, the engine bundle, the Basis transcoder (`.js`, `.wasm`) and `/a/` (objects and
     manifests, also on a 404) (DW-4.1).
160. [E] `/player/player.js` is not taken by the static-asset regex block (no 30-day cache, no platform
     CSP, no `X-Frame-Options`); anything else under `/player/` is a 404, never the SPA fallback (DW-4.1).
161. [E] A top-level visit to `/player/player.html`: `window.origin === 'null'` and the page shows that it
     refused to run (DW-4.2).
162. [E] `/`, `/index.html`, `/scenarios/`, `/a/...`, `/api/health` carry the same platform CSP (now with
     `frame-src 'self'`), `/player/player.html` the player's (DW-4.4).
163. [U] Release 1's viewer profiler specs (154-157, `viewer-profiler.spec.ts`) re-open the engine gate
     through `MemoryProfiler._resetDiagnosticsPolicy()`, because the setter now latches at `false`; they
     still pin the lock before every load and the 1000 ms re-close (DW-4.5).

#### Player isolation, phase 5: the viewer on `PlayerHost`

Specs: `viewer-lifecycle.spec.ts` (rewritten around a fake host), `viewer.component.spec.ts`,
`viewer-format.spec.ts`, `scripts/check-csp-assumptions.test.mjs` (`npm run test:scripts`);
e2e `hostile-archive.spec.ts`, `viewer-player.spec.ts`, `viewer.spec.ts`, `streaming.spec.ts`,
`csp.spec.ts`, `ktx2.spec.ts`, `editor-csp.spec.ts`. The page no longer holds an engine, so e2e reads the
engine from inside the player frame (`e2e/helpers/engine.ts`). `viewer-profiler.ts` and its spec are gone
(scenarios 145, 148 and 154-157 are retired: the page has no profiler to lock, the host always sends
`diag: false` and the engine latches the gate inside the frame; 163 goes with them).

164. [U] The host is built with `/player/player.html`, `/assets/WebEngineTS.standalone.js`,
     `transcoderPath: '/assets/basis/'`; every load sends `diag: false`, with or without `?diag=1`; the
     viewer exposes no diagnostics member (DW-5.2, DW-5.5).
165. [U] Host adapter: `onFps` reaches the HUD as "N FPS" (absent before the first report), `onPaused`
     flips the pause button, the button asks the host to pause/resume (state is the player's word, never
     guessed), `onProgress` drives the ring only while loading, `onContextLost` shows the overlay (DW-5.2).
166. [U] Space: pauses/resumes with the host focused and is consumed; ignored before running, in a control,
     on repeat, with a modifier, after a context loss and after destroy (DW-5.2).
167. [U] Error mapping: handshake, origin/version, load (player message, fallback when empty), runtime
     (no error screen); an error while the archive is still downloading is not shown (DW-5.2).
168. [U] Blob retention and restart: a ZIP run hands the host a `Blob` of the archive, a streamed run an
     absolute manifest URL; restart is `host.restart()`, no second download, a fresh frame is not paused
     and has no stale FPS; restart while paused; superseded restarts; unreported rejection ends in the error
     screen (DW-5.2).
169. [U] `?diag=1`: the build stamp is asked of the player (`measure(1)`) once running; failure leaves the
     scene running; teardown disposes the host once, aborts the download, ends telemetry (DW-5.2).
170. [E] Hostile archive built in the test (`e2e-` row): `parent`/`top` storage, `parent.document` and
     `top.location` throw `SecurityError`; own storage/cookie are denied; credentialed and bearer calls to
     `/api/admin/scenarios` fail as `TypeError`; `top` is not navigated, no popup, the host's token is
     intact (DW-5.1).
171. [E] ZIP and `?stream=1`: sandboxed frame (exactly `allow-scripts allow-pointer-lock`), focus goes to
     the frame, FPS shown, Space with the host focused pauses/resumes the clock in the frame, the HUD button
     pauses, restart builds a fresh frame (old one detached, no second archive request, not paused afterwards,
     keyboard in the new frame at once), fullscreen takes the host container, exit leaves no frame, forced
     context loss shows the overlay, no profiler overlay with `?diag=1` or Backquote (DW-5.2).
172. [E] Dirty paths: leaving mid-download, leaving mid-load (engine bundle held back), a player that never
     says hello ends in the error state and loses its frame (DW-5.2).
173. [E] Ten viewer round trips leave no frame, no WebGL warnings, and the eleventh run still draws (DW-5.4).
174. [E] `/` has no import map, no `nonce=`, no inline script and a `script-src` of exactly `'self'`;
     `check-csp-assumptions.mjs` fails on an import map, a nonce, an inline script, a bare `WebEngineTS`
     import in a bundle, and on `blob:`/nonce/missing `frame-src` in `csp.conf` (DW-5.3).
175. [E] KTX2: the engine in the frame carries the platform transcoder path and the opaque frame can fetch
     both transcoder files (`ktx2.spec.ts`; its catalog-scenario render check still waits for a scenario
     that references `.ktx2`) (DW-5.5). `editor-csp.spec.ts`: `/editor/`'s import map carries the CSP nonce,
     changing per response, under `csp-editor.conf`; the platform root has neither. It skips on the normal
     stack and runs on `e2e/editor-csp-harness/` (real frontend image, real `editor.conf` /
     `csp-editor.conf`, stub editor and backend; commands in `e2e/README.md`) (DW-5.6).
176. [E] Space, both focus cases, ZIP and `?stream=1` (DW-5.U1): with the frame focused (the default after load) the
     player handles Space inside the frame and reports `paused`; with the host page focused the host asks the
     player. Each press is exactly one toggle (the HUD state and the scenario clock agree and do not flip back
     800 ms later), focus stays in the frame after a pause, and frame Space, host Space and the HUD button
     interleave on one shared state. `[U]` `viewer-lifecycle.spec.ts` (166) keeps pinning the host route:
     consumed, ignored in controls, on repeat, with modifiers, before running and after a context loss.
177. [E] A KTX2 scenario renders through the player (DW-5.5): `ktx2-render.spec.ts` builds an `e2e-` ZIP
     whose script loads `textures/test.ktx2` (copy of the engine smoke fixture, 16x16) onto a cube, plays
     it, and asserts in the frame that the load did not fail or hang, the texture is 16x16, both transcoder
     files were requested from `/assets/basis/`, the renderer reports a compressed GPU format (not RGBA8)
     and the scene drew.

#### Nocturne release 2, phase 2: keys, roles and authorization

Specs: `backend/test/integration/{keys,route-table,author-rules,audit,rate-limits,archive-caps,migration-007}.test.js`,
`backend/test/unit/{archive-caps,auth-and-limits}.test.js`. Keys are inserted through `test/helpers/keys.js`, hashed
independently of `auth.js`. Scenarios 17-23 above still hold for the bootstrap moderator.

178. [I] Keys (DW-2.2): `POST /api/keys` returns `{id, label, role, token}` once (201, `no-store`); the row holds only a
     64-hex SHA-256; `GET /api/keys` lists no token or hash; captured console output never contains a token;
     `/api/auth/me` answers author, moderator key and bootstrap (`keyId` null) and 403 once revoked; revoking is
     idempotent and 404 for an unknown id; `role: "admin"`, empty and 101-character labels are 400.
179. [I] Route table (DW-2.3): {anonymous, unknown, revoked, author A, author B, moderator key, bootstrap} x every guarded
     route -> 401 / 403 / success, one table; a denied call leaves state untouched; an author lists only their own
     rows, a moderator all; public GETs stay public.
180. [I] Dirty headers (DW-2.3): `Bearer ` empty, bare `Bearer`, Basic, lowercase `bearer` -> 401; two spaces and a 10 KB
     token -> 403; a duplicated header never admits a bad credential; `ADMIN_TOKEN` unset -> keys work, no 503.
181. [I] Author field rules (DW-2.4): each forbidden field (`scenarioUrl`, `manifestUrl`, `imageUrl`, `author`, `isPublished`,
     `archive*`) -> 400 on POST and PUT; unknown `category` -> 400 and no category row; `categoryLabel` ignored; POST by
     an author -> unpublished, owned, `author` = key label; another author's scenario -> 403; moderator POST keeps
     create-on-unknown-slug; upload into one's own unpublished scenario 201, into a published one 403.
182. [I] Audit (DW-2.5): one `audit_events` row per authenticated mutation (create, update, delete, archive, key create and
     revoke, non-dry-run GC); none for reads, telemetry, dry runs or refused requests; the row rolls back with a failed
     transaction; history survives deleting the scenario.
183. [I] Rate limits (DW-2.6): failed authentication 29/30/31 -> 403/403/429 per address, successes never counted, a valid key
     never limited, addresses independent; author uploads 20 -> 201 and the 21st 429 per key, a moderator's and the
     bootstrap's 21st succeed; `last_used_at` moves on use.
184. [U/I] Archive caps (DW-2.6): a manifest of `MAX_ENTRY_BYTES` + 1, an oversize scene or prefab, `MAX_ARCHIVE_ENTRIES` + 1
     entries and a zip bomb that lies about its size -> 400 without reading past the cap; the entry count is read from
     the end-of-central-directory record before the directory is parsed; a corrupt entry is still "unreadable"; a
     rejected upload stores nothing and leaves no temp file.
185. [I] Migration 007 (DW-2.7): applies twice without error; role check, unique `token_hash`, `owner_key_id` foreign key,
     no foreign key on `audit_events.scenario_id`.
186. [U] Pure routines: `requireRole` ranking, `canEditScenario` (unowned and key-less cases), `createWindowCounter` (window
     expiry, `Retry-After`), `limitAuthorUploads` exemptions, `parsePositiveInt` fallbacks, `forbiddenAuthorFields`,
     `sha256Hex` (DW-2.2, DW-2.3, DW-2.4, DW-2.6).
187. [I] Migrations 008/009 (DW-3.1): applied twice (and 008 again after 009) on a rebuilt pre-008 schema; `is_published`
     TRUE/FALSE/NULL -> published/draft/draft; one `current` version per archived row, none for streaming-only rows;
     the catalog shows exactly the published ones; status check, one current / one pending per scenario, cascade.
188. [I] Transition matrix (DW-3.2): every (status x action x {owner, other author, moderator, bootstrap, anonymous}) ->
     200/401/403/409 with one audit event per success and none per refusal; no archive -> 409 for submit and approve;
     reject note default / trimmed / 2000 ok / 2001 -> 400 / non-string -> 400; note and `submitted_at` lifecycle;
     two concurrent approves -> one 409; submit racing withdraw; a PUT cannot set `status`.
189. [I] Upload by status (DW-3.3): draft and rejected -> new current (old archived, pending row deleted, same bytes a
     no-op); review -> 409 and nothing stored; published by moderator -> current, by author -> pending (a second
     replaces it; the public catalog keeps the old URL until accept); stranger 403, unknown 404; the 51st version -> 409;
     an author's upload racing an approve never becomes current on the published row.
190. [I] Version routes (DW-3.4): list (owner/moderator), accept, reject (row deleted), restore, delete (archived by a
     moderator, pending by its owner or a moderator, current -> 409), unpublish keeps a pending row, `:vid` of another
     scenario or malformed -> 404, role table, racing accept/restore leave one current version.
191. [I] Version preview (DW-3.5): `GET /api/catalog/:id?version=` - published versions public (pending included),
     draft/review/rejected only for owner and moderators, everyone else 404; 63/65/non-hex/repeated -> 400; foreign hash
     404; `Cache-Control: no-store` on every answer; a wrong credential counts against the address (429).
192. [I] `from-archive` (DW-3.6): valid ZIP -> draft owned by the caller with manifest fields and `{scenario, version,
     manifest, warnings}`; taken id -> 409 (also racing); manifest ids of 101 characters, with `/`, spaces, dots, uppercase
     -> 400 with a hint; invalid ZIPs, unknown category -> 400 with no row, object or temp file; upload limit applies.
193. [I] GC and versions (DW-3.7): current, pending and archived objects survive a sweep however old; a deleted or rejected
     version's object (and a deleted scenario's) is collectible once older than `GC_MIN_AGE_MS`; a shared object lives
     until the last reference; a dedup re-upload refreshes mtime (also [U] in `storage.test.js`).
194. [U] Pure routines: the transition table's shape, `parseRejectNote`, `sendError`, `optionalAuthenticate` without a
     lookup, `SCENARIO_ID_PATTERN` (DW-3.2, DW-3.5, DW-3.6).
195. [U] `publish:release` (DW-3.8): a new row is created, uploaded, then approved; an existing draft is approved, a live
     row is left, a bench scene is unpublished; a dry run writes nothing. Compatibility: `PUT {isPublished}` approves /
     unpublishes (409 without an archive), a POST ignores it, every guarded route is in the route table (179).
196. [F] Viewer draft preview (DW-3.5): `?draft=` is parsed (64 hex, lowercased, malformed -> error screen), the service sends
     `?version=` with the session bearer only for a preview, `returnTo` is honoured only for a draft and only as a relative
     `/admin...` path (`https://evil.example`, `//evil`, backslash, `..` ignored), `goBack` follows it too; a preview
     never streams.
197. [E2E] `e2e/tests/draft-preview.spec.ts` (DW-3.5): a draft's version is a 404 anonymously and plays for the signed-in
     owner/moderator, Вийти goes to the validated `returnTo`, a hostile one is ignored; `admin-golden-path.spec.ts` now
     creates, uploads, then publishes through the toggle (a new row is a draft).

198. [I] Categories (DW-4.1) `categories.test.js`: create/edit/delete/reorder for moderators (bootstrap too), slug 1/2/50/51
     characters and uppercase/space/underscore, bad label/icon/isVisible -> 400; used category -> 409; reorder with a partial,
     unknown or duplicate list changes nothing; authors 403; hiding a category removes its scenarios from list, summary,
     chips, related, `/:id` and `?version=` for the public (owner and moderators still reach them); a slug with no row stays public.
199. [I][U] Preview accepting (DW-4.2) `previews.test.js`, `preview-image.test.js`: PNG and JPEG at 800 px, 16:10, 5 MiB exactly
     stored as `/previews/<sha>.<ext>`; 16:9 stored with a warning; the 5 % tolerance; remove is idempotent; role cases.
200. [I][U] Preview dirty and storage (DW-4.2) `previews.test.js`, `preview-store.test.js`: SVG, GIF, text, ZIP, a file shorter
     than its header, 5 MiB + 1, 799 px -> 400 with nothing stored; type by bytes (PNG named .jpg, JPEG as image/png);
     GC and `/api/admin/storage` cover both stores; the second store lists only its own names.
201. [I][U] `imageUrl` rule and CSP (DW-4.2, DW-4.6) `previews.test.js`, `category-input.test.js`, `csp-conf.test.js`,
     frontend `test:scripts`: author PUT/POST with any imageUrl -> 400; moderator with an external URL -> 400, with
     ''/current/`/previews/...` -> 200; migration 010 clears external URLs (listed in the log), keeps same-origin, twice;
     `img-src` is exactly `'self' data: blob:`; `/previews/` carries the CSP include.
202. [I][U] Checks and contents (DW-4.3) `version-tools.test.js`, `archive-checks.test.js`: every new version (upload,
     from-archive, pending) stores its checks; re-run refreshes them (a vanished object is an error item); contents of a nested
     archive with sizes; the entry cap; manifest field limits (id 255, version 50, engineVersion 100) and non-string name/version -> 400.
203. [I][U] Test-run (DW-4.4) `version-tools.test.js`, `test-run-input.test.js`: numeric result stored with who/when; an error
     result `{error, engineBuild?, userAgent?}` stored without numbers; negative, NaN, 10^12 ms, 101-char build, missing
     field, numbers beside an error -> 400 and the stored run untouched.
204. [I] Bulk (DW-4.5) `version-tools.test.js`: mixed ids -> per-id results, each in its own transaction, repeated ids once;
     malformed requests -> 400; unknown category reported per id; authors 403; audit rows flagged `bulk`.
205. [I] Dashboard, history and admin rows (DW-4.5) `version-tools.test.js`: counts by status with zeros, queue size, activity,
     scoped to an author's scenarios; history newest first, owner or moderator, survives deletion; `ownerLabel`,
     `pendingVersionId`, `currentVersion` with check counts.
206. [I] Route table rows for every Phase 4 route (179), `/api/config` preview limits (DW-4.6), `from-archive` manifest input.
207. [U] Pure routines: `inspectPreview`, `validateTestRun`, `validateCategory`, `imageUrlProblem`, `describeError`, the store factory.

#### Nocturne release 2, phase 5: admin UI - sign-in, shell, list, metadata and publication

Specs: `frontend/src/app/services/{admin-api,admin-session,admin}.service.spec.ts`,
`pages/admin/{admin-guards,admin-login.component,scenario-rules}.spec.ts`,
`pages/admin/{admin-shell,scenario-list,scenario-meta-form,scenario-publish,scenario-edit}/*.spec.ts`,
`ui/{icon-picker,status-pill}/*.spec.ts`; e2e `e2e/tests/admin-workflow.spec.ts` (keys are issued and revoked through
`helpers/api.ts`, whose helpers take the code to act as). The old admin's specs moved to `pages/admin/legacy/`; its e2e
(`admin-golden-path`, `nocturne-foundation`) now open `/admin/legacy` through the sign-in screen.

208. [U] Session and API (DW-5.1, DW-5.5) `admin-api`, `admin-session`, `admin-guards`: author / moderator / revoked / empty
     sign-in, nothing stored on a refusal; the code only in `sessionStorage`, cleared on sign-out; `AdminApi` routes and bodies;
     401 and 403 `Невірний токен` end the session with a reason, any other 403, a 409 and a 500 do not; guards (anonymous ->
     sign-in, author -> list for moderator pages and `/admin/legacy`); the unsaved-changes guard.
209. [U] Sign-in screen and shell (DW-5.1, DW-5.5): plaque for a refused or empty code, the reason of an ended session, no demo
     codes or "12 годин"; name and role in the user card, role-aware items, queue badge, sign-out, a session that ends under
     the screen goes to sign-in; burger / Escape / scrim / navigation open and close the drawer.
210. [U] List (DW-5.2): chip counts, status and category filters (combined, reset), pills, archive size, long author text;
     authors get no selection or bulk bar; moderators: selection, select-all of visible rows, bulk publish / unpublish /
     category / delete with per-id results, a whole-request refusal.
211. [U] Метадані (DW-5.3): saves only changed fields; the 0 / 160 counter and the 161 block; six features and a blocked
     seventh, the icon picker, clean entries; preview upload with warnings and removal; `author` read-only for authors and
     never sent; the live card equals a catalog card; readiness (missing description / preview / archive, check findings).
212. [U] Публікація (DW-5.4) `scenario-rules`: each transition per role and status (disabled without an archive, note for a
     return, confirm for unpublishing), the server's refusal shown, the history from the journal as sentences, who and when.
213. [U] Edit page (DW-5.5): unsaved edits survive Метадані -> Публікація -> Метадані; leaving asks (stay / go) and a clean
     page does not; `beforeunload`; refetch after a save; not found, error and retry; a 300-character title.
214. [E] Sign-in (DW-5.1): bootstrap shows name and role, the code never reaches `localStorage` or the URL, sign-out clears the
     session; an author gets the author menu and `/admin/legacy` sends them to the list; a moderator reaches it; revoked and
     empty codes. *Written and type-checked; run by the orchestrator at VERIFY.*
215. [E] Author flow (DW-5.5): sign in as a key -> own row only -> edit Метадані (live card, counter) -> save -> Публікація ->
     submit -> status and history; the archive is seeded through the key-parameterised helper. *Not run.*
216. [E] Edge cases (DW-5.5): unsaved edits across a tab switch and the browser prompt; a key revoked mid-session and on reload
     returns to sign-in with the reason; at 390 px the sidebar is a drawer; a 300-character title keeps the layout. *Not run.*


### 4.11 Golden paths (E2E)

97. **Student**: open `/` → filter by category → search → open the scenario page (`/scenario/:id`) →
    launch → progress ring advances from 0 to 100 → scene renders → back to catalog. Assert a telemetry row was created and closed.
98. **Teacher/admin**: `/admin` → enter token → create scenario → upload archive → publish →
    it appears in the public catalog and plays → delete.

---

## 5. Acceptance criteria per component

| Component | Accepted when |
|---|---|
| **Catalog API** | Scenarios 1–16 pass. Unpublished rows are unreachable through any public route. Paging is stable under concurrent writes (no row appears on two pages). |
| **Auth** | Scenarios 17–23 pass. No route mutates data without a valid token. No timing-based token oracle: comparison is length-guarded and constant-time. |
| **Download proxy** | ~~Scenarios 24–35~~ — deleted. The criterion is now absolute: **the server makes no outbound request for an archive at all**, and both retired routes answer 404. |
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
35 tests, one skipped by design.

| Item | Where it is now covered |
|---|---|
| Progress ring animating 0→100 during a real download (F5) | `viewer.spec.ts` |
| WebGL2-unavailable message (F7) | `viewer.spec.ts` — `getContext('webgl2')` stubbed to null |
| Context-loss overlay after `WEBGL_lose_context` (F7) | `viewer.spec.ts` |
| Fullscreen toggle and the `MemoryProfiler` overlay (F8) | `viewer.spec.ts` |
| ~~Modal focus trap, Esc, focus restoration (F10)~~ | modal removed; `catalog-a11y.spec.ts` now tests chips, sort radios and the scenario page (#133) |
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
and restarts between them. The test asserts monotonicity within each phase (told apart by the stage
label: "Отримання даних із сервера" vs "Ініціалізація сцени"). Release 1 phase 4: the HUD no longer
has a diagnostics button, so the old "button toggles the overlay" test became "no button, and with
`?diag=1` the scenario's own overlay is left open".

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
