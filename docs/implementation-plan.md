# Virtual Lab — Implementation Plan

Drafted 2026-07-31 against commit `f08b1575`; revised 2026-08-01 after a full code audit of the
working tree. Companion to `CLAUDE.md`; every item is a concrete change with a file anchor and a
done-when condition.

Estimates are focused engineering days for one developer. Phases 0–0.5 are sequential and block a
public deployment; 1–6 can be resequenced against whatever the thesis needs.

The 2026-08-01 revision added: the open-relay hole in the proxy (Phase 0), the missing
`.dockerignore` (Phase 0), the zoneless/progress-bar defect and its fallout (new **Phase 0.5**),
a migration runner as a prerequisite for every later schema change (Phase 1), and a reduction of
Phase 4 to session telemetry only.

---

## Phase 0 — Security & hygiene (~3–4 days) — **done 2026-08-01**

The platform was deployable but not defensible: anyone who could reach the site could wipe the
catalog, and the database password was in git history.

- [x] **Untrack `.env` and rotate the password.** `git rm --cached .env`; `.gitignore` now has
      `.env` / `.env.*` with a `!.env.example` exception; `.env.example` documents every variable.
      The password was rotated **in place** with `ALTER USER` rather than by recreating the volume,
      so no data was lost — `POSTGRES_PASSWORD` only applies at initdb, which is why simply editing
      `.env` would not have been enough. `Readme.md` no longer prints a default password.
      *The old value stays in git history; treat it as burned rather than trying to rewrite.*
- [x] **Authenticate the write endpoints.** `requireAdmin` (`backend/server.js`) guards `POST`,
      `PUT` and `DELETE /api/catalog`; `GET`s stay public. Bearer token compared with
      `crypto.timingSafeEqual` behind a length check. 401 without the header, 403 on mismatch,
      503 when `ADMIN_TOKEN` is unset.
- [x] **Close the open relay.** `/api/proxy-download` takes `id`, not `url`, and looks
      `scenario_url` up in `scenarios` (published rows only). The hostname allowlist is now a
      second line of defence rather than the only one. Client side updated to match:
      `ScenarioService.resolveDownloadUrl` takes the scenario and emits `?id=`.
- [x] **Harden the download proxy.** `redirect: 'manual'` with the allowlist re-checked on every
      hop (cap 5); a 30 s timeout on **headers only** — an `AbortSignal.timeout` around the whole
      request would have killed legitimate multi-minute downloads; a size cap enforced by a
      `Transform` in the stream; `Content-Type` restricted to archive types.
      Streaming moved from a manual `res.write` loop to `stream.pipeline`, so backpressure is
      respected instead of buffering a whole archive in memory for a slow client.
      *This immediately surfaced a live defect:* Drive redirects every real download to
      `drive.usercontent.google.com`, which was **not** on the allowlist — under
      `redirect: 'follow'` that hop was never checked, so the allowlist had no effect on any actual
      request. The host is now listed explicitly.
- [x] **Rate-limit the proxy.** `express-rate-limit`, 60 requests / 15 min per address by default
      (`PROXY_RATE_LIMIT`). `trust proxy` is set so clients bucket by real IP, not by nginx's.
- [x] **Drop the wildcard CORS.** `cors()` is applied only when `CORS_ORIGIN` is set.
- [x] **Survive a database blip.** `pool.on('error')` plus a `SIGTERM`/`SIGINT` shutdown that
      closes the server, drains the pool and force-exits after 10 s.
- [x] **Add a `.dockerignore`** — one at the repo root (frontend build context) and one in
      `backend/`. Build context is now ~2 kB instead of the whole `node_modules` tree.
- [x] **nginx gaps.** `client_max_body_size 512m`, `proxy_read_timeout`/`proxy_send_timeout` 300 s,
      `proxy_buffering off` for archive streaming, `Cache-Control: no-cache` on `/index.html`, and
      `X-Content-Type-Options` / `Referrer-Policy` / `X-Frame-Options`. The headers are repeated in
      the locations that declare their own `add_header`, because nginx does not inherit them there.
      `expires 30d` was replaced by a single `Cache-Control` — the two together emitted two separate
      headers. No CSP yet: it must not break the import map in `frontend/src/index.html`.
