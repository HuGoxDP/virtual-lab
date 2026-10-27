# Review: Phase 6 - Docs and plans (review 4)

## Executed Results (Step 0)
- Frontend unit: `cd frontend && npx ng test --no-watch` -> 21 files, **293 passed** (matches every doc that says 293).
- Backend: `DB_HOST=localhost DB_PORT=55432 ... npm test` -> **348 pass, 0 fail** (matches 348).
- E2E count: `cd e2e && npx playwright test --list` -> **104 tests in 14 files** (matches 104).
- CSP checker: `cd frontend && node scripts/check-csp-assumptions.mjs` -> "built app matches the CSP ... no blob:, no nonce in script-src, frame-src 'self'"; `npm run test:scripts` -> 7 pass.
- CI step "index.html matches the CSP" (ci.yml:199-208), shell logic run against files:
  - real `frontend/src/index.html` -> OK, rc 0
  - temp file with `<script type="importmap">` -> `FAIL importmap`, rc 1
  - temp file with `onload=` -> `FAIL handler`, rc 1
  So the step does what its comment says. The `Dockerfile.frontend` comment (lines 21-25) matches `check-csp-assumptions.mjs` (no import map, no inline script, no inline handler, no bare `WebEngineTS`/`WebEngineTS/...` import); the docker CI job runs it through `docker compose build`.
- Live headers (stack on :8045, `Origin: null`): `/` and `/index.html` `no-cache` + platform CSP (`script-src 'self'`, `frame-src 'self'`, no `blob:`/nonce/`unsafe-eval`); `/player/player.html` and `/player/player.js` the engine's headers (`no-cache`, ACAO `*`, player CSP with `unsafe-eval` and `sandbox allow-scripts allow-pointer-lock`, no X-Frame-Options); `/player/x` 404 with platform CSP; `/assets/WebEngineTS.standalone.js` ACAO `*` + `no-cache`; `/assets/basis/*` ACAO `*` + `public, max-age=2592000, immutable`; `/a/solar-system.json` ACAO `*` + `no-cache`. Every header claim in CLAUDE.md, the migration doc, PLAN.md section 2.8 and the changelog matches.
- `npx playwright test player-serving csp` against :8045 (ADMIN_TOKEN=x): 18 passed, 2 skipped, 1 failed. The one failure is `csp.spec.ts:119` calling `adminScenarios()` with my dummy token (403); it is an environment artifact, not a doc defect. The worktree is clean (`git status` empty).
- Engine `release.yml` / `scripts/changelog-section.mjs`:
  - `node scripts/changelog-section.mjs 0.1.0` -> rc 0 (the stale `[0.1.0]` section).
  - `... --require-empty-unreleased v0.1.0` -> rc 1: `[Unreleased]` legitimately holds entries (every pending engine change, not only this one). This is the designed gate, not a defect of the change.
  - Release-cut simulation on a temp copy (`## [Unreleased]` renamed `## [0.2.0] - 2026-10-27`, new empty `[Unreleased]`): `--require-empty-unreleased v0.2.0` -> rc 0, 493 lines of notes; the notes contain the player entry (Added), the `player-host` entry, `Scenario.engineModuleUrl`, Space pause, `npm run player-smoke`, and under Changed the `diagnosticsAllowed` latch, `release:local`, and the tarball-size entry.
