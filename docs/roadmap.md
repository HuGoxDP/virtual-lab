# Virtual Lab — Roadmap

What comes after phases 0–5. Written 2026-08-02, against commit `1a1f6e6a` plus the working-tree
viewer changes (`?diag=1` gating, KTX2 transcoder path).

Phases 0–5 are **done** — see [`implementation-plan.md`](implementation-plan.md) for what landed
and why. That document is closed history; this one is the forward list. Every item below is either
something a completed phase deliberately left open, something an external repo now blocks on, or
something the last engine update newly enabled.

Each item states **why now**, **done when**, and its real dependency. Estimates are focused days.

---

## Now — unblocks other work or is already half-finished

### R1. Republish the rebuilt scenarios (~0.5 day) — *waiting on nothing*

ScenarioCreator has finished the rebuild
(`ScenarioCreator/docs/TASK-rebuild-and-republish.md`): all four archives are content-only, the
`Benchscene1_primitives` source was recovered from `05af25d^`, and every ZIP passes this
platform's own validator when run against it directly. **The archives in the catalog are still
the stale Drive imports.**

- [ ] Upload the four ZIPs from `ScenarioCreator/ReleaseScenarios/` through `/admin`.
- [ ] Confirm each returns a **new** `sha256` — a "deduplicated" reply means the old file was
      re-uploaded by mistake.
- [ ] Play each one from the catalog.

Sizes to expect (from the ScenarioCreator task doc): `Benchscene1_primitives` 2 295 B (was
5 771 B with the harness), `Benchscene2_complexmodel` 29 352 066 B,
`Benchscene3_solarsystem` 10 476 770 B (grew: it now ships both `.jpg` and `.ktx2`),
`solar-system-scenario` 18 256 979 B.

**Done when:** no archive in `objects/` contains a `Benchmark*` file, and every catalog row has a
`archive_sha256` that differs from today's.

### R2. Verify KTX2 end-to-end (~0.5 day) — *depends on R1*

`ViewerComponent` now sets `Texture2D.ktx2TranscoderPath = '/assets/basis/'`, and
`/assets/basis/basis_transcoder.{js,wasm}` are served (checked 2026-08-02; the engine's default
`/basis/` returns 404 here). Nothing has exercised it yet, because no published archive carries
`.ktx2` — `Benchscene3_solarsystem` will be the first.

This matters because the failure mode is **silent**: a wrong transcoder path does not break the
build or any test, it breaks one scenario at run time on a machine that happens to support the
compressed format.

- [ ] After R1, open `Benchscene3 solarsystem` and confirm textures render.
- [ ] With `?diag=1`, confirm the overlay's texture-VRAM figure is materially lower than the
      uncompressed equivalent — that is the proof the `.ktx2` path was actually taken.
- [ ] Add the check to [`manual-browser-checks.md`](manual-browser-checks.md).

### R3. Engine build identity at runtime (~0.5 day) — *Phase 5 leftover*

`release:local` now stamps `0.1.0-local.<timestamp>` into the package and `package-lock.json`
records it, so the build is identifiable **at install time**. At run time it is not:
`Application.version` is a hardcoded `"0.1.0"`, and `ViewerComponent.engineVersion` reads it but
renders it nowhere.

This has already cost time twice — telling an old engine from a new one required grepping
`.d.ts` for symbols. It gets worse the moment benchmark numbers are quoted anywhere.

- [ ] Read the installed version from `node_modules/WebEngineTS/package.json` at build time and
      stamp it into the bundle (a generated `engine-build.ts`, or a `define`).
- [ ] Surface it: the diagnostics overlay area under `?diag=1`, and `/api/health`.

**Design note:** `/api/health` is the backend, which cannot know a frontend build value. Either
pass it in as a build arg through compose, or accept that the honest split is *frontend reports
engine build, backend reports API build*. Decide before implementing — do not smear one build's
identity across the other's endpoint.

---

## Next — closes real gaps, no external dependency

### R4. Playwright E2E for the browser-only surface (~2–3 days)

208 automated tests cover logic; **nothing** covers the browser. `manual-browser-checks.md` exists
precisely because these cannot be asserted otherwise, and a manual checklist decays the moment
nobody runs it. The list in [`test-plan.md`](test-plan.md) §7 is the backlog:

progress ring actually animating 0→100 · WebGL2-unavailable message · context-loss overlay ·
fullscreen · diagnostics overlay under `?diag=1` · modal focus trap and focus restore ·
`sendBeacon` on tab close · portrait orientation hint · the `/admin` screen itself.

Plus the two golden paths from §4.11 (student journey, admin publish journey).

- [ ] Playwright against `docker compose up`, wired as a fifth CI job.
- [ ] Delete from `manual-browser-checks.md` every item the suite now covers, so what remains is
      genuinely manual rather than a list nobody reads.

**Done when:** both golden paths are green in CI on a fresh stack.

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

### R8. Streaming client (Phase 6) — **blocked on the engine**

Verified 2026-08-02: `StreamingAssetSource` is **not** in the installed engine build
(`0.1.0-local.1785778939871`). Until the engine ships it (its P1.7 Stages 1–2), the platform can
prepare manifests but the viewer keeps the single-ZIP path. Do not start this here first.

The platform-side design is already written:
[`scenario-delivery-migration.md`](scenario-delivery-migration.md) Stages 1–2 — a
`scenario_assets` table, `GET /api/scenarios/:id/manifest`, and content-addressed individual
assets under `/a/<sha256>.<ext>` so a texture shared by two scenarios is stored once.

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
R8                           only when the engine ships StreamingAssetSource
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
