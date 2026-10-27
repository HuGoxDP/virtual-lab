# Review: Phase 6 - Docs and plans (second, independent review)

## Executed Results (Step 0)
- `cd frontend && npx ng test --no-watch` -> 293 passed (293). Matches CLAUDE.md "293 tests" and the shared CHANGELOG "unit 293".
- `cd frontend && npm run test:scripts` -> 7 pass, 0 fail.
- `cd e2e && npx playwright test --list` -> "Total: 104 tests in 14 files". Matches "104".
- Backend 348: not run (needs Postgres). Backend is untouched by the phase (`git diff b55c2bf HEAD -- backend` empty), and the figure is unchanged from before.
- CI step "index.html matches the CSP", run verbatim against `frontend/src/index.html`: no importmap hit, no inline-handler hit, so it passes. A temp copy with `<script type="importmap">` is caught, and one with `onclick=` is caught. Step is correct.
- `Dockerfile.frontend` comment compared with `scripts/check-csp-assumptions.mjs`: it matches (no import map, no other inline script, no inline handler, no bare "WebEngineTS" import, `script-src 'self'`).
- Engine `node scripts/changelog-section.mjs 0.1.0` -> prints the [0.1.0] section, exit 0. With `--require-empty-unreleased 0.1.0`, exit 1: [Unreleased] holds entries, which is legitimate because the release is not cut. `0.2.0` -> "no section" (expected, not cut).
- Release-cut simulation (temp copy outside repos, `## [Unreleased]` followed by `## [0.2.0] - 2026-10-27` above the current entries): `--require-empty-unreleased 0.2.0` exit 0, and the printed notes contain the player, `Scenario.engineModuleUrl` and `diagnosticsAllowed` entries.
- Release-2 plan parse: phase headers 1-7 each have `**Model:**`, `**Skills:**`, `**Gate:**`, `**Depends on:**` (lines 67-71, 90-93/121, 147-181, 216-244, 275-295, 319-338, 356-376). Phase 1 uses the same `Depends on: none | **Unlocks:** ...` shape. Parses.
- Lint/typecheck: N/A (documentation phase).

## Requirement Fulfillment

### DW-6.1
PREMISE:  "No document still describes scenario code running on the platform origin, the import map on `/`, MinIO as the next store, or release-2's old Phase 1."
EVIDENCE: grep sweep of all `*.md` in the three locations (see hit table); `CLAUDE.md:84-88,233-250,258-294`; `docs/scenario-delivery-migration.md:166-179`; release-2 plan `:3-4,67-88,511-512`.
TRACE:    The named stale phrases are gone or correctly historical (table below). Docs also state many facts about the current system, and I checked those against the code. Most match: CSP directives, nginx locations, ACAO set, player.nginx.conf headers, angular.json assets and absent externalDependencies, `PlayerHost` as the only engine import, `diag:false`, `measure(1)` stamp, absolutised manifest URL, fresh-frame restart (including streamed), Space with either focus, mapPlayerError copy, dispose, 293/104. Three false statements remain (Issues 1-3), so the accuracy bar is not met.
VERDICT:  FAIL (the literal stale phrases are cleared; the accuracy requirement is not met)

Hit judgments (stale-phrase grep):

| Hit | Verdict |
|---|---|
| `CLAUDE.md:244-246,331`, `Readme.md:176`, `docs/tech-stack.md:93,122-123`, `e2e/README.md:70-72`: import map / nonce | Correct: scoped to `/editor/` (`editor.conf:35` sub_filter and `csp-editor.conf` verified) |
| `CLAUDE.md:269,273,326`, `docs/code-standards.md:122`, `tech-stack.md:118,157,176`, `manual-browser-checks.md:130`: "no import map on `/`", `externalDependencies` removed | Correct (index.html has none; angular.json has none) |
| `docs/implementation-plan.md:62,80,112,255-257,377,418`: no CSP yet / import map / `app.dispose()` / `toggleOverlay` | Closed history (Phase 0/0.5/3/5, dated 2026-08), correct for the time |
| `docs/test-plan.md:400-416,458,473,483`: `viewer-profiler.spec.ts` | Release-1 historical inventory; `:483` explicitly retires 145-148 and 154-157 and says the file is gone. Acceptable. See Note 1 for 150 |
| `.code-foundations/build/*discovery*.md`: viewer-profiler, import map | Dated build records of the past. Acceptable |
| `.code-foundations/plans/2026-10-23-nocturne-release-1-public.md` (`?diag=1` button, "Space does nothing in the page", restart disabled when streamed, lock/re-close overlay at `:543`) | Closed release-1 plan with checkbox and Execution Log history; describes what was built then. `:250-270,435` already carry the amendment. Acceptable |
| `docs/upstream/scenariocreator.md:82` viewer-profiler "is gone" | Correct |
| `docs/scenario-delivery-migration.md:168`, `implementation-plan.md:159`, `tech-stack.md:315`: MinIO | Correct: named only as archived and not a candidate (2026-04-25) |
| release-2 plan `:55` PLAYER_ORIGIN, `:261` templates/ | Correct: "no PLAYER_ORIGIN", "nginx has no templates/ directory" (verified: `nginx/` has no such directory) |
| `docs/upstream/webenginets.md:127-128` "without `script-src blob:` no scenario runs" | Statement about the engine's loader. Still true; the player's CSP carries `blob:` (`player.nginx.conf:25`). Acceptable |

