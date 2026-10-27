# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Shared context (all repos)

Loaded from a directory outside this repository, so every project's session sees the same
ecosystem map and the same live status. Edit those files rather than duplicating them here.

@../../.claude-shared/ECOSYSTEM.md
@../../.claude-shared/ENGINE-GAPS.md


# Virtual Lab

Web platform ("Віртуальна 3D Лабораторія") that hosts interactive 3D learning scenarios for a
university. Students browse a catalog by subject, open a scenario, and it runs in the browser
over WebGL. Angular SPA + Express API + PostgreSQL + nginx, orchestrated by Docker Compose.

Deployment/operations documentation for end users lives in `Readme.md` (Ukrainian). **This file
is the working guide**: architecture, conventions, and the rules that are easy to break.

## Ecosystem position

This is the **consumer** end of a four-repo ecosystem (all under `C:\Users\HuGox\WebstormProjects\`):

- **WebEngineTS** — the 3D engine, a consumable npm library. Ships here as a packed tarball
  (`frontend/WebEngineTS-0.1.0.tgz`, a `file:` dependency).
- **ScenarioCreator** — build pipeline that compiles scenario source into distributable `.zip`
  archives. Scenario *content* lives there, never here.
- **WebEngineTSEditor** — the graphical scenario editor; another engine consumer. Will eventually
  publish scenarios into this platform.

Data flow is one-directional: **engine → tarball → this repo**. This repo never exports anything
back, and the engine never imports from it.

**Findings that belong to those repos live in [`docs/upstream/`](docs/upstream/)** — things
discovered here that this repo cannot fix, with evidence and repro steps. Check there before
re-investigating something odd about the engine or an archive; it is probably already written up.

**Engine updates arrive via `npm run release:local` run in the WebEngineTS repo** — it builds,
packs, copies the tarball here and reinstalls it. Do not hand-edit the tarball or the dependency
spec. The **tarball filename** stays `WebEngineTS-0.1.0.tgz` while the content changes every run,
so the dependency spec never needs touching. The package *inside* is stamped
`0.1.0-local.<timestamp>` and `frontend/package-lock.json` records it.

**Which engine build is running is answerable at run time: `BuildInfo`** (`version` / `builtAt` /
`isBuild`), rendered by the viewer under `?diag=1` (the stamp is all that flag does). `builtAt` is the field that identifies a
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
                     ├─ /a/*         → assets volume (per-asset store, streaming)
                     ├─ /player/*    → the engine's sandboxed player (static, own CSP)
                     └─ /api/*       → backend:3000 (Express)
                                          └─ database:5432 (PostgreSQL)
```

Runtime flow for playing a scenario:

1. Catalog page fetches `GET /api/catalog` → Express → `SELECT` from `scenarios` → JSON.
2. Student picks a scenario; the viewer resolves it by id (`GET /api/catalog/:id`) and downloads
   the archive from `scenario_url` — always `/scenarios/<sha256>.zip`, served straight off the
   archives volume by nginx. There is no fallback and no proxy: the server never fetches an
   archive from anywhere. An off-origin `scenario_url` is a misconfigured row.
3. The viewer keeps the ZIP as a `Blob` and hands it to `PlayerHost`, which passes it to the sandboxed
   player (`/player/player.html`, an `<iframe>` on an opaque origin). **Inside the frame**
   `Application.loadScenarioFromBuffer` unpacks it, validates the manifest and runs the scenario's entry
   point. The platform page runs no scenario code and holds no engine: a scenario cannot reach the API,
   the admin token in `sessionStorage` or `/editor/`.

## Scenario storage

**Decision (Phase 1): a plain Docker volume served by the existing nginx.** An S3-compatible object
store (SeaweedFS, Garage or hosted S3 are the candidates) is deferred until presigned URLs or
horizontal scale actually matter (`docs/scenario-delivery-migration.md`, Stage 3).

- Archives are **content-addressed**: `virtual_lab_archives:/srv/archives/objects/<sha256>.zip`,
  public path `/scenarios/<sha256>.zip`. The name is the content, so the object is immutable —
  nginx serves it `immutable, max-age=1y`, and re-uploading identical bytes is free (dedup).
- The volume is mounted **rw into backend** (uploads) and **ro into frontend** (serving).
  Express must never stream archive bytes; nginx gives Range requests and a real `Content-Length`.
- `storage_kind` is `local` for every row and the column is now vestigial: `drive` was the only
  other value and that path is deleted. Kept because dropping a column is not worth a migration
  on its own. `archive_sha256` / `archive_bytes` carry integrity and size.
- **The catalog id and the manifest id are allowed to differ, and currently do not.** Upload
  records `manifest_id` and treats a mismatch as a *warning*, never a rejection, because the
  engine does not compare them — `loadScenarioFromBuffer` only receives bytes. Older archives used
  reverse-domain ids (`template.benchscene1.primitives`) against slug catalog ids; ScenarioCreator
  now emits the slug, and all 13 rows agree. **Do not turn the warning into an error on that
  basis** — it would reject any older archive, and nothing at run time needs the two to match.
- **Nothing the student player would misread is stored.** Upload, `publish:release` and
  `import:assets` refuse a `*.scene.json` / `*.prefab.json` whose `version` the player does not read
  (only 1; the player checks none, so a version-2 "link mode" scene would load hollow), and a
  `manifestVersion` major or streaming `schema` it does not know. What it reads, and when to raise
  it, is stated once in `backend/player-formats.js`.
- Uploads land in `/srv/archives/tmp` first and are committed by rename. Every exit path must
  release the temp file — an early `return` inside the handler's `try` leaked one until it was
  wrapped in `finally`.

**Streaming delivery (the second store, `/a/`).** A scenario can also be served as a *manifest* of
individually-fetched files rather than one ZIP (`Application.loadScenarioFromManifest`). Populated
by `npm run import:assets`; proven end to end and exposed in the catalog, but opt-in in the viewer.

- Layout: `virtual_lab_assets:/srv/assets` holding `<scenario id>.json` beside
  `objects/<2 chars>/<sha256>.<ext>`. Two-level sharding, as ScenarioCreator emits.
- **The manifest must sit one level above `objects/`, and its URLs must stay relative.** The engine
  *joins* an asset URL onto the manifest's directory as a string — it does not resolve it, and a
  leading `/` is not treated as absolute. `/a/<id>.json` + `objects/aa/…` → `/a/objects/aa/…`; a
  manifest in a subdirectory produced `/a/manifests//a/objects/…` and 404s.
- Release manifests use **two** conventions: `objects/…` at the release root, `../objects/…` for
  the bench scenes one directory deeper. Normalise both — and note `path.join(dir, '../x')` escapes
  `dir`, which is how objects first landed outside the store.
- It cannot reuse `/scenarios/`: that location forces `default_type application/zip`, and a browser
  refuses to execute an ES module served as one.
- Assets are addressed by **`path`** (+ optional `guid`), never by `id`. The `"id": "earth_albedo"`
  shape in `docs/scenario-delivery-migration.md` §3.1 predates the engine and is wrong.
- `scripts` + `entry` are what make a manifest *runnable*; one listing only assets is a valid asset
  source but not a scenario.
- `scenarios.manifest_url` records it; the catalog exposes `manifestUrl` beside `scenarioUrl`. Both
  coexist — the row does not commit to one delivery path.
- **The viewer takes this path only with `?stream=1`.** It is measurably *not* faster to first
  frame on the hardware tested and holds ~2.9× the texture VRAM, so defaulting to it would be a
  student-visible regression for an unproven win (`../../.claude-shared/PLAN.md`). A streamed run keeps no
  buffer, only its manifest URL, so **restart opens a fresh frame on the same manifest**. The URL is
  absolutised against `location.href` first: the player refuses a relative one.
- There is deliberately **no `scenario_assets` table and no `/api/scenarios/:id/manifest`**: the
  manifest already lists every asset and is served statically, so both would duplicate it without
  a reader. Add the table when GC (R5) needs reference counting.

## Key components

**Frontend** (`frontend/`, Angular 21, standalone components, project name `university-mock`)
- `src/app/pages/catalog/` — the Nocturne catalog (sort segment, icon chips, card grid; no hero, and the
  footer is the copyright bar only). **Filtering, search, sorting and paging are server-side**
  (`?category=&q=&sort=&limit=&offset=`) — a client-side filter over a paged response would only ever
  search the page in hand. **The URL's query string (`category`, `q`, `sort`; defaults omitted) is the
  only holder of the filter** (`services/catalog-query.ts`): controls navigate, an effect loads, Back works.
- `src/app/pages/scenario/` — `/scenario/:id`, which replaced the details modal: fields, "Що всередині",
  related scenarios, copy link (falls back to a selectable field when the Clipboard API is missing — the
  server runs plain HTTP), not-found and error states, a sticky launch bar on narrow
  screens. The viewer's exit target.
- `src/app/pages/viewer/` — the 3D host. It drives `PlayerHost` (from `WebEngineTS/player-host`, the only
  engine import the app has) and holds no engine: the scenario renders in the player frame the host
  creates. The page owns load progress, error states (a handshake, origin or version failure becomes
  Ukrainian copy; a runtime error inside the scenario shows nothing and keeps the scene), the WebGL2
  probe, context loss, cancel/exit and fullscreen (of `.viewer-container`; the frame gets no `fullscreen`
  permission). **Restart is always a fresh frame** — the old one is removed — from the retained `Blob`
  (ZIP, no second download) or the manifest URL (`?stream=1`). **Pause** is the HUD button or **Space with
  either focus**: with the host focused the page handles it, with the frame focused (the viewer focuses it
  after load) the engine's player does, and both end in the player's `paused` report; one key press never
  toggles twice. FPS also comes from the player. The `MemoryProfiler` overlay is **off on the platform**: it
  is engine API and a measurement tool, developed separately, not a student control. The host always sends
  `diag: false` and never calls `toggleDiagnostics()`, and the engine's `diagnosticsAllowed` latches at
  `false`, so a scenario's own `showOverlay()` / `enableToggle()` (the Backquote hotkey) are inert; there
  is no page-side guard. `?diag=1` shows only the engine build stamp, read from the player with
  `PlayerHost.measure()` about a second after the run starts; the HUD has no diagnostics control. Whether
  the overlay belongs in a scenario is ScenarioCreator's question; the platform never shows it.
- `src/app/pages/admin/` — `/admin`: list including unpublished rows, create/edit (including the
  "Що всередині" editor, up to six entries), publish toggle, delete, archive upload with progress. The token lives in `sessionStorage`
  (`AdminService`), so it dies with the tab.
- `src/app/services/scenario.service.ts` — catalog state as **signals**, paged fetching (a response for an
  older request is dropped, so the newest filter always wins), `fetchScenarioById` (with `related`), and
  the streamed ZIP download with progress and abort. (`GET /api/config` stays on the backend; the
  frontend no longer reads it — the footer's archive-limit line went with the footer's main block.)
- `src/app/services/admin.service.ts` — admin token + CRUD + upload with progress.
- `src/app/services/telemetry.service.ts` — anonymous session log; failures are swallowed, since
  telemetry must never break playback.
- `src/app/models/scenario.model.ts` — `ScenarioCatalogItem` / `ScenarioCatalogManifest`. This is
  the **platform's** catalog model, deliberately separate from the engine's `IScenarioManifest`
  that lives inside the ZIP. The engine never sees this model.
- `src/environments/environment.ts` — `catalogUrl`, currently `/api/catalog`.

**Backend** (`backend/`, Express 4 — `server.js` plus a few small modules)
- `GET /api/catalog?category&q&sort=new|title&limit&offset`, `GET /api/catalog/:id` — published
  scenarios only (`is_published = true`). Each item carries `archiveBytes`, `updatedAt` and
  `features` ("Що всередині"); the list also returns `categories` (visible, with `icon` and published
  `count`, by `categories.sort_order`) and an unfiltered `summary`; the by-id route adds `related`
  (<=2, same category first). `categories.label` is canonical over `scenarios.category_label`; a POST/PUT
  with an unknown slug creates the category (`ensureCategory`), a known slug keeps its label. Admin
  `features` are validated by `catalog-input.js` (<=6 items, icon `^[a-z0-9-]{1,40}$`, title 1-60,
  subtitle <=90).
- `GET /api/config` — public, `{maxArchiveBytes}`. The cap is `MAX_ARCHIVE_BYTES` (default 200 MiB,
  read once at load); an oversize upload is a 413. multer's limit is set to cap + 1 because busboy fires
  on *reaching* `fileSize`, not exceeding it. nginx's `client_max_body_size` (512m) must stay above it.
- `POST /api/catalog`, `PUT /api/catalog/:id`, `DELETE /api/catalog/:id` — catalog mutation,
  **admin only** (`Authorization: Bearer $ADMIN_TOKEN`).
- `GET /api/admin/scenarios` — admin; every row including unpublished, with storage and manifest
  metadata.
- `GET /api/admin/storage` / `POST /api/admin/storage/gc` — admin; what the archive store holds and
  how much of it nothing references. **The sweep is a dry run unless `{"dryRun": false}`.**
  Collection is decided by "no row references this hash", never by "a row was deleted" — dedup
  means one object may back several rows. Objects younger than `GC_MIN_AGE_MS` are spared, because
  `commitArchive` stores an object before the row that points at it.
- `POST /api/scenarios/:id/archive` — admin, multipart field `archive`; validates the ZIP
  (`archive-validation.js`, with the formats from `player-formats.js`), then stores it under its
  sha256 and repoints the scenario at it.
- **There is no download proxy and no import-from-URL endpoint.** Both existed for Google Drive
  and are deleted, along with the URL rewriting, confirmation-page scraping and host allowlist
  that backed them. Archives only ever arrive by upload. A test asserts both routes stay 404 —
  the proxy was an open relay once, and code shaped like that with no callers is a liability.
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

**CSP** (`nginx/csp.conf`) — every directive was measured, not guessed. The platform page runs no
scenario code, so `script-src` is **`'self'`** alone: no `blob:` and no nonce on `/`. `frame-src 'self'`
admits the player frame. `'unsafe-eval'` is deliberately absent (the platform page never needs it, and
`csp.spec.ts` keeps it out). `worker-src` and `img-src` still allow `blob:` (decoded textures; nothing
there executes). Two other policies sit beside it:

- **`/player/`** carries the engine's own header snippet, `player.nginx.conf` (copied out of the tarball
  by `Dockerfile.frontend`): a CSP that names `$scheme://$http_host` rather than `'self'`, `'unsafe-eval'`
  for the KTX2 transcoder, `frame-ancestors 'self'`, `sandbox allow-scripts allow-pointer-lock`, and no
  `X-Frame-Options`. The headers belong to the engine; do not loosen them here. `^~ /player/` keeps the
  static-asset regex block off it, and any other path under it is a 404.
