# Virtual Lab — Roadmap

What comes after phases 0–5. Written 2026-08-02, against commit `1a1f6e6a` plus the working-tree
viewer changes (`?diag=1` gating, KTX2 transcoder path).

Phases 0–5 are **done** — see [`implementation-plan.md`](implementation-plan.md) for what landed
and why. That document is closed history; this one is the forward list. Every item below is either
something a completed phase deliberately left open, something an external repo now blocks on, or
something the last engine update newly enabled.

Each item states **why now**, **done when**, and its real dependency. Estimates are focused days.

---

## Done — see [`PLAN.md`](PLAN.md#progress) for what each one actually turned up

### R1. Republish the rebuilt scenarios — ✅ 2026-08-13

Turned out to be ten production scenarios and three bench scenes, not four archives. Done with
`backend/scripts/publish-release.mjs` rather than by hand; catalog ids are now the manifest ids,
and the Drive seed is gone from `db/init.sql`.

### R2. Verify KTX2 end-to-end — ✅ 2026-08-13, with an unexpected answer

The platform's KTX2 wiring is correct and **never exercised**: `basis_transcoder.*` is not
requested during a run, because `Benchscene3`'s `Scenario.js` loads the `.jpg` originals rather
than the `.ktx2` files it also ships. Texture VRAM sits at 242.7 MB where transcoding would give
~36 MB.

**The remaining fix is ScenarioCreator's** — point the scenario at the compressed variants.
`backend/scripts/verify-ktx2.mjs` proves the files themselves are properly supercompressed, and
`e2e/tests/ktx2.spec.ts` turns itself on the moment a scenario references one.

### R3. Engine build identity at runtime — ✅ 2026-08-13

The engine now stamps `BuildInfo`, so no build-time codegen was needed. The viewer shows it under
`?diag=1`; `manifest_engine_version` records what each archive was built against; `/api/health`
reports the API's own build. The honest split in the design note below is what was implemented.

**Design note (kept — it decided the shape):** `/api/health` is the backend, which cannot know a
frontend build value. The honest split is *frontend reports engine build, backend reports API
build*, rather than smearing one build's identity across the other's endpoint.

---

## Next — closes real gaps, no external dependency

### R4. Playwright E2E for the browser-only surface — ✅ 2026-08-13

`e2e/` — 22 tests covering both golden paths and all of [`test-plan.md`](test-plan.md) §7, which
is now a table of where each item is covered. `manual-browser-checks.md` keeps only what a machine
genuinely cannot judge: whether a scene *looks* right, real hardware instead of SwiftShader, and a
real phone.