### DW-6.2
PREMISE:  "`WebEngineTS/CHANGELOG.md` has the entry `release.yml` checks for."
EVIDENCE: `WebEngineTS/CHANGELOG.md:17` (`## [Unreleased]`), Added entries `:151-190`, Changed entries `:195-211`; `.github/workflows/release.yml:78-79` runs `scripts/changelog-section.mjs --require-empty-unreleased "$GITHUB_REF_NAME"`.
TRACE:    release.yml needs a section for the tagged version and an empty [Unreleased]. The entry sits in [Unreleased] (Added: player, `player-host`, `engineModuleUrl`, Space-to-pause, `player-smoke`; Changed: one-way latch, `release:local`, tarball size). On a cut, [Unreleased] is renamed to a version section, and the simulation exited 0 with the entry in the notes. Claims spot-checked against code: handshake 10 s and load 60 s (`PlayerHost.ts:67-68`), text cap 500 (`protocol.ts:30`), `engineModuleUrl` setter throws unless http(s)/blob (`Scenario.ts:162-166`), Space ignored in form fields, on repeat and with modifiers (`PlayerRuntime.ts:22-24,68-71`), AudioContext resume (`:232`), `diagnosticsAllowed` warns (`MemoryProfiler.ts:472`), `npm run size` and `player-smoke` scripts, `files:["dist"]`, `./player-host` export.
VERDICT:  PASS

### Scope items
- Migration Stage 3 without MinIO, with SeaweedFS/Garage/hosted S3 as candidates and the volume as the current choice: `scenario-delivery-migration.md:166-179`, `CLAUDE.md:92-94`. PASS.
- Virtual-lab `CLAUDE.md` engine-integration and CSP sections match the code: PASS (checked line by line against nginx.conf, csp.conf, player.nginx.conf, angular.json, Dockerfile.frontend, viewer.component.ts, viewer-format.ts).
- Release-2 Phase 1 replaced by a pointer; plan still parses: PASS (see Note 3 on the pointer path).
- `.claude-shared/PLAN.md` §2.9 closed into `.claude-shared/CHANGELOG.md`: PASS. PLAN `:163-164` is a tombstone and says why the number stays; CHANGELOG `2026-10-26 -> 27` entry claims verified (293/104/348, `frame-src 'self'` only addition, ACAO set, `viewer-profiler.ts` deleted, hostile-archive e2e exists).
- Engine `CLAUDE.md` names the player artifacts: PASS (`player.html`, `player.js`, `player.nginx.conf`, `player-host.js/.d.ts`, `src/player/*`, `design/player-sandbox.md` exists).
- 0df02d2 `ci.yml` step and `Dockerfile.frontend` comment: PASS (executed above).

**All requirements met:** NO

## Test-DW Coverage
- [x] Each DW item has execution evidence (grep sweep, changelog-section runs, parse check, CI-step run, suite counts).
- [x] Coverage level (documentation, per-DW executed checks): met. No code routines changed.

## Dead Code
N/A (documentation; the `ci.yml` and Dockerfile edits are comments and a corrected condition).

## Correctness Dimensions
| Dimension | Status | Evidence |
|---|---|---|
| Concurrency | N/A | docs only |
| Error Handling | N/A | the CI step exits 1 with an annotation on a match (verified) |
| Resources | N/A | docs only |
| Boundaries | N/A | docs only |
| Security | N/A | docs only. The CSP and sandbox claims were verified to match the headers |

## Loaded-Skill Criteria
N/A - no skills loaded.