- **`/editor/`** (`docker-compose.editor.yml`) still has an inline import map and still runs on the
  platform origin. `editor.conf` stamps the CSP nonce on it with `sub_filter` (Chromium ignores CSP
  hashes for import maps) and includes `csp-editor.conf`, which keeps `blob:` and the nonce.

`ACAO: *` is set on exactly what the opaque frame fetches (its `Origin` is `null`): the player files, the
engine bundle, the basis transcoder and `/a/`. `add_header` does not inherit into a location that sets its
own, so `csp.conf` is `include`d in each.

**nginx** (`nginx/nginx.conf`) — SPA fallback, `/api/` reverse proxy, `^~ /scenarios/` archive
serving (the `^~` is required or the `.zip` regex block wins), `no-cache` on `index.html`,
30-day immutable caching for hashed assets, security headers, gzip.

## Engine integration (the part that is easy to break)

**The page no longer imports the engine.** The Angular app imports only `WebEngineTS/player-host`
(`PlayerHost`, an engine-free host client that is bundled with the app). The engine runs in the
sandboxed player frame, and everything the frame loads is a static file the platform serves out of the
tarball:

- **Build time:** `WebEngineTS: file:WebEngineTS-0.1.0.tgz` in `frontend/package.json`. The `angular.json`
  assets rules copy from `node_modules/WebEngineTS/dist` the standalone bundle to
  `/assets/WebEngineTS.standalone.js` (Three.js is bundled inside it, which is why `three` is not a
  dependency here, only `@types/three`) and `player/{player.html,player.js}` to `/player/`.
  `Dockerfile.frontend` also copies `player.nginx.conf` into the nginx image, because nginx cannot
  include from `node_modules` at run time.