- Release-2 plan parse: all seven real phases (`### Phase 1` .. `### Phase 7` before `## Execution Log`) have `**Model:**`, `**Gate:**`, `**Depends on:**`, `**Skills:**` (Phase 1: `sonnet` / `none -- completed by...` / `Standard` / `none | Unlocks: Phases 2, 7`). The extra `### Phase 1: Player isolation (Gate: Standard)` under `## Execution Log` is the standard execution-log entry form (release 1's plan has the same), not a phase header.

## Requirement Fulfillment

### DW-6.1
PREMISE:  "No document still describes scenario code running on the platform origin, the import map on `/`, MinIO as the next store, or release-2's old Phase 1."
EVIDENCE: grep sweep over all `*.md` in the three locations (excluding node_modules, .git, build reviews, tasks), patterns `minio`, `import map|importmap|import-map|імпорт-мап`, `PLAYER_ORIGIN|PUBLIC_ORIGIN|PLAYER_PORT`, `templates/`, `viewer-profiler|lockProfiler|enforceProfilerOff`, `app.dispose`, `immutable`, `platform origin|runs on the platform|API's origin|script-src blob|nonce|sub_filter`, `externalDependencies`, `restart`, `stream=1`, `timeScale|G5`, test-count regexes.
TRACE:    Hit-by-hit:
  - MinIO: only `implementation-plan.md:159`, `scenario-delivery-migration.md:168`, `tech-stack.md:316`, `.claude-shared/CHANGELOG.md:200` - each says MinIO is NOT a candidate (archived 2026-04-25) and names SeaweedFS / Garage / hosted S3 with the volume as the current choice. Stage 3 table row and diagram say "S3-compatible store". CLAUDE.md "Scenario storage" matches. No document names MinIO as the next store.
  - Import map on `/`: every hit is a negation ("no import map on `/`") or about `/editor/` (CLAUDE.md:244-246, editor.conf, e2e README, tech-stack 122, Readme 179, release-2 plan 497), which truly still has an inline import map (`e2e/editor-csp-harness/editor-index.html:3`, `nginx/editor.conf` sub_filter). `implementation-plan.md:62,80,112` (CSP/dispose rule from Phases 0/0.5) sit in a document headed "closed history" with dated phases: acceptable per the history convention. `manual-browser-checks.md:132` is an instruction to confirm `import('WebEngineTS')` fails.
  - Code on the platform origin: `release-2` plan 11-12 and 37 are past tense / ordering policy; `.claude-shared/CHANGELOG.md:175` says it no longer does; release-2 plan 497 and CLAUDE.md:244 state the real residual `/editor/` risk. No present-tense claim that scenario code runs on `/`.
  - Release-2 old Phase 1: `PLAYER_ORIGIN` / `PUBLIC_ORIGIN` / `PLAYER_PORT` / `templates/` / spike text occur only as negations ("no `PLAYER_ORIGIN`", "nginx has no `templates/` directory"). Phase 1 is `DONE, superseded`, with Model/Gate/Depends/Skills kept, a pointer to `../../../.code-foundations/plans/2026-10-24-player-isolation.md` ("workspace root, not this repo"; the file exists at `WebEngine/.code-foundations/plans/`), commits 9b0ae09/2bf3a12 (virtual-lab) and 02fdc1f (engine) all exist on `feature/player-isolation`; its Test Plan/Assumptions/Decision Log/Notes rows were pruned or rewritten; Phases 3 and 7 `frontend/src/app/player/**` references are explained in the Phase 1 body. `PLAN.md` section 2.9 is closed into `.claude-shared/CHANGELOG.md` (2026-10-26 -> 27 entry) and the number kept as a tombstone.
VERDICT:  PASS for the four named patterns. (Separate accuracy defects are recorded below; they do not change this item's patterns.)

### DW-6.2
PREMISE:  "`WebEngineTS/CHANGELOG.md` has the entry `release.yml` checks for."
EVIDENCE: `WebEngineTS/CHANGELOG.md` `[Unreleased]` -> `### Added` (player, `player-host`, `Scenario.engineModuleUrl`, Space pause, `player-smoke`) and `### Changed` (`diagnosticsAllowed` latch, `release:local`, tarball size); `.github/workflows/release.yml` step "Release notes from CHANGELOG.md" runs `changelog-section.mjs --require-empty-unreleased`.
TRACE:    The gate checks that the tagged version has a section and that `[Unreleased]` is empty at the tag, i.e. entries must live in `[Unreleased]` until a cut moves them. The entry is there; the temp-copy cut simulation (above) passes with rc 0 and carries all the entries into the version's notes. Current-state `--require-empty-unreleased` failing is by design (many unreleased entries). Entry claims verified against code: `REQUIRED_PACKAGE_FILES` (player.html/js/nginx.conf, player-host.js/.d.ts) refuse a tarball in `release-local.mjs:108`; `resolveVirtualLab` handles `virtual-lab/` vs `testv/virtual-lab/`; handshake 10 s / load 60 s (`PlayerHost.ts:67-68`); `engineModuleUrl` setter rejects non-http(s)/blob and unsafe characters (`Scenario.ts:162-166`); the latch (`MemoryProfiler.ts:470-479`); Space ignores modifiers/editable/repeat (`PlayerRuntime.ts:272-274`); `check-bundle-size.mjs` holds `player-host.js` / `player.js` to a budget and forbids engine markers; `player-smoke` runs chromium/firefox/webkit.
VERDICT:  PASS

## Scope items

| Item | Result |
|---|---|
| Migration Stage 3 without MinIO | PASS - candidates, volume as current choice, ACAO/`Origin: null` requirement, research section 6 item 9 link (file exists at workspace root and says "at the workspace root, not in this repo") |
| virtual-lab `CLAUDE.md` engine-integration + CSP sections vs code | PASS - verified against `viewer.component.ts`, `viewer-format.ts`, `angular.json` (no `externalDependencies`, `player/{player.html,player.js}` -> `/player`), `Dockerfile.frontend:34`, `nginx.conf`/`csp.conf`, live headers, `PlayerHost.ts` (allow=`autoplay` only, `restart()` = fresh frame, relative manifest URL refused by `readUrl`), `PlayerRuntime.ts` (diag latch, `ktx2TranscoderPath`, `engineModuleUrl`, Space), `release-local.mjs`. Test counts 348/293/104 correct. |
| Release-2 Phase 1 pointer; plan still parses | PASS (see Executed Results) |
| `.claude-shared/PLAN.md` section 2.9 closed into `CHANGELOG.md` | PASS; section 2.6/2.8/2.10 hunks accurate (section 2.8: `/assets/WebEngineTS.standalone.js` is `no-cache`, confirmed live) |
| `ENGINE-GAPS.md` G5 row | PASS - `Time.ts:280` is `_reset()`, no caller in `src`; `Profiler._reset`/`AudioManager._reset` are called by `Application` (lines 291/527); a new frame per `load`/`restart` = new realm; row links to `webenginets.md` section 6 which exists |
| Engine `CLAUDE.md` names the player artifacts | PASS - `dist/player/{player.html,player.js,player.nginx.conf}`, `dist/player-host.js/.d.ts`, `src/player/{host,player,static,protocol.ts}`, `npm run size`, `player-smoke`, `design/player-sandbox.md` (exists), `engineModuleUrl` pre-link note |
| `ci.yml` "index.html matches the CSP" + `Dockerfile.frontend` comment | PASS (run, see above) |

**All requirements met:** DW-6.1 YES, DW-6.2 YES. **Accuracy focus: NO** - three present-tense claims about the system are false (below), and the phase rules make that a FAIL.

## Test-DW Coverage
- [x] Documentation phase: each DW covered by executed checks recorded above (grep sweep, `changelog-section.mjs` runs, cut simulation, plan parse script, CI-step shell run, counts, live headers).
- [x] Coverage level (per-DW evidence through executed checks) satisfied; gaps: none.

## Dead Code
Not applicable (docs). The CI step and Dockerfile comment contain no unreachable logic.

## Correctness Dimensions
| Dimension | Status | Evidence |
|---|---|---|
| Concurrency | N/A | documentation phase |
| Error Handling | N/A | the CI step exits 1 with an `::error::` on both bad inputs (run) |
| Resources | N/A | |
| Boundaries | N/A | CI import-map grep matches only the literal `<script type="importmap">`; a differently-spelled tag would still be caught by the Docker-stage checker (note only) |
| Security | N/A | doc claims about the sandbox match `PLAYER_SANDBOX_TOKENS = [allow-scripts, allow-pointer-lock]`, `PLAYER_ALLOW = "autoplay"` |

## Loaded-Skill Criteria
N/A - no skills loaded.

## Issues (blocking: present-tense claims that are false about the system)

1. **`Readme.md:247-249` names a harness location that does not exist.**
   - Text: "Числа для порівняння ... знімайте **не тут**, а харнесом рушія (`WebEngineTS/benchmarks/`)". There is no `benchmarks/` in the engine repo (`ls WebEngineTS` shows `design dist docs scripts src tests ...`; `git ls-files | grep -i bench` finds only `src/engine/core/diagnostics/Benchmark.ts` and a test). The engine's own `CLAUDE.md:115,145,317` says benchmarks "are not built here", the harness lives in the separate `WebEngineTS-Benchmarks` repo, and this same change's `manual-browser-checks.md:268` correctly says `WebEngineTS-Benchmarks`. The line sits in the `?diag=1` section whose neighbouring sentences this change rewrote (the blockquote's last sentence was edited).
   - Demonstrated by: directory listing + `git ls-files` above; internal contradiction with `manual-browser-checks.md:268` and engine `CLAUDE.md:115`.
   - Fix: name the `WebEngineTS-Benchmarks` repository (harness `run.ts`).

2. **`.claude-shared/CHANGELOG.md:190-191` says `editor.conf` was untouched when this change edited it.**
   - Text: "The import map and its nonce `sub_filter` moved into `/editor/` (`editor.conf`, `csp-editor.conf` untouched)". `git diff b55c2bf..HEAD --stat -- nginx` lists `nginx/editor.conf | 11 +++++++++--` (the `sub_filter`, `sub_filter_once`, `sub_filter_types` lines were added inside `location ^~ /editor/`); only `csp-editor.conf` is unchanged. The sentence contradicts itself (the filter moved *into* `editor.conf`).
   - Demonstrated by: `git diff b55c2bf..HEAD -- nginx/editor.conf` (adds the three `sub_filter*` directives); `git diff --stat` shows `csp-editor.conf` absent.
   - Fix: "(`csp-editor.conf` untouched; `editor.conf` gained the `sub_filter`)".

3. **`docs/test-plan.md:425-426` describes the `viewer-lifecycle.spec.ts` harness with a seam that no longer exists.**
   - Text (heading "Viewer - load pipeline and restart, unit (release 1, phase 4 fix-forward)"): "`viewer-lifecycle.spec.ts`, with the engine (`createApplication` seam, `supportsWebGL2` stub) and `ScenarioService` / `TelemetryService` replaced by doubles." `grep -rn createApplication frontend/src` finds it only inside a negative assertion (`viewer-lifecycle.spec.ts:162`); the spec header (lines 1-6) and `viewer.component.ts` use a `createPlayerHost` seam returning a fake `PlayerHost`. Items 149-153 under that sentence are not struck through (unlike 142, 143, 150), so nothing marks the sentence as superseded; the Phase-5 section's "rewritten around a fake host" is a different paragraph. The heading is a release/phase label, not a dated section, so the history convention does not clearly cover it.
   - Demonstrated by: grep above and the spec header.
   - Fix: replace "the engine (`createApplication` seam" with "a fake `PlayerHost` (`createPlayerHost` seam" (or strike the sentence as superseded like 150).
   - Confidence: high that it is false; low severity.

## Notes (non-blocking)
- **History-convention judgments (accepted):** `implementation-plan.md:62,80,112,159,255-257,337-344,417` (document banner "closed history", dated phases); `test-plan.md` sections 1-4 pre-Phase-5 text, section 7 ("covered as of 2026-08-13", 35 tests) and the section-7 "viewer now closes it"; `CLAUDE.md:389` Phase-5 row ("218 unit tests ... 35 Playwright") - a phase table of what each phase delivered when it closed; `scenariocreator.md` / `manual-browser-checks.md` KTX2 figures dated 2026-08-13 ("242 MB") and flagged "re-check on the new build"; `docs/upstream/webenginets.md` closed items 2/4a/5 (item 2 carries a "Superseded by player isolation" note).
- `docs/test-plan.md` items 145, 148, 154-157 and 163 (and the "Specs:" lists at lines 402 and 461 naming `viewer-profiler.spec.ts`) are retired by the Phase-5 paragraph at lines 485-488 ("scenarios 145, 148 and 154-157 are retired ... 163 goes with them") but are not struck through at the item, unlike 142/143/150. Accepted as explicitly marked retired; striking them inline would remove the ambiguity.
- `docs/tech-stack.md:121` "CI перевіряє зібраний `index.html` (`npm run check:csp`)": CI never runs `npm run check:csp` or `test:scripts`; the same script runs (without the `csp.conf` argument) inside `Dockerfile.frontend`, which the docker CI job builds. The substance (CI verifies the built page) holds; the parenthetical names the local command. Likewise `tech-stack.md:337` "nginx -t для **обох** файлів" now mounts three files (nginx.conf, csp.conf, player.nginx.conf).
- `docs/tech-stack.md:140-146` and `:382` (zoneless rationale "zone.js patches the engine's `requestAnimationFrame`") reads as if the engine loop is in the page; it now runs in the iframe's own realm. Design rationale rather than a state claim, and the zoneless choice stands; no change forced.
- Pre-existing, untouched by this change: `docs/upstream/README.md` says `webenginets.md` has "5" open items (it has 2: sections 1 and 6); `webenginets.md` section 1 and `nginx/csp.conf` header link `docs/PLAN.md`/`../PLAN.md` which does not exist (the plan is `.claude-shared/PLAN.md`); `docs/code-standards.md:181` says the standalone bundle is copied "here" (`src/assets`) while `angular.json` copies it to the `/assets` output.
- `.claude-shared/CHANGELOG.md` says `check:csp` and `test:scripts` "guard" the built page; `test:scripts` is local-only (not in `ci.yml`).
- Out-of-scope observation: with `ADMIN_TOKEN=x` `csp.spec.ts:119` cannot run; needs the real token.

**Verdict: FAIL - three present-tense documentation claims are false about the current system (Issues 1-3). DW-6.1 and DW-6.2 themselves PASS; Phase 6's remaining scope items verified clean.**