- [x] **Container hygiene.** `backend/Dockerfile`: `NODE_ENV=production`, `npm install --omit=dev`,
      `USER node`. Compose: healthcheck on `/api/health` for `backend`, and `frontend` now depends
      on it with `condition: service_healthy`.
- [x] **Docker resource limits + a backup note.** `deploy.resources.limits` on all three services;
      `Readme.md` documents `pg_dump`/restore for `virtual_lab_pgdata`.

**Done when:** `.env` is untracked and the password rotated; unauthenticated `POST`/`PUT`/`DELETE`
return 401; `/api/proxy-download` with an arbitrary `storage.googleapis.com` URL is refused; a proxy
request that redirects off the allowlist is refused; a 10 GB upstream response is aborted rather
than streamed; `docker compose build frontend` no longer transfers `node_modules` in its context.

*Verified 2026-08-01 against the running stack:* `POST`/`PUT`/`DELETE` without a token → 401, with
a wrong token → 403, with the real token → 201/200; `?url=…` → 400; `?id=nope` → 404;
`?id=solar-system` → 18 526 012 bytes starting with `PK`, with a real `Content-Length`; `/` and the
SPA fallback → `Cache-Control: no-cache` + the three security headers; hashed assets → one
`Cache-Control: public, max-age=2592000, immutable`; backend container reports healthy.

**Not done — deliberately:** no CSP (needs an import-map-safe policy), and the database password
lives in `.env` rather than a secrets manager, which is the right trade-off at this scale.

---

## Phase 0.5 — Correctness quick wins (~1–1.5 days) — **done 2026-08-01**

Small, independent fixes, each closing a defect confirmed against the code. Cheap, and they make
everything after them observable — the loading UI used to lie about what the platform was doing.

**The app is zoneless and nobody noticed.** `zone.js` is absent from `frontend/package.json`, from
`package-lock.json` and from `node_modules`; `app.config.ts` provides only `provideRouter` and
`provideHttpClient`; and Angular 21's `bootstrapApplication` installs
`provideZonelessChangeDetectionInternal()` (`node_modules/@angular/core/fesm2022/core.mjs:723`).
So the injected `NgZone` is a no-op and every `ngZone.runOutsideAngular(...)` /`ngZone.run(...)` in
`viewer.component.ts:56, 111, 122, 128, 152, 162` does nothing.

The visible consequence: the download-progress callback (`viewer.component.ts:111-116`) and the
engine-progress callback (`:128-133`) mutate `progressPercent` / `progressLabel` **without**
`cdr.markForCheck()`. Under `OnPush` + zoneless nothing schedules change detection, so the ring and
the label sit at whatever the last `setState(...)` wrote — 0% — for the entire load, then jump.

- [x] **Move viewer and catalog state to signals.** Done in `viewer.component.ts`,
      `catalog.component.ts` and `scenario.service.ts`: `NgZone` and `ChangeDetectorRef` are gone
      from both components, the service's three `BehaviorSubject`s are signals, and the catalog
      derives `displayedScenarios` with `computed` instead of subscribing. Writing a signal notifies
      the zoneless scheduler, so the progress defect is fixed by construction rather than by a
      `markForCheck()` the next callback would forget. `app.config.ts` now states
      `provideZonelessChangeDetection()` explicitly so the mode is a decision, not an accident.
      The viewer also carries a `loadToken` so a superseded navigation cannot write its result over
      a newer one.
- [x] **Fix the stale zone section in `CLAUDE.md`** — replaced with the zoneless/signals rules;
      the `app.dispose()` rule is untouched.
- [x] **Resolve the scenario by id, not by query param.** `ViewerComponent` calls the new
      `ScenarioService.fetchScenarioById()` → `GET /api/catalog/:id` and takes both `scenarioUrl`
      and `title` from it; `catalog.component.ts` navigates with the id alone. Fixes the empty
      title on a hard reload of `/play/:id` as well.
- [x] **Built-in control flow.** Both templates use `@if` / `@for (… ; track …)`; `CommonModule`
      is no longer imported by either component.