It found two defects on the first run — a scenario opening the profiler overlay on students, and
the KTX2 finding in R2 above. Details in [`PLAN.md`](PLAN.md#progress).

**One deviation from the plan:** it is not a per-PR CI job. These tests need a populated catalog,
scenario content lives in ScenarioCreator, and committing a fixture archive here is the rule this
repo exists to keep. The `e2e` job in `ci.yml` is `workflow_dispatch` with a release directory
supplied to it, and the suite is a pre-release gate. See [`e2e/README.md`](../e2e/README.md).

### R5. Archive garbage collection (~1 day)

Deleting a scenario leaves its object in `objects/` forever. Nothing collects it, and deletion
cannot be naive: dedup means one object may back several catalog rows
([`test-plan.md`](test-plan.md) §6.3).

- [ ] Reference-count over `scenarios.archive_sha256`.
- [ ] A sweep — on demand via an admin endpoint, not automatic on delete, so a mistaken delete
      stays recoverable.
- [ ] Report reclaimable bytes before deleting anything.

**Done when:** an object with zero referring rows is removable, one with any referring row is
refused, and the test suite asserts both.

### R6. Content Security Policy (~1 day) — *Phase 0 deliberately deferred*

The only security header not set. It was skipped because a naive policy breaks the import map in
`frontend/src/index.html`, which is load-bearing for the engine.

- [ ] A policy that permits the inline `<script type="importmap">` (nonce or hash) and the
      engine's WASM (`wasm-unsafe-eval` for the basis transcoder — verify what it actually needs).
- [ ] Confirm a scenario still loads and renders with the policy on; that is the acceptance test,
      not the header being present.

### R7. Real manifest metadata (~0.5 day here, ~0.5 in ScenarioCreator)

Every published archive reports `id: template.<folder>`, `version: 0.0.1-template`,
`author: Template Author` — `build-package.mjs` hard-codes placeholders. The platform survives it
(it warns on id mismatch rather than rejecting, by design) but the admin screen shows
`0.0.1-template` where a version belongs.

The fix is in ScenarioCreator: source metadata from a per-scenario `scenario.json`, falling back
to the template only when absent. **This repo's part** is to decide whether to display
`manifest_version` at all once it means something.

---

## Later — growth, and one hard dependency

### R8. Streaming client (Phase 6) — 🚧 path proven 2026-08-13, integration open

No longer blocked: the engine ships `StreamingAssetSource` and `loadScenarioFromManifest`. A
scenario now **runs from a manifest and renders the same scene as its ZIP** — `nginx ^~ /a/`, the
`virtual_lab_assets` volume, `npm run import:assets`, and `e2e/tests/streaming.spec.ts`.

Catalog integration is done too: `scenarios.manifest_url`, exposed as `manifestUrl`, set by
`npm run import:assets`. **The viewer uses it only with `?stream=1`** — see below for why not by
default.

Still to do, and now worth designing against what the shape turned out to be rather than the
sketch in [`scenario-delivery-migration.md`](scenario-delivery-migration.md) §3.1, which
[`PLAN.md`](PLAN.md#progress) corrects:

- [ ] **Re-run the comparison on a real GPU.** This is the blocking measurement: `?stream=1`
      exists to make it repeatable, and nothing below is worth deciding without it.
- [ ] `scenario_assets` — but only when GC (R5) needs reference counting. The manifest already
      lists every asset and is served statically, so the table has no reader yet.
- [ ] An upload path — the store is currently written by `docker compose cp` as root, so the
      backend user cannot write to `/srv/assets`.

**Two findings that should shape expectations.** The manifest path is *not* measurably faster to
first frame here — a 30% run-to-run spread under SwiftShader swamps it, and `solar-system`'s own
code loads every asset before it first renders, so the priorities in its manifest are being
declined rather than used. And it holds **~2.9x the texture VRAM** of the ZIP path for the same
19 textures, which is an engine-side question this repo can measure but not answer.

### R9. Performance telemetry (~1–2 days) — *optional, decide before building*

Telemetry records only duration. The engine's `Benchmark`/`MemoryProfiler` could feed a light
per-session sample — fps, GPU name, texture VRAM — turning the deployment write-up from
"N launches" into "N launches on real hardware at X fps".

**Decide first, honestly:** this samples students' machines. It is defensible (no personal data,
same anonymous `client_id`), but it is a different kind of collection from "a scenario was
opened", and the sampling itself costs frames. If the paper does not need the number, skip it.

### R10. Fresh-install bootstrap without Google Drive (~0.5 day)

`db/init.sql` seeds Drive URLs, and `docker compose down -v` drops the archives volume with the
database. A from-scratch install therefore still needs `LEGACY_DRIVE_PROXY=true`, an import pass,
then the flag off — documented in `Readme.md`, but it means the "zero external requests" guarantee
holds for a *running* deployment, not for first boot.

After R1 the local ZIPs are the source of truth, so the seed can stop carrying Drive links
entirely: seed metadata only, and let `/admin` supply the archives.

- [ ] Drop `scenario_url` from the seed rows.
- [ ] Document the first-boot upload step in `Readme.md`.
- [ ] Then `LEGACY_DRIVE_PROXY=false` can become the default, and the Drive scraping code
      (`server.js` `toGoogleDriveDirectUrl` / `extractDriveConfirm*`) can finally be deleted.

---

## Suggested order

```
R1 ─► R2                     republish, then prove KTX2 works
R3                           cheap, and stops the next "which build is this?"
R4                           the biggest real gap in confidence
R5, R6, R7                   independent, any order
R10                          after R1; unlocks deleting the Drive code
R8                           path proven; catalog + viewer integration next
R9                           only if the paper needs the numbers
```

R1–R3 are about a day and a half together and clear everything that is currently half-finished.
R4 is the one worth real time: it is the difference between "the tests pass" and "the thing works
in a browser", and right now only a human clicking through a checklist can tell those apart.

## Explicitly not planned

- **Users, roles, courses.** Phase 4 was scoped down to anonymous telemetry on purpose. Revisit
  only if a user study is actually scheduled.
- **MinIO / S3.** Deferred until presigned URLs or horizontal scale matter
  (`scenario-delivery-migration.md` Stage 3). A Docker volume served by nginx is sufficient at
  this size.
- **Searching by scenario id.** `q` matches title and description only, as the old client-side
  filter did ([`test-plan.md`](test-plan.md) §6.4). Unchanged behaviour, not a regression;
  revisit when the catalog outgrows a screenful.