- **Runtime:** there is **no import map on `/`**. The viewer gives `PlayerHost` the player URL
  (`/player/player.html`), the bundle URL and the transcoder path; the player sets
  `Scenario.engineModuleUrl`, so the engine's pre-linker rewrites a scenario's bare `"WebEngineTS"`
  import to that absolute URL.
- **`WebEngineTS` is no longer under `externalDependencies` in `angular.json`, and must not go back:**
  esbuild treats it as covering subpaths, which leaves `WebEngineTS/player-host` an unresolvable bare
  import.

Consequences to respect:
- Import only from `"WebEngineTS/player-host"`. Never from `"WebEngineTS"` itself (that would pull a
  second engine into the page), `three` or engine internals — the engine hides Three.js on purpose, and
  a second Three.js instance would break its `instanceof` checks.
- The player's files, headers and handshake are the engine's. Changing them is an engine change plus
  `release:local`, which refuses a tarball that lacks `dist/player/`.
- `frontend/WebEngineTS-0.1.0.tgz` **is intentionally committed** (there is no registry to fetch
  it from at Docker build time). Do not gitignore it.
- `Dockerfile.frontend` uses `npm install`, not `npm ci`, on purpose: the lockfile is generated on
  Windows where `@napi-rs/nice` resolves to a native MSVC binary, while Alpine falls back to the
  wasm runtime and pulls `@emnapi/*` peers the Windows lockfile cannot record.