- [x] **Local image placeholder.** Inline data-URI SVG replaces the `placehold.co` fallback,
      guarded so a failing placeholder cannot loop.
- [x] **Derive categories from data.** `GET /api/catalog` now returns a `categories` array
      (`SELECT DISTINCT category, category_label … WHERE is_published`); the client keeps only an
      icon lookup with a `📁` default. Verified against the running stack: it returns `test` and
      `astronomy`, so the three bench scenarios are filterable for the first time.
- [x] **Slug the seeded ids** in `db/init.sql`. Note this only affects a **fresh** volume — the
      init script does not re-run, so an existing database keeps `'Benchscene2 complexmodel'`.
      Confirmed the id path still works for those rows (the client URL-encodes, Express decodes).

**Done when:** the progress ring animates smoothly 0→100% across both download and engine load;
a hard reload of `/play/solar-system` shows the scenario title; a hand-written `?url=` in the
viewer's URL is ignored; every seeded scenario is reachable through a category chip.

*Verified 2026-08-01:* production build clean; `/api/catalog` returns the two real categories;
`/api/catalog/<spaced id>` → 200, unknown id → 404 (the viewer renders "Сценарій не знайдено").
The ring animation itself still wants a manual browser pass — there is no browser automation in
this repo, and Phase 5 is where a spec for the progress accumulator belongs.

---

## Phase 1 — Own the storage (~4–6 days) — **done 2026-08-01**

Google Drive was the biggest single point of failure. `extractDriveConfirmUrl` /
`extractDriveConfirmToken` (`backend/server.js`) parse Drive's large-file warning **HTML** with
regexes; Google can change that page at any time and every scenario stops downloading. Drive also
sent no `Content-Length` on the confirmed response, so the viewer's progress bar fell back to
`percent: -1`, and every student download re-fetched from Drive through the server with no caching.

This is the platform half of the engine's asset-streaming **Stage 0**
(`WebEngineTS/design/asset-streaming-proposal.md`).

- [x] **Migration runner first.** `backend/migrations.js` applies `backend/migrations/*.sql` in
      filename order, each in its own transaction, tracked in `schema_migrations` and serialised by
      a `pg_advisory_lock` so two backends cannot race. Runs before `listen()` — a half-migrated
      schema serving traffic is worse than a restart loop. The SQL lives under `backend/` rather
      than `db/` because the backend build context is `./backend`; `db/init.sql` stays the
      Postgres-entrypoint baseline and seed.
- [x] **Object storage.** Decision: **a plain Docker volume (`virtual_lab_archives`) served by the
      existing nginx**, recorded in `CLAUDE.md`. MinIO is deferred to Stage 3 of
      `scenario-delivery-migration.md`, where presigned URLs and scale actually matter. The volume
      is mounted rw into `backend` and **ro** into `frontend`.
- [x] **Content-addressed archives.** `backend/storage.js` stores `<sha256>.zip`, public path
      `/scenarios/<sha256>.zip`. Uploads land in a temp dir on the same filesystem and are
      committed by rename; identical content dedups to the existing object. ZIP signature is
      checked before anything enters the store.
- [x] **`POST /api/scenarios/:id/archive`** (multipart, admin) plus
      **`POST /api/scenarios/:id/archive/import`** (admin) which pulls an existing external archive
      in — that is the actual migration tool, and it reuses the proxy's allowlist and confirm-page
      handling so the two cannot drift. Migration `001_archive_storage.sql` adds `archive_sha256`,
      `archive_bytes`, `storage_kind`, plus indexes on `is_published` and `archive_sha256`.
- [x] **Serve archives through nginx, not Express.** `location ^~ /scenarios/` aliases the volume
      with `immutable, max-age=1y`. The `^~` is load-bearing: without it the `.zip` regex block
      takes precedence and serves from the SPA root instead.
- [x] **Migrated all four seeded scenarios off Drive** and put the proxy behind
      `LEGACY_DRIVE_PROXY` (410 when off, default on for one release).
- [~] **Simplify the client.** `resolveDownloadUrl` now takes the scenario and emits `?id=` for
      external rows, `/scenarios/…` for local ones. It cannot collapse to "always same-origin"
      until `storage_kind = 'drive'` is gone from the schema — that happens when the flag and the
      Drive code are deleted.

