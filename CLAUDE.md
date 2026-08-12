# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Virtual Lab

Web platform ("Віртуальна 3D Лабораторія") that hosts interactive 3D learning scenarios for a
university. Students browse a catalog by subject, open a scenario, and it runs in the browser
over WebGL. Angular SPA + Express API + PostgreSQL + nginx, orchestrated by Docker Compose.

Deployment/operations documentation for end users lives in `Readme.md` (Ukrainian). **This file
is the working guide**: architecture, conventions, and the rules that are easy to break.

## Ecosystem position

This is the **consumer** end of a four-repo ecosystem (all under `C:\Users\Work\WebstormProjects\`):

- **WebEngineTS** — the 3D engine, a consumable npm library. Ships here as a packed tarball
  (`frontend/WebEngineTS-0.1.0.tgz`, a `file:` dependency).
- **ScenarioCreator** — build pipeline that compiles scenario source into distributable `.zip`
  archives. Scenario *content* lives there, never here.
- **WebEngineTSEditor** — the graphical scenario editor; another engine consumer. Will eventually
  publish scenarios into this platform.

Data flow is one-directional: **engine → tarball → this repo**. This repo never exports anything
back, and the engine never imports from it.

**Engine updates arrive via `npm run release:local` run in the WebEngineTS repo** — it builds,
packs, copies the tarball here and reinstalls it. Do not hand-edit the tarball or the dependency
spec. The **tarball filename** stays `WebEngineTS-0.1.0.tgz` while the content changes every run,
so the dependency spec never needs touching. The package *inside* is stamped
`0.1.0-local.<timestamp>` and `frontend/package-lock.json` records it.

**Which engine build is running is answerable at run time: `BuildInfo`** (`version` / `builtAt` /
`isBuild`), rendered by the viewer under `?diag=1`. `builtAt` is the field that identifies a
build. Do **not** use `Application.version` for this — it is a string literal fixed at `"0.1.0"`
across every local pack, so it cannot tell two builds apart.

Two different questions, deliberately answered in different places:

| Question | Where |
|---|---|
| Which engine is running scenarios? | `BuildInfo`, viewer under `?diag=1` |
| Which engine was this scenario built against? | `scenarios.manifest_engine_version`, shown in `/admin` |
| Which API build is serving? | `GET /api/health` → `build` |

`/api/health` reports the **API's** build only, never the engine's: the engine bundle runs in the
browser and the backend cannot observe it, so restating it there would drift the moment a tarball
was installed without a backend rebuild.

## Architecture

Three containers behind one port (`docker-compose.yml`):

```
browser → nginx :80 ─┬─ /            → Angular SPA (static)
                     ├─ /scenarios/* → archives volume (content-addressed ZIPs)
                     └─ /api/*       → backend:3000 (Express)
                                          └─ database:5432 (PostgreSQL)
```

Runtime flow for playing a scenario:

1. Catalog page fetches `GET /api/catalog` → Express → `SELECT` from `scenarios` → JSON.
2. Student picks a scenario; the viewer resolves it by id (`GET /api/catalog/:id`) and downloads
   the archive from `scenario_url`. Normally that is `/scenarios/<sha256>.zip`, served straight
   off the archives volume by nginx. Legacy Drive rows fall back to
   `GET /api/proxy-download?id=…` (the URL never comes from the client).
3. The ZIP `ArrayBuffer` goes to `Application.loadScenarioFromBuffer`, which unpacks it,
   validates the manifest, and runs the scenario's entry point.

## Scenario storage

**Decision (Phase 1): a plain Docker volume served by the existing nginx.** MinIO/S3 was the
alternative and is deferred until presigned URLs or horizontal scale actually matter
(`docs/scenario-delivery-migration.md`, Stage 3).

- Archives are **content-addressed**: `virtual_lab_archives:/srv/archives/objects/<sha256>.zip`,
  public path `/scenarios/<sha256>.zip`. The name is the content, so the object is immutable —
  nginx serves it `immutable, max-age=1y`, and re-uploading identical bytes is free (dedup).
- The volume is mounted **rw into backend** (uploads) and **ro into frontend** (serving).
  Express must never stream archive bytes; nginx gives Range requests and a real `Content-Length`.
- `scenarios.storage_kind` is `local` or `drive`; `archive_sha256` / `archive_bytes` carry
  integrity and size.
- **The catalog id and the manifest id are different things.** Catalog rows use slugs
  (`solar-system`); the ZIP's `manifest.json` uses reverse-domain ids
  (`template.benchscene1.primitives`). The engine never compares them —
  `loadScenarioFromBuffer` only receives bytes — so upload treats a mismatch as a *warning* and
  records `manifest_id`. Enforcing equality would reject every archive that exists today.
- Uploads land in `/srv/archives/tmp` first and are committed by rename. Every exit path must
  release the temp file — an early `return` inside the handler's `try` leaked one until it was
  wrapped in `finally`.

## Key components

**Frontend** (`frontend/`, Angular 21, standalone components, project name `university-mock`)
- `src/app/pages/catalog/` — catalog: category filter, search, paging, detail modal, dark mode.
  **Filtering and paging are server-side** (`?category=&q=&limit=&offset=`) — a client-side filter
  over a paged response would only ever search the page in hand.
- `src/app/pages/viewer/` — the 3D host: canvas, load progress, error states, engine lifecycle,
  restart / fullscreen, WebGL2 probe and context-loss handling. The `MemoryProfiler` overlay is a
  **measurement tool, not a student control**: the button only renders with `?diag=1` on the
  viewer URL, and `toggleDiagnostics()` refuses without the flag too, so the profiler's rAF loop
  is never created rather than merely hidden.
- `src/app/pages/admin/` — `/admin`: list including unpublished rows, create/edit, publish
  toggle, delete, archive upload with progress. The token lives in `sessionStorage`
  (`AdminService`), so it dies with the tab.
- `src/app/services/scenario.service.ts` — catalog state as **signals**, paged fetching, and the
  streamed ZIP download with progress and abort.
- `src/app/services/admin.service.ts` — admin token + CRUD + upload with progress.
- `src/app/services/telemetry.service.ts` — anonymous session log; failures are swallowed, since
  telemetry must never break playback.
- `src/app/models/scenario.model.ts` — `ScenarioCatalogItem` / `ScenarioCatalogManifest`. This is
  the **platform's** catalog model, deliberately separate from the engine's `IScenarioManifest`
  that lives inside the ZIP. The engine never sees this model.
- `src/environments/environment.ts` — `catalogUrl`, currently `/api/catalog`.

**Backend** (`backend/`, Express 4 — `server.js` plus two small modules)
- `GET /api/catalog`, `GET /api/catalog/:id` — published scenarios only (`is_published = true`).
  The catalog response also carries the distinct `categories` in use.
- `POST /api/catalog`, `PUT /api/catalog/:id`, `DELETE /api/catalog/:id` — catalog mutation,
  **admin only** (`Authorization: Bearer $ADMIN_TOKEN`).
- `GET /api/admin/scenarios` — admin; every row including unpublished, with storage and manifest
  metadata.
- `POST /api/scenarios/:id/archive` — admin, multipart field `archive`; validates the ZIP
  (`archive-validation.js`), then stores it under its sha256 and repoints the scenario at it.
- `POST /api/scenarios/:id/archive/import` — admin; pulls the scenario's existing external archive
  into local storage. This is the migration path off Drive.
- `GET /api/proxy-download?id=…` — legacy Drive proxy, gated by `LEGACY_DRIVE_PROXY` (410 when
  off). Takes a **scenario id**, never a URL; redirects are followed manually with the hostname
  allowlist re-checked on every hop.
- `POST /api/telemetry/session` and `.../:id/end` — public, anonymous session log. The end call
  is a POST so `sendBeacon` can deliver it during unload; duration is computed server-side.
- `GET /api/telemetry/summary` — admin; launches and median duration per scenario.
- `GET /api/health` — liveness plus a DB ping.
- `migrations.js` applies `backend/migrations/*.sql` at startup under an advisory lock;
  `storage.js` owns the content-addressed archive store.

**Database**
- `db/init.sql` — base table + seed. Runs **only** when Postgres creates its data directory, so it
  cannot carry schema changes; `docker compose down -v` resets it.
- `backend/migrations/*.sql` — every schema change after the baseline. Idempotent DDL, applied by
  the backend on boot. **Add schema changes here, never to `init.sql`.**

**nginx** (`nginx/nginx.conf`) — SPA fallback, `/api/` reverse proxy, `^~ /scenarios/` archive
serving (the `^~` is required or the `.zip` regex block wins), `no-cache` on `index.html`,
30-day immutable caching for hashed assets, security headers, gzip.

## Engine integration (the part that is easy to break)

The engine is resolved **twice, differently**, and both paths must stay in sync:

- **Build time / types:** `WebEngineTS: file:WebEngineTS-0.1.0.tgz` in `frontend/package.json`.
  `angular.json` lists `WebEngineTS` under `externalDependencies`, so Angular does not bundle it.
- **Runtime:** the import map in `frontend/src/index.html` maps `"WebEngineTS"` to
  `/assets/WebEngineTS.standalone.js`, copied by the `angular.json` assets rule from
  `node_modules/WebEngineTS/dist`. The **standalone** build has Three.js bundled inside, which is
  why `three` is not a dependency here (only `@types/three`).

Consequences to respect:
- Import only from `"WebEngineTS"`. Never from `three` or from engine internals — the engine
  hides Three.js on purpose, and a second Three.js instance would break its `instanceof` checks.
- `frontend/WebEngineTS-0.1.0.tgz` **is intentionally committed** (there is no registry to fetch
  it from at Docker build time). Do not gitignore it.
- `Dockerfile.frontend` uses `npm install`, not `npm ci`, on purpose: the lockfile is generated on
  Windows where `@napi-rs/nice` resolves to a native MSVC binary, while Alpine falls back to the
  wasm runtime and pulls `@emnapi/*` peers the Windows lockfile cannot record.
- **The KTX2 transcoder is served by the host, not the engine.** `ViewerComponent` sets
  `Texture2D.ktx2TranscoderPath = '/assets/basis/'` before any scenario loads. The engine's
  default is `/basis/`, which 404s here because Angular publishes `src/assets` under `/assets` —
  and it fails **silently** until a scenario actually ships `.ktx2` textures. The transcoder
  itself lives in `frontend/src/assets/basis/` (`basis_transcoder.js` + `.wasm`) and is committed
  for the same reason as the engine tarball: nothing fetches it at build time.

## Angular conventions

- **Standalone components** with `ChangeDetectionStrategy.OnPush` throughout.
- **The app is zoneless — do not write `NgZone` code.** There is no `zone.js` dependency, and
  `app.config.ts` states `provideZonelessChangeDetection()` explicitly. An injected `NgZone` would
  be a no-op, so `ngZone.runOutsideAngular(...)` / `ngZone.run(...)` are dead code.
- **UI state is signals.** A signal write is what notifies the zoneless scheduler; mutating a plain
  field from an async callback never repaints. That was a real bug — the viewer's progress ring sat
  at 0% for entire downloads because its callbacks assigned to fields. Components read service
  signals directly (`ScenarioService.scenarios/loading/error/categories`) instead of subscribing,
  and derive with `computed`. The engine's `requestAnimationFrame` loop is outside change detection
  by construction, so it needs no special handling.
- **Always dispose the engine.** `ViewerComponent.ngOnDestroy` calls `app.dispose()`; without it
  the WebGL context leaks and a few navigations exhaust the browser's context limit.
- UI strings are Ukrainian. Code comments and identifiers should be English (the codebase
  currently mixes Russian/Ukrainian/English comments — new code is English).
- **`fakeAsync()` does not work** — it is a zone.js helper and this app is zoneless. Use
  vitest fake timers (`vi.useFakeTimers()` / `vi.advanceTimersByTime()`) in specs.
- **Signal state settles in a microtask** after an awaited HTTP call, so a `flush()` in a spec
  must be followed by `await Promise.resolve()` before asserting on the result.

## Build & Dev

```bash
# Tests
cd backend  && npm test           # 148 tests; needs docker-compose.test.yml up
cd frontend && npx ng test --no-watch   # 60 tests
docker compose -f docker-compose.test.yml up -d   # throwaway Postgres on :55432

docker compose up --build -d      # full stack on ${FRONTEND_PORT}
docker compose logs -f            # all services
docker compose down               # stop
docker compose down -v            # stop + wipe the database volume
docker compose exec database psql -U $DB_USER -d $DB_NAME

cd frontend && npm start          # Angular dev server alone (needs the API for /api/catalog)
cd frontend && npm run build      # production bundle → dist/university-mock/browser
cd backend   && npm run dev       # Express with --watch
```

Service names in compose are `database`, `backend`, `frontend` — `Readme.md` still refers to
`db`, `api`, `web` in a few commands.

## Critical rules

1. **No engine code here.** Rendering, scene, math and scenario-runtime concerns belong in
   WebEngineTS. If something needs an engine change, change it there and re-run `release:local`.
2. **No scenario content here.** Scenario sources live in ScenarioCreator; this repo stores only
   catalog metadata and (soon) the built archives.
3. **One-directional dependency.** Nothing in this repo may be imported by the engine.
4. **Secrets never in git.** `.env` is untracked and ignored; `.env.example` is the template.
   The pre-Phase-0 password is still in git history — treat it as burned, not as recoverable.
   Catalog writes need `Authorization: Bearer $ADMIN_TOKEN`.
5. `frontend/node_modules` and `frontend/.angular` were force-added before `.gitignore` covered
   them and have since been untracked (`git rm --cached`, working tree untouched). Do not re-add.

## Roadmap

**What is next: [`docs/roadmap.md`](docs/roadmap.md)** — republishing the rebuilt scenarios,
verifying KTX2 end to end, runtime engine-build identity, Playwright E2E, archive GC, CSP.

**What already landed and why: [`docs/implementation-plan.md`](docs/implementation-plan.md)** —
phases 0–5, closed history with per-phase verification notes.

Summary of the phases and why they were ordered this way:

| Phase | Theme | Why here |
|---|---|---|
| 0 ✅ | Security & hygiene | Tracked `.env`, unauthenticated write endpoints and a proxy that will fetch any URL a client hands it make any public deployment indefensible. Blocks everything else. |
| 0.5 ✅ | Correctness quick wins | Cheap fixes to confirmed defects — chiefly the zoneless progress bar that reports 0% for an entire download, which would otherwise make Phase 1's success metric unverifiable. |
| 1 ✅ | Own the storage | Google Drive is the platform's single biggest fragility: the proxy scrapes Drive's HTML confirmation page with regexes. Also unlocks real download progress and caching. Matches the engine's asset-streaming Stage 0. Starts with a migration runner, since `db/init.sql` only ever runs on an empty volume. |
| 2 ✅ | Publishing workflow | Scenarios are currently added with hand-written `curl`. Needed before the editor can publish. |
| 3 ✅ | Viewer & catalog robustness | Capability checks, context-loss recovery, cancellable downloads, fullscreen/restart, keyboard access. |
| 4 ✅ | Session telemetry | ✅ done. One `scenario_sessions` table and three endpoints — no users, roles or courses. Duration is computed server-side; sessions survive scenario deletion. |
| 5 ✅ | Quality gates | 208 tests (148 backend, 60 frontend) + CI. Plan: [`docs/test-plan.md`](docs/test-plan.md); browser-only checks: [`docs/manual-browser-checks.md`](docs/manual-browser-checks.md). |
| 6 ⛔ | Streaming client | Blocked: `StreamingAssetSource` is not in the installed engine build (checked 2026-08-02). Tracked as R8 in the roadmap. |

Phases 0–1 are the ones that changed whether this could be deployed at all; 2–3 made it usable by
someone other than its author; 4–6 are growth. Everything through Phase 5 is done — new work goes
in [`docs/roadmap.md`](docs/roadmap.md), not here.