- **The KTX2 transcoder is served by the host, not the engine.** The viewer passes
  `transcoderPath: '/assets/basis/'` to `PlayerHost`; the player sets `Texture2D.ktx2TranscoderPath`
  from it before any scenario loads. The engine's default is `/basis/`, which 404s here because Angular
  publishes `src/assets` under `/assets` — and it fails **silently** until a scenario actually ships
  `.ktx2` textures. KTX2 transcodes inside the frame (`e2e/tests/ktx2-render.spec.ts` renders one). The
  transcoder itself lives in `frontend/src/assets/basis/` (`basis_transcoder.js` + `.wasm`) and is
  committed for the same reason as the engine tarball: nothing fetches it at build time.

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
cd backend  && npm test           # 348 tests; needs docker-compose.test.yml up
cd frontend && npx ng test --no-watch   # 293 tests
cd frontend && npm run test:scripts     # the CSP checker's own tests (node --test)
cd frontend && npm run build && npm run check:csp   # built index.html: no import map, nonce or blob: script-src
cd e2e      && npm test           # 104 Playwright tests (a few skip: by design, or editor-csp without its stack);
                                  # needs the stack up AND a published catalog — see e2e/README.md
docker compose -f docker-compose.test.yml up -d   # throwaway Postgres on :55432