**Done when:** loading a scenario issues zero requests to any external host; the progress bar shows
a real percentage end-to-end; a second load of the same scenario is served from the browser/nginx
cache; `docker compose up` on a machine with no internet access still plays every catalog entry.

*Verified 2026-08-01 with `LEGACY_DRIVE_PROXY=false`:* the proxy returns 410 and all four archives
still download from `/scenarios/…` (18 526 012 / 29 355 486 / 6 601 316 / 5 771 bytes) with a real
`Content-Length`; bytes fetched through nginx hash back to their own filename; range requests
return 206; re-uploading identical content reports `deduplicated: true`; a non-ZIP is rejected 400;
an upload to an unknown scenario is 404 and no longer leaks its temp file.

**Caveat — a from-scratch bootstrap still needs Drive once.** `db/init.sql` seeds Drive URLs, and
`docker compose down -v` drops the archives volume along with the database. A fresh install must
run with `LEGACY_DRIVE_PROXY=true`, import each scenario, then turn it off (documented in
`Readme.md`). The offline guarantee holds for a *running* deployment, not for first boot. Phase 2's
publishing workflow is what removes that dependency for good.

---

## Phase 2 — Publishing workflow (~3–4 days) — **done 2026-08-01**

A scenario used to be published by hand-writing a `curl` POST. ScenarioCreator produces the ZIP and
the editor will need a publish target.

- [x] **`/admin` route in the SPA**, guarded by the admin token in `sessionStorage` (not
      `localStorage` — it dies with the tab). Lists every scenario including unpublished ones,
      create/edit form, publish toggle, delete with confirmation. Backed by the new
      `GET /api/admin/scenarios`, since the public catalog filters `is_published`.
- [x] **Upload UI with progress**, wired to the Phase 1 endpoint; reports the resulting hash, size
      and whether the content deduplicated. Uses `HttpClient` with `reportProgress` + `observe:
      'events'` — `fetch` cannot report *upload* progress at all, only download.
- [x] **Server-side ZIP validation** (`backend/archive-validation.js`, `node-stream-zip`) before
      anything enters the store, with a specific message per failure: unreadable ZIP; no
      `manifest.json` at the root; manifest not valid JSON; missing required fields
      (`manifestVersion`, `id`, `name`, `version`, `entryPoint`); entry point absent from the
      archive.
- [x] **Surface `is_published`** in the admin list — it was previously reachable only through raw
      SQL.
- [x] **Document the publish path** end-to-end in `Readme.md`.

### The "manifest id must match the catalog id" requirement was wrong

The original plan required rejecting an archive whose manifest id differs from the catalog id.
Checked against the real archives, **no scenario satisfies that**: catalog rows use slugs
(`Benchscene1_primitives`) while manifests use reverse-domain ids
(`template.benchscene1.primitives`). The engine never compares them either — `loadScenarioFromBuffer`
receives only the ZIP bytes and never sees the catalog row.

Enforcing equality would have rejected every archive in the system. Instead: migration
`002_manifest_metadata.sql` stores `manifest_id` / `manifest_version`, a mismatch is returned as a
**warning** in the upload response and shown in the admin list, and the stale
"matches the ID inside the ZIP manifest" comment in `scenario.model.ts` was corrected.

**Done when:** a scenario can go from a built ZIP to visible in the catalog without touching a
terminal or the database.

*Verified 2026-08-01 against the running stack:* create → hide → absent from `/api/catalog` but
present in `/api/admin/scenarios` with `isPublished: false` → archive upload (dedup detected,
manifest id reported, mismatch warned) → publish → `/api/catalog/:id` returns it and its archive
fetches 200 → delete → 404. Malformed archives are rejected 400 with the specific reason;
`/api/admin/scenarios` without a token is 401.

---

## Phase 3 — Viewer & catalog robustness (~3–4 days) — **done 2026-08-01**

- [x] **Capability check before constructing `Application`.** A throwaway `webgl2` probe runs first
      (and releases the context via `WEBGL_lose_context`); without WebGL2 the viewer shows a
      `unsupported` state naming the browser requirement instead of a raw constructor exception.
