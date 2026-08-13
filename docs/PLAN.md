# Virtual Lab — plan

Drafted 2026-08-11, against branch `phases-0-3-hardening` (`2af1c244`).
Progress log at the bottom: [what has been done](#progress).

This is the **sequenced execution plan** given the engine that just landed. It does not restate
[`roadmap.md`](roadmap.md) — that document owns the item descriptions and the R-numbers, and
they still stand. This one says what to do first and why, and records what changed underneath.

Companion to the engine's [`design/handoff-boundary.md`](../../../WebEngineTS/design/handoff-boundary.md),
which paused engine feature work in favour of the consumer repositories.

---

## What changed underneath you

The installed engine is now **`0.1.0-local.1786478271988`** (was `0.1.0-local.1785778939871`
from 2026-08-03 — before the whole asset-streaming series).

**R8 / Phase 6 is no longer blocked by the engine.** Its condition was "engine ships P1.7
Stages 1–2"; Stages 0–3 are in, bar one gap noted below. Specifically, the installed build has:

- `Application.loadScenarioFromManifest(url)` — a scenario served as a `scenario.json` of
  individually-fetchable scripts and assets, alongside the unchanged ZIP path.
- Progressive first paint, and `Scenario.timeToFirstFrame` reported on **both** paths — which
  is what makes a ZIP run and a streamed run of the same content comparable.
- A priority-ordered, bounded request queue; a read the scene is waiting on outranks
  speculative preloading.
- `Resources.vramBudgetBytes` with LRU eviction, and `TextureStreaming` to keep texture detail
  inside that budget.
- `BuildInfo` (`version` / `builtAt` / `isBuild`). **This is R3's engine half.** The bundle now
  reports `0.1.0-local.1786478271988` at run time, so telling one build from another no longer
  means grepping the shipped `.d.ts` for symbols.

Two live defects were fixed that could have bitten this repo: `Texture.load(url)` swapped its
GPU handle in the loader callback and never told the materials holding it (so a texture
assigned before its image arrived stayed blank); and assigning `Material.shader` discarded every
colour, texture and cutout setting the material carried.

**Caveat if you enable `TextureStreaming`:** it degrades by *cost*, not by on-screen size, so a
scene whose expensive textures all sit near the camera is degraded in the wrong order. That is a
known engine gap, recorded in the engine's own notes — do not read it as a platform bug.

---

## Order

```
R1 ──► R2                  republish, then prove KTX2 actually works
R3-platform                cheap, and the engine half is already done
R4                         the biggest real gap in confidence
        ScenarioCreator P1 ──► manifest endpoint ──► R8 streaming client
R5, R6, R10                independent
```

### First — R1 then R2 (~1 day)

Unchanged from `roadmap.md`, and still first: **the catalog still serves the stale Drive
imports.** Everything else is measured against content nobody has republished, so a
before/after difference could not be attributed to the change under test.

R2 matters more than its size suggests because its failure mode is silent: a wrong KTX2
transcoder path breaks neither the build nor any test, only one scenario at run time on a
machine that happens to support the format. It needs a real browser pass, not a green CI.

**There is now a specific reason to suspect the KTX2 pipeline**, beyond the transcoder path:
in `Benchscene3`, `earth_normal.ktx2` is 2.67 MB and deflates to 15% inside the archive, which
a properly supercompressed texture would not, and it is larger than the JPEG it replaces.
KTX2's win is VRAM rather than file size, so being bigger on disk is not automatically wrong —
but R2 should check the transcoded format actually reported at run time
(`MemoryProfiler` under `?diag=1`), not just that the textures appear.

Note for R1: `ScenarioCreator/ReleaseScenarios/` currently holds `Molecules` (22 KB),
`solar-system-scenario` (18.3 MB) and, under `test/`, `Benchscene1` (2.3 KB), `Benchscene2`
(29.4 MB), `Benchscene3` (10.5 MB). A "deduplicated" reply on upload means the old file was
re-uploaded by mistake.

### Second — R3's platform half (~0.5 day)

The engine now answers "which build is this?"; nothing here shows it.

- Render `BuildInfo.version` / `builtAt` in the diagnostics area under `?diag=1`.
- Decide the `/api/health` question rather than smearing one build's identity across the
  other's endpoint. `roadmap.md`'s own note argues the honest split — *frontend reports the
  engine build, backend reports the API build* — and that still looks right.

### Third — R4, Playwright (~2–3 days)

208 tests cover the logic and nothing covers the browser. `manual-browser-checks.md` exists
precisely because these cannot be asserted otherwise, and a manual checklist decays the moment
nobody runs it. Backlog is `test-plan.md` §7 plus the two golden paths.

Do this before the streaming client, not after: streaming changes the viewer's most fragile
surface, and there is currently no automated way to notice it breaking.

### Fourth — the streaming path (blocked on ScenarioCreator, not on the engine)

**Do not start this first.** Nothing publishes a `scenario.json` yet, so there is nothing to
stream. `ScenarioCreator/docs/PLAN.md` P1 is the unblock, and it is the first thing being done
there.

**The platform's part can start later than it looks.** `StreamingAssetSource.fromUrl` takes any
URL, so ScenarioCreator can prove the whole streaming path against a directory of hashed files
served by the existing nginx — no `scenario_assets` table and no manifest endpoint. Everything
below is for catalog integration and dedup accounting, and is worth doing only once the path is
known to work.

When manifests exist, the platform side is `scenario-delivery-migration.md` Stage 1:

1. **`scenario_assets` table** — `scenario_id`, `path`, `guid`, `priority`, `lod_level`,
   `sha256`, `bytes`, `url`. A migration under `backend/migrations/`, never `db/init.sql`.
2. **Per-asset storage.** `storage.js` already content-addresses whole archives into
   `objects/<sha256>.zip`; individual assets are the same idea at a finer grain, served by nginx
   under a `^~ /a/` location with the same immutable caching. Dedup then comes free — a texture
   shared by two scenarios is stored once.
3. **`GET /api/scenarios/:id/manifest`** returning the `scenario.json` the engine reads.
   **Two shape notes that will otherwise cost a debugging round:** an asset is addressed by
   **`path`** with an optional `guid`, *not* by the `"id": "earth_albedo"` this repo's own
   `scenario-delivery-migration.md` §3.1 sketches — that sketch predates the engine
   implementation and is wrong. And `scripts` + `entry` are what make a manifest runnable;
   one listing only assets is a valid asset source but not a scenario, and the engine says so
   explicitly rather than failing later.
4. **Viewer:** call `loadScenarioFromManifest` when the row has a manifest, keep
   `loadScenarioFromBuffer` otherwise. Report `Scenario.timeToFirstFrame` through the existing
   telemetry so the improvement is recorded rather than asserted.

**Done when:** a scenario plays from a manifest, renders identically to its ZIP, and
time-to-first-frame is measurably lower.

### Independent, any time

- **R5** archive GC — needs reference counting over `archive_sha256`, and becomes more
  important once per-asset objects exist.
- **R6** CSP — still the only security header unset; the import map is the constraint.
- **R10** fresh-install bootstrap without Drive — after R1 the local ZIPs are the source of
  truth, so the seed can stop carrying Drive links and the scraping code can finally go.

---

## Progress

### R1 — catalog republished ✅ 2026-08-13

The catalog now serves the current ScenarioCreator release: **13 rows, all `storage_kind = local`,
all with `manifest_id` equal to the catalog id.** No upload reported `deduplicated`, so no stale
archive was re-uploaded by mistake.

The release turned out larger than the plan assumed — **ten** production scenarios, not two, so
**nine** new rows were created rather than the eight the note anticipated (`Kepler` was built last).

Done with a script rather than by hand, because republishing recurs on every ScenarioCreator
build and hand-running it is how the catalog reached the state found here:

- `backend/scripts/publish-release.mjs` — walks a release directory, reads each archive's
  `manifest.json`, creates or updates the catalog row, uploads the ZIP. Talks to the admin HTTP
  API only, so it works against a deployed instance. `--dry-run` and `--prune-superseded`.
- `backend/scripts/catalog-metadata.mjs` — the platform's half of the metadata. Title,
  description and version come from the archive manifest; only subject, visibility and image
  live here. The manifest's own `category` (`education` / `simulation` / `test`) is a content
  type, not a university subject, and is deliberately unused.

Three findings worth keeping:

1. **The live database had drifted from `db/init.sql`.** Two rows carried ids containing a
   space — `Benchscene2 complexmodel` — which lands in the `/play/:id` URL. Catalog ids are now
   the manifest ids; the old rows are deleted. `scenario_sessions` has no foreign key by design,
   so the two bench-scene sessions recorded against the old id survive as historical values.
2. **The seed is gone from `db/init.sql`.** It pointed at Google Drive and would have resurrected
   the space-ids on the next `docker compose down -v`. SQL cannot place a file on the archives
   volume, so a seeded row could never point at local storage anyway — an empty catalog on a
   fresh install is the correct state, filled by `npm run publish:release`. That is most of R10.
3. **Bench scenes are `is_published = false`** — out of the student catalog, still visible in
   `/admin`. Consequence for R2 below.

Open: catalog rows have no `image_url`, so the ten production scenarios fall back to the UI
placeholder. Cosmetic, and not something to invent — it needs real artwork.

### R2 — KTX2: file half verified ✅, runtime half open ⏳ 2026-08-13

**The suspicion recorded above is disproven — that paragraph is now stale.** It reads
"`earth_normal.ktx2` is 2.67 MB and deflates to 15% inside the archive, which a properly
supercompressed texture would not". In the current release that file is **365 KB and deflates to
100%** — it does not compress further, which is precisely what a supercompressed payload does.
ScenarioCreator's supercompression fix landed; the earlier reading was of the older build.

`backend/scripts/verify-ktx2.mjs` (`npm run verify:ktx2`) now checks this from the bytes, so it
cannot quietly regress again. All 12 textures pass: 11 × ETC1S/BasisLZ, `earth_normal` ×
UASTC/Zstd — the right split, since a normal map is what ETC1S handles worst. Two independent
signals, the KTX2 header's `supercompressionScheme` + DFD colour model, and how far the entry
still deflates inside the ZIP.

Also settled, without a browser:

- **Only `Benchscene3_solarsystem.zip` ships `.ktx2` at all.** `solar-system-scenario.zip` carries
  12 plain PNG/JPEG. The KTX2 path cannot be exercised by a production scenario, only by a bench
  scene — which is now unpublished, so checking it means publishing it temporarily.
- `/assets/basis/basis_transcoder.js` and `.wasm` are served (200). The engine's own default
  `/basis/` returns 404, confirming why `ViewerComponent` overrides `ktx2TranscoderPath`.

**What is left is browser-only, and the plan's method for it does not exist.** R2 says to check
"the transcoded format actually reported at run time (`MemoryProfiler` under `?diag=1`)". The
installed engine reports no such thing: `MemoryReport` has no format field, and `TextureFormat`
is the authoring enum (`RGBA32`, `RGB24`, …) with no compressed GPU formats in it.

The usable proxy is `estimatedTextureVramBytes`, which is documented to account for KTX2/Basis
compression. For Benchscene3 the two outcomes are far apart enough to be unmistakable:

| texture VRAM under `?diag=1` | meaning |
|---|---|
| ≈ **36 MB** | transcoded to BC1/BC7 — working |
| ≈ **279 MB** | fell back to RGBA8 — transcoder never loaded |

Recorded as a check with those thresholds in
[`manual-browser-checks.md`](manual-browser-checks.md) §5. Closing it is a job for R4's browser
harness, which is why R4 now runs before R2's last step rather than after it.

### R3 — build identity, platform half ✅ 2026-08-13

Three questions that were being conflated, now answered separately:

| Question | Where | Value here today |
|---|---|---|
| Which engine is running scenarios? | `BuildInfo`, viewer under `?diag=1` | `0.1.0-local.1786569427449`, built `2026-08-12 21:17 UTC` |
| Which engine was a scenario built against? | `manifest_engine_version`, `/admin` | `0.1.0-local.1786479071411` — all 13 |
| Which API build is serving? | `GET /api/health` → `build` | `1.0.0`, `commit: null` |

**Those first two rows differ, and that is the point of the change.** Every archive in the catalog
was built against a different engine build from the one installed to run them. Harmless so far,
but previously it could only have been found by unzipping an archive and grepping a lockfile.

- The viewer's `engineVersion` field was dead code reading `Application.version` — a literal fixed
  at `"0.1.0"` across every pack, so it could not distinguish builds even if something had rendered
  it. Replaced by `BuildInfo`, shown bottom-left under `?diag=1`, outside the `running` guard so
  it is readable on the error screen too.
- `/api/health` gained `build` — version, commit, startedAt, uptime. It reports the **API's**
  identity and deliberately not the engine's: the backend cannot observe a bundle running in a
  browser, and would drift the moment a tarball was installed without a backend rebuild. That is
  the honest split `roadmap.md` argued for. `commit` is null unless `API_COMMIT` is set at image
  build; null beats a placeholder that cannot be told from a real commit.
- Migration `004_manifest_engine_version.sql` stores the manifest's `engineVersion`;
  `/admin` shows it per row.

Backend suite is 153 (was 148). Two display formatters — `shortEngineBuild` and the viewer's
`describeEngineBuild` — are **not** unit-tested: neither the admin nor the viewer component has a
spec, both being browser-dependent, which is what R4 is for. Flagging rather than hiding it.

### R4 — Playwright ✅ 2026-08-13

`e2e/` — 22 tests, ~4.5 min, one skipped by design. Covers both golden paths (§4.11 #97/#98) and
all of `test-plan.md` §7, which is now a table of where each item is covered rather than a list of
things nobody can check.

The instrument that made this cheap: `helpers/engine.ts` does `await import('WebEngineTS')`
**inside the page**. The import map in `index.html` applies to dynamic imports too, so a test
holds the same module instance the app is using — no test hook in production code. "Did it
render?" becomes `renderStats.drawCalls > 0` instead of a screenshot diff, which under SwiftShader
would be slow and flaky.

Headless Chromium was checked before anything was written: WebGL2 via ANGLE + SwiftShader, with
ASTC, ETC and S3TC. Without compressed-texture support every viewer assertion would have been
quietly testing the fallback path.

**It found two real defects on the first run.**

1. **A scenario could open the profiler overlay on a student.** `solar-system` calls
   `MemoryProfiler.showOverlay()` from its own scenario code, so the platform's flagship scenario
   was showing students a developer overlay of FPS and VRAM counters. `?diag=1` gates the
   platform's *button*; it cannot govern what content does once running. `CLAUDE.md`'s claim that
   without the flag "the profiler's rAF loop is never created rather than merely hidden" was
   therefore false in practice. The viewer now closes the overlay when the flag is absent —
   a platform policy enforced by the platform rather than assumed of content.
2. **Nothing in the release actually loads a `.ktx2`** — see R2 below, which this settles.

Also corrected: the progress ring is **not** one continuous 0→100 ramp. `progressPercent` is
shared by the download and engine-load phases and restarts between them, so the test asserts
monotonicity per phase. Asserting a single ramp would have been asserting a design the viewer
does not have.

**Not a per-PR CI gate, deliberately.** The tests need a catalog, scenario content lives in
ScenarioCreator, and this repo stores none. Committing a fixture archive here is the rule the repo
exists to keep, so the `e2e` job in `ci.yml` is `workflow_dispatch` with a release directory
supplied to it. Running it is a pre-release step, documented in `e2e/README.md`.

### R2 — closed 2026-08-13: the transcoder is fine, nothing calls it

The runtime half of R2 is now answered, and the answer is not the one the plan expected.

`benchscene3-solarsystem` renders with **242.7 MB** of texture VRAM — essentially the ~279 MB
RGBA8 figure, nowhere near the ~36 MB transcoding would give. But the cause is not a broken
transcoder path:

- `/assets/basis/basis_transcoder.{js,wasm}` are served (200); the engine's default `/basis/`
  404s, so the `ViewerComponent` override is doing its job.
- **`basis_transcoder.*` is never requested during a run at all.** It is served over HTTP, so any
  run that decoded even one `.ktx2` would have to fetch it.
- The archive contains twelve `.ktx2` *and* twelve `.jpg`, and the manifest lists both as separate
  assets with distinct guids. `scripts/Scenario.js` asks for `stars_panorama.jpg`.

So the `.ktx2` files are carried, catalogued, and never referenced. The platform's KTX2 wiring is
correct and simply unexercised; **the fix belongs in ScenarioCreator**, which should point the
scenario at the compressed variants it emits. `verify:ktx2` continues to prove the files
themselves are well-formed and supercompressed.

### R8 / Phase 6 — the streaming path works; the latency claim is unproven ⏳ 2026-08-13

The cheap proof the plan asked for is done: a scenario served as a manifest of individually
fetched files **runs, and renders the same scene as its ZIP**. No `scenario_assets` table, no
manifest endpoint, no viewer change — exactly the order the plan wanted.

- `nginx` serves a per-asset store at `^~ /a/`, with `objects/` immutable and manifests `no-cache`.
- `virtual_lab_assets` volume, rw in backend and ro in frontend, mirroring the archives volume.
- `backend/scripts/import-release-assets.mjs` (`npm run import:assets`) imports a release:
  13 scenarios, **108 unique objects, 52.5 MB after dedup**.
- `e2e/tests/streaming.spec.ts` runs both paths and compares them.

**Four integration details cost a debugging round each. Two contradict this repo's own notes.**

1. **The engine joins asset URLs onto the manifest's directory as a string — it does not resolve
   them.** A leading `/` is not treated as absolute: rewriting to `/a/objects/…` produced
   `GET /a/manifests//a/objects/…` and a 404. So URLs must stay relative, and the manifest must sit
   one level above `objects/`. `/a/<id>.json` + `objects/aa/…` → `/a/objects/aa/…`, and no caller
   needs `baseUrl`.
2. **A release uses two relative conventions.** Manifests at the release root say `objects/aa/…`;
   the bench scenes under `test/` are a directory deeper and say `../objects/aa/…`. The plan
   recorded only the second. Both must be normalised — and `path.join(staging, '../objects/…')`
   escapes the staging directory, which is how the first import silently wrote objects outside the
   tree and served 404s. Normalising also fixed the dedup key: **124 objects / 59.6 MB became
   108 / 52.5 MB**, because the same file under two spellings was being stored twice.
3. Assets really are addressed by `path` + `guid`, never `id` — `scenario-delivery-migration.md`
   §3.1 remains wrong, and the spec now asserts it.
4. `/scenarios/` forces `default_type application/zip`, so the store could not reuse it: a browser
   refuses to execute an ES module served as `application/zip`.

**The latency claim is not demonstrated, and should not be repeated until it is.**

| | ZIP | manifest |
|---|---|---|
| first frame, run 1 | 1600 ms | 1764 ms |
| first frame, run 2 | 2106 ms | 1654 ms |
| first frame, run 3 | 1803 ms | 1757 ms |
| textures / VRAM | 19 / **92.8 MB** | 19 / **269.8 MB** |

A 30% spread between runs of the identical pair swamps the effect. Under SwiftShader, first-frame
time is dominated by shader compilation and software rasterisation rather than by how the bytes
arrived — **proving a latency win needs a real GPU.** The test asserts same-scene equivalence and a
loose sanity bound, not an improvement.

There is also a reason to expect little: `solar-system`'s manifest carries differentiated
priorities (1 critical, 6 high, 11 low), so deferral is available and being declined — the
scenario's own code loads everything before it first renders. Until scenario code tolerates a late
asset, this is a delivery change, not a latency one. That is ScenarioCreator's half.

**Open, and worth someone's attention: the manifest path holds ~2.9x the texture memory** — 269.8 MB
against 92.8 MB for the same 19 textures, reproducible across every run. Every `solar-system` asset
has exactly one LOD, so it is not a retained ladder. This repo can measure it but not diagnose it;
it is an engine-side question, and it matters because it is the opposite of what a VRAM budget
assumes.

#### Catalog integration — ✅ 2026-08-13, opt-in

`scenarios.manifest_url` (migration `005`) records where a scenario's manifest lives; the catalog
exposes it as `manifestUrl` beside `scenarioUrl`, and `npm run import:assets` sets it on every row
it imports. The two paths coexist rather than the row committing to one.

**The viewer uses it only with `?stream=1`.** Not the default, on the evidence above: the manifest
path is not faster to first frame here and holds ~2.9x the texture memory, so defaulting to it
would trade a student-visible regression for an unproven win. The flag is what makes the
comparison repeatable on a real GPU — which is the measurement that would actually settle it.
Falling back is explicit: no `manifestUrl` means the flag has nothing to select and the ZIP loads.

One consequence worth knowing: a streamed run keeps no buffer, so **restart is disabled** for it —
re-running would mean re-fetching, which is not what that button promises. `canRestart` derives
from a signal for exactly this reason.

**Still not done, deliberately: `scenario_assets` and `GET /api/scenarios/:id/manifest`.** The
manifest already lists every asset with its priority and LOD ladder and is served statically, so
a table duplicating it would have no reader and the endpoint would only proxy a static file.
Reference counting for GC (R5) is the first thing that will genuinely need the table — design it
then, against the shape now known rather than §3.1's sketch.

One practical note for whoever adds an upload endpoint: the store is written by
`docker compose cp` as root, so the backend user cannot currently write to `/srv/assets`.

## Explicitly not planned

Unchanged from `roadmap.md`: no users/roles/courses, no MinIO until presigned URLs or
horizontal scale actually matter, no search by scenario id.

Adding one: **do not adopt `TextureStreaming` as a student-facing default** until there is a
measured VRAM figure to justify a budget. It is off by default in the engine for that reason,
and a budget guessed wrong degrades quality for no benefit.