# /editor/'s import-map nonce (editor-csp.spec.ts) needs a stack that serves /editor/. A self-contained
# harness (real frontend image + editor.conf + csp-editor.conf, stub upstreams) is in e2e/editor-csp-harness/:
docker compose -p vl-editor-csp -f e2e/editor-csp-harness/docker-compose.yml up --build -d
cd e2e && ADMIN_TOKEN=x E2E_BASE_URL=http://localhost:8046 npx playwright test editor-csp
docker compose -p vl-editor-csp -f e2e/editor-csp-harness/docker-compose.yml down --remove-orphans --rmi local

# Publishing a ScenarioCreator release into the catalog
cd backend && npm run publish:release -- --dry-run
cd backend && npm run verify:ktx2    # checks supercompression from the archive bytes
cd backend && npm run import:assets  # per-asset store for the streaming path (/a/)

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

**What is next: [`../../.claude-shared/PLAN.md`](../../.claude-shared/PLAN.md)** — R1–R6 and R10 all landed 2026-08-13.
What remains: R7 (mostly ScenarioCreator's), R8 (streaming — blocked on a real-GPU measurement,
not on code), R9 (optional). [`../../.claude-shared/PLAN.md`](../../.claude-shared/PLAN.md) records what each one turned
up, including several findings that contradict older notes in these docs.

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
| 5 ✅ | Quality gates | 218 unit tests (158 backend, 60 frontend) + 35 Playwright (`e2e/`) + CI. Plan: [`docs/test-plan.md`](docs/test-plan.md); what still needs human eyes: [`docs/manual-browser-checks.md`](docs/manual-browser-checks.md). |
| 6 🚧 | Streaming client | Unblocked and half done. A scenario runs from a manifest and renders the same scene as its ZIP (`/a/`, `npm run import:assets`, `e2e/tests/streaming.spec.ts`). Catalog/viewer integration and the latency claim are still open — see [`../../.claude-shared/PLAN.md`](../../.claude-shared/PLAN.md). |

Phases 0–1 are the ones that changed whether this could be deployed at all; 2–3 made it usable by
someone other than its author; 4–6 are growth. Everything through Phase 5 is done — new work goes
in [`../../.claude-shared/PLAN.md`](../../.claude-shared/PLAN.md), not here.