## Cross-Phase Coherence
Cross-document agreement (virtual-lab `CLAUDE.md` / `Readme.md` / `docs/*`, engine `CLAUDE.md` and CHANGELOG, shared CHANGELOG and PLAN, isolation decisions): `CLAUDE.md`, `Readme.md`, the engine docs and both CHANGELOGs agree with each other and with the code on the sandbox, CSP, `diag:false` and the latch, KTX2 in the frame, restart, Space, and "the page imports only `WebEngineTS/player-host`". Three contradictions remain (Issues 1-3).

## Notes (non-blocking)
1. `docs/test-plan.md:150` ("streamed run disabled, `restart()` there does nothing", `createApplication` seam) and `:151-153` describe release-1 viewer unit tests. They are superseded by `:168` and `:164-169`, but only 145-148 and 154-157 are retired at `:483`. Release-1 historical inventory, so not failed. Retire 150-153 as well.
2. `docs/tech-stack.md:331-336` test-count table (232 / 60 / 35) is stale against 348 / 293 / 104. Not touched by this phase and predates it. `docs/test-plan.md:609` "35 tests" is a dated section header.
3. Pointers to the isolation plan and research (`.code-foundations/plans/2026-10-24-player-isolation.md` in the release-2 plan `:4,54,74,512`, `.code-foundations/research/2026-10-24-scenario-delivery-and-script-isolation.md` in `scenario-delivery-migration.md:179`) are repo-relative, but those files exist only at the workspace root `WebEngine/.code-foundations/`, not in virtual-lab. The release-1 plan uses `../../../.code-foundations/...`. Make them consistent.
4. `docs/manual-browser-checks.md:229-237` (KTX2 check) says to read VRAM "in the frame context" and that the profiler does not show the format. With the overlay off there is nothing to read, and `textureFormats` exists in the engine (closed gap). Pre-existing wording, vague rather than demonstrably false.
5. `Readme.md` architecture diagram and flow (`:48`) do not mention `/player/`. Incomplete, not contradictory.
6. `.claude-shared/ENGINE-GAPS.md` G5 row still says "until [player isolation Phase 5] ships ...". Outside this review's scope, but it shares the staleness of Issue 3.
7. `.claude-shared/PLAN.md` ScenarioCreator item 10 (profiler out of `solar-system`) is outside the stated review scope and reads accurately.

## Issues (FAIL)
1. `docs/manual-browser-checks.md:109-110` says restart "З `?stream=1` кнопка неактивна" (the button is inactive with `?stream=1`).
   - Demonstrated by: `viewer.component.ts:153-155` (`canRestart` needs only `running`, no context loss and a non-null `loadedSource`; a streamed run sets `loadedSource` to the manifest source at `:305-306`). `restart()` at `:398-403` runs it. The same file contradicts itself at `:117` ("те саме на `?stream=1`") and `:272-273` ("на потоковому шляху **працює**"). `CLAUDE.md:143-144` says restart works for streamed runs.
   - Fix: delete the sentence at `:109-110`.
2. `docs/code-standards.md:44` ("No imports from `three` or engine internals - only `from 'WebEngineTS'`") and `docs/tech-stack.md:186-188` (rule "імпортувати тільки з `"WebEngineTS"`") contradict `CLAUDE.md:278-280` and `code-standards.md:120-121`. `code-standards.md:44` is in the same file as the `:120-121` rewrite.
   - Demonstrated by: `frontend/scripts/check-csp-assumptions.mjs` `BARE_ENGINE_IMPORT` rejects `from "WebEngineTS"` in any bundle ("cannot resolve, app would not start"); `src/` imports only `WebEngineTS/player-host`.
   - Fix: change both statements to "only `WebEngineTS/player-host`; never `WebEngineTS` itself, `three` or internals".
3. `docs/upstream/webenginets.md` §6 (`:49-70`) still says the viewer "reuses the same JS realm and the same `Time` statics" and that "Until that ships, a scale set by one scenario can carry into the next one opened in the same tab", which is false now.
   - Demonstrated by: `viewer.component.ts:223-225` and the `host.restart()` / `dispose()` path run each scenario in a fresh frame (`CLAUDE.md:166,308`). The fresh-frame fix the doc names shipped in 2bf3a12.
   - Fix: record that the platform no longer leaks (each run is a fresh frame), keeping the engine request. Also update the G5 row in `ENGINE-GAPS.md`, which is outside this review.

**Verdict: FAIL - blockers: Issues 1-3 (docs that state false things about the viewer and import rule). DW-6.2 and the CI/Dockerfile/CHANGELOG/engine items are clean.**