- [x] **Handle WebGL context loss.** `webglcontextlost` is intercepted with `preventDefault()`, the
      loop is stopped and an overlay offers a reload — previously a lost context just froze the
      scene silently.
- [x] **Cancel in-flight downloads on navigate-away.** `downloadScenarioZip` takes an
      `AbortSignal`; the viewer aborts in `ngOnDestroy` and the read loop checks the signal between
      chunks, so leaving mid-download stops the transfer instead of streaming into a dead component.
- [x] **Viewer controls:** restart (re-runs `loadScenarioFromBuffer` on the buffer already in
      memory — no re-download), fullscreen toggle synced to `fullscreenchange`, and a diagnostics
      toggle wired to the engine's `MemoryProfiler.toggleOverlay()` (FPS, CPU frame time, VRAM).
- [x] **Catalog at scale.** `GET /api/catalog` now takes `limit` / `offset` / `category` / `q`,
      returns `total`, and caps `limit` at 100. The UI pages with a "показати ще" button and
      debounces search by 300 ms. Images already had `loading="lazy"`; `decoding="async"` added.
- [x] **Mobile:** an orientation hint on portrait phones under 820 px.
- [x] **Keyboard and screen-reader access.** The scenario card is a real `<button>` with a visible
      focus ring; the modal is a `role="dialog" aria-modal` with a focus trap, Esc to close, and
      focus returned to the card that opened it. Filter chips carry `aria-pressed`, the result
      count is `aria-live`.
- [x] **Theme applied app-wide** — the class now goes on `<html>`, so the viewer follows it too.

### Filtering had to move to the server

Client-side filtering plus server-side pagination is incoherent: the filter would only ever search
the page currently in hand, so "знайдено: N" and the grid would disagree the moment a second page
existed. `category` and `q` are therefore SQL predicates, sharing one `WHERE` with the `COUNT(*)`.
`ScenarioService.filterScenarios` is gone as a result — Phase 5 should test the query instead.
Category chips are still computed over the **whole** published catalog, not the filtered page, or
they would disappear as soon as one was selected.

**Done when:** a browser without WebGL2 gets a clear message; navigating away mid-download aborts
it; the viewer survives a forced context loss; the catalog stays responsive with 100 seeded rows;
the catalog is fully operable from the keyboard.

*Verified 2026-08-01 against the running stack:* `?limit=2&offset=0` and `&offset=2` return
disjoint pages with `total: 4`; `?limit=5000` is capped to 100; `?category=astronomy` narrows to 1
row while still returning both category chips; `?q=Сонячна` finds 1; a miss returns `total: 0`.
Production build is clean.

**Not verified:** the browser-side behaviours — context-loss overlay, fullscreen, the diagnostics
overlay, focus trap and the orientation hint — need a manual pass. There is no browser automation
in this repo; Phase 5 is where that gap should be closed.

---

## Phase 4 — Session telemetry (~1 day) — *scoped down 2026-08-01*

The schema knows about scenarios and nothing else — no record that a student ever opened anything,
so the thesis's deployment section has no numbers to quote. The **scope decision has been taken:
telemetry only, no identity model.** No users, no roles, no courses; the admin token from Phase 0
remains the only credential.

- [ ] `scenario_sessions` table (via the Phase 1 migration runner): `id`, `scenario_id`,
      `started_at`, `ended_at`, `duration_ms`, `user_agent`, and an anonymous `client_id` kept in
      `localStorage` — no personal data.
- [ ] `POST /api/telemetry/session` — public, rate-limited, records the start and returns the row
      id; a follow-up `PATCH /api/telemetry/session/:id` on viewer teardown records the duration.
      Wire it into `ViewerComponent`'s existing state machine: start on `running`, close in
      `ngOnDestroy` next to `app.dispose()`.
- [ ] `GET /api/telemetry/summary` — admin-only: launches and median duration per scenario. Enough
      to say something quantitative about real use.

**Deferred, not cancelled:** `users` with student/teacher roles, session auth replacing the admin
token, `courses` + `course_scenarios`, and a teacher dashboard. Revisit only if a user study is
actually scheduled — at that point this phase moves ahead of Phase 3.

---

