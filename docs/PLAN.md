# Virtual Lab — plan

Drafted 2026-08-11, against branch `phases-0-3-hardening` (`2af1c244`).

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

## Explicitly not planned

Unchanged from `roadmap.md`: no users/roles/courses, no MinIO until presigned URLs or
horizontal scale actually matter, no search by scenario id.

Adding one: **do not adopt `TextureStreaming` as a student-facing default** until there is a
measured VRAM figure to justify a budget. It is off by default in the engine for that reason,
and a budget guessed wrong degrades quality for no benefit.