## Phase 5 — Quality gates (~3–4 days)

- [ ] **Make the test target runnable.** `angular.json` declares
      `"test": { "builder": "@angular/build:unit-test" }` with no options at all, and there are zero
      `*.spec.ts` files, so `npm test` has never run. Configure the runner against the existing
      `tsconfig.spec.json` (which already sets `types: ["vitest/globals"]`) before writing specs.
- [ ] **Frontend tests.** `vitest` and `jsdom` are already devDependencies
      (`frontend/package.json`) with zero spec files. Start with the logic that has real branching:
      `ScenarioService.filterScenarios` (category + query, including the `?? ''` guards at
      `scenario.service.ts:84`), the download progress accumulator, and the `ViewerComponent` state
      machine (`idle → downloading → loading-engine → running → error`).
- [ ] **Backend tests** with `supertest`: catalog CRUD, the Phase 0 auth middleware, and the proxy
      guard (unknown id refused, allowlisted host passes, redirect off-list refused).
- [ ] **Production environment file.** `angular.json` has no `fileReplacements`, so
      `environment.production` is `false` even in the production bundle
      (`src/environments/environment.ts:4`). Add `environment.prod.ts` and the replacement before
      anything starts branching on the flag.
- [ ] **CI** (`.github/workflows/ci.yml`, none today): install, build the frontend, run both test
      suites, and `docker compose build` to catch Dockerfile drift.
- [ ] **Engine build identity.** Every tarball is version `0.1.0` regardless of content (by design
      in the engine's `release:local`), so a deployed instance cannot report which engine build it
      runs. Have the frontend build stamp the tarball's hash into the bundle and expose it in
      `/api/health` and a UI footer.

**Done when:** CI is green on a PR; the deployed site can name its engine build.

---

## Phase 6 — Streaming client (follows engine work)

Gated on the engine shipping `StreamingAssetSource` (its P1.7 Stages 1–2).

- [ ] Consume manifest-based scenarios alongside the single-ZIP path.
- [ ] Show progressive first paint in the viewer: scene visible after critical assets, remaining
      assets streaming behind it.
- [ ] Measure time-to-first-frame before/after on the same scenario and record it — this is the
      number the thesis's loading-latency claim wants.

---

## Sequencing

```
Phase 0 ──► Phase 0.5 ──► Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 5 ──► Phase 6
                               └──────────────────► Phase 4 (telemetry, ~1 day, any time after 1)
```

Phase 0.5 sits where it does because it is cheap and because a loading UI that reports 0% for the
whole download makes Phase 1's "real progress percentage" success metric unverifiable. Phase 4 only
needs Phase 1's migration runner, so it can slot in wherever it is convenient.

Roughly 14–19 focused days for Phases 0–3 + 5, plus about a day for Phase 4.

## Cross-cutting notes

- **Engine updates** come from `npm run release:local` in the WebEngineTS repo. The engine's UI
  overhaul (canvas HiDPI/scaler/repaint, commit `4a84e99`) has **not** been pushed here yet;
  `frontend/WebEngineTS-0.1.0.tgz` currently shows as modified in the working tree from an earlier
  push. Pull the current engine before starting Phase 3's mobile verification.
- **Do not** add engine or scenario-content code to this repo (see `CLAUDE.md` → Critical rules).
- `Readme.md` uses the old compose service names (`db`, `api`, `web`); the current names are
  `database`, `backend`, `frontend`. Worth a small docs pass during Phase 0.
- **`CLAUDE.md` is wrong about change detection** until Phase 0.5 lands — its "Angular conventions"
  section describes zone-based change detection, but the app has no `zone.js` and bootstraps
  zoneless. Anyone reading it will write `ngZone.run(...)` calls that silently do nothing.
- **Verifying the audit findings** without changing anything:
  ```bash
  cd frontend && grep -c '"node_modules/zone.js"' package-lock.json   # 0 → zoneless
  grep -n "provideZoneChangeDetection" src/app/app.config.ts          # no hits → zoneless
  ls ../.dockerignore                                                 # missing
  curl -i "http://localhost:${FRONTEND_PORT}/api/proxy-download?url=https://storage.googleapis.com/<public-object>"
  ```
