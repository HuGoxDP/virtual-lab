# Review: Phase 6 - Docs and plans

## Executed Results (Step 0)
- Frontend unit: `cd frontend && npx ng test --no-watch` -> 293 passed (matches the documented 293).
- CSP checker tests: `npm run test:scripts` -> 7 pass / 0 fail.
- e2e: `npx playwright test --list` -> "Total: 104 tests in 14 files" (matches 104; not executed, needs the stack).
- Backend: `npm run test:unit` -> 136 pass. The 348 total includes integration tests that need the test Postgres; not run. `backend/` is unchanged by the player-isolation branch, so 348 is carried over from release 1 (unverified, no evidence against it).
- Stale-phrase grep over the three locations (see per-hit judgement below).
- Engine changelog: `node scripts/changelog-section.mjs`:
  - real file, `--require-empty-unreleased 0.1.0` -> exit 1, "still has entries under [Unreleased]". Legitimate: [Unreleased] holds a year of work; cutting a release moves it.
  - temp-copy cut (`## [Unreleased]` renamed `## [0.2.0] - 2026-10-27`, fresh empty `## [Unreleased]` above) in /tmp, `--require-empty-unreleased v0.2.0` -> exit 0; extracted notes contain the player, `player-host`, `Scenario.engineModuleUrl`, `diagnosticsAllowed` entries.
- release-2 plan parse: header counts old vs new commit: Model 7/7, Gate 7/7, Depends on 7/7, Skills 7/7; seven `### Phase N` headers under Implementation Phases (the 8th `### Phase 1` match is the Execution Log entry).

## Requirement Fulfillment

### DW-6.1
PREMISE:  "No document still describes scenario code running on the platform origin, the import map on `/`, MinIO as the next store, or release-2's old Phase 1."
EVIDENCE: grep hits judged below; failing: `.code-foundations/plans/2026-10-23-nocturne-release-2-admin.md:261`.
TRACE:    grep "minio|import map|importmap|import-map|PLAYER_ORIGIN" -> every hit is a correct statement (/editor/ import map, "no import map on /", MinIO named only as archived/not a candidate, `PLAYER_ORIGIN` only as "no PLAYER_ORIGIN") or a historical record (docs/implementation-plan.md:62,80 "No CSP yet" in done-history; research/plan/build logs; test-plan.md numbered historical items 145-163 carrying their own "now gone" notes). Scenario-code-on-platform-origin phrasing: release-2 plan line 37 is conditional ("no author key can exist on a build where scenario code shares the platform's origin"), acceptable. Old Phase 1 of release 2: the phase body is replaced by a pointer and the Execution Log marks it SKIPPED, but Phase 4's File hints (line 261) still say "the `^~ /scenarios/` location in the nginx server config (moved under `templates/` by Phase 1)". That is the old Phase 1's output; `nginx/templates/` does not exist (`grep templates nginx docker-compose*.yml` -> nothing). The note at line 86 only reinterprets the `frontend/src/app/player/**` / `protocol.ts` references, not this one.
VERDICT:  FAIL (one residual description of release-2's old Phase 1, false about the repo)

### DW-6.2
PREMISE:  "`WebEngineTS/CHANGELOG.md` has the entry `release.yml` checks for."
EVIDENCE: `WebEngineTS/CHANGELOG.md` Added at ~162-189 and Changed at ~195-211 under `## [Unreleased]`; `release.yml:79` runs `changelog-section.mjs --require-empty-unreleased "$GITHUB_REF_NAME"`.
TRACE:    entries sit under [Unreleased] (what a cut moves into `## [X.Y.Z]`); simulated cut in a temp copy passes with exit 0 and the notes include the new entries; the real file correctly refuses a tag today because [Unreleased] is non-empty, which is the script's stated purpose.
VERDICT:  PASS

**All requirements met:** NO (DW-6.1)

## Scope items (accuracy focus)

Accurate against the code at the reviewed commits (checked, with evidence):
- virtual-lab CLAUDE.md CSP section vs `nginx/csp.conf`: `script-src 'self'`, `frame-src 'self'`, no `unsafe-eval` (`csp.spec.ts:61`), `worker-src`/`img-src` allow `blob:`: match.
- nginx locations vs `nginx.conf`: `include snippets/player.nginx.conf`, `^~ /player/` -> 404, ACAO `*` on the engine bundle, `/assets/basis/`, `/a/`, `/a/objects/`, player files: match. Engine `player.nginx.conf` content (own CSP naming `$scheme://$http_host`, `unsafe-eval`, sandbox tokens, `frame-ancestors 'self'`, no X-Frame-Options): match.
- Engine integration: `angular.json` assets (standalone bundle + `{player.html,player.js}` -> `/player`), no `externalDependencies`, viewer imports only `WebEngineTS/player-host`, `Dockerfile.frontend` copies `player.nginx.conf`, `TRANSCODER_PATH`: match.
- Viewer behaviour: `diag: false` on every load, `?diag=1` reads `host.measure(1)` build stamp only, restart for a streamed run keeps `{kind:'manifest', url: absoluteUrl(...)}`, Space handled by host `keydownHandler` and by `PlayerRuntime` in the frame, fullscreen of the container with the frame given no fullscreen permission: match.
- Counts: unit 293, e2e 104, scripts/commands (`check:csp`, `test:scripts`, `e2e/editor-csp-harness/`, `ktx2-render.spec.ts`): match.
- Migration doc Stage 3 (no MinIO; SeaweedFS/Garage/hosted S3; volume current), implementation-plan.md, tech-stack.md section 3/4/5/8 text: consistent.
- `.claude-shared/PLAN.md` section 2.9 closed with a stub (number kept, reason given), `CHANGELOG.md` entries for engine and platform: consistent with code. Engine CHANGELOG claims spot-checked (10 s / 60 s timeouts, 500-char cap, protocol v1, setter validation, `AudioManager.resume`): match. Engine CLAUDE.md names `dist/player/*`, `dist/player-host.*`, sources, `player-smoke`, and the `engineModuleUrl` pre-linker exception: match.

False statements found in changed documents (these fail the accuracy focus):
1. `virtual-lab/Readme.md:229-243` ("Діагностика продуктивності (`?diag=1`)", in the file the commit edited): says `?diag=1` makes a "📊" button appear top-right and that the profiler is created only with the flag. Code: the HUD has no diagnostics control, the host sends `diag: false` always, `diagnosticsAllowed` latches `false`; `?diag=1` only prints the engine build stamp (`viewer.component.ts:365,388`; `viewer.component.html:24`). The same commit's CLAUDE.md states the opposite.
2. `virtual-lab/CLAUDE.md:308` ("Always dispose the engine. `ViewerComponent.ngOnDestroy` calls `app.dispose()`"): the viewer no longer holds an `Application`; `ngOnDestroy` calls `this.host?.dispose()` (`viewer.component.ts:218`). The rule survives but its statement is false against the code, in a section the commit rewrote around it.
3. `virtual-lab/docs/tech-stack.md:367` ("KTX2 заблокований політикою CSP (`unsafe-eval` відсутній) ... Сьогодні це нічого не коштує"): contradicts the same file's rewritten section 3 and the code; KTX2 transcodes inside the frame under the player's `unsafe-eval` and `ktx2-render.spec.ts` renders one.

## Test-DW Coverage
- [x] Both DW items covered by executed checks (stale grep, changelog script modes, temp-copy cut simulation, header parse).
- [x] Coverage level: documentation phase, per-DW evidence; gaps: none.

## Dead Code
N/A - documentation only.

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | N/A | docs only |
| Error Handling | N/A | docs only |
| Resources | N/A | docs only |
| Boundaries | N/A | docs only |
| Security | N/A | docs only; the security claims (CSP, sandbox tokens, ACAO) were checked against code, see accuracy findings |

## Loaded-Skill Criteria
N/A - no skills loaded.

## Cross-Phase Coherence
- virtual-lab CLAUDE.md, engine CLAUDE.md/CHANGELOG, shared CHANGELOG and the isolation plan agree on: opaque-origin sandbox, no import map on `/`, `script-src 'self'`, `frame-src 'self'`, `/editor/` keeps import map + nonce, `engineModuleUrl`, latch semantics, `?diag=1` = build stamp. No contradiction found between them.
- Internal contradiction within virtual-lab: Readme.md:229-243 and CLAUDE.md:308 and tech-stack.md:367 contradict CLAUDE.md:170-175 / tech-stack.md section 3 / the code.

## Notes (non-blocking)
- `docs/manual-browser-checks.md:260-262` still tells the reader to open `?diag=1` and record from the "Memory" tab; that tab cannot exist on the platform. File not in the phase's list, but false against the code.
- `docs/upstream/scenariocreator.md:79` "Worked around here - the viewer now closes the overlay after load" describes the deleted page-side guard. Not in the phase's file list.
- `.claude-shared/tasks/B-milestone-1.md:97-105` (task card B5) still presents player isolation as to-do with its own import map, nonce and `allow="fullscreen"`, which is the opposite of what shipped. Outside the phase's file list; only PLAN.md section 2.9 was closed.
- `Dockerfile.frontend` comment ("CSP assumes exactly one inline script - the import map") is stale; code comment, out of scope.
- Backend 348 count not re-run (needs Postgres); unaffected by this branch.

## Issues (if FAIL)
1. Release-2 plan still describes old Phase 1's nginx restructure.
   - File: `.code-foundations/plans/2026-10-23-nocturne-release-2-admin.md:261`
   - Demonstrated by: text "moved under `templates/` by Phase 1"; `nginx/templates/` does not exist.
   - Fix: say the location lives in `nginx/nginx.conf` (Phase 1 is done by the isolation plan and did not move it).
2. Readme.md diagnostics section describes a removed button/profiler.
   - File: `Readme.md:229-243`
   - Demonstrated by: HUD template and `viewer.component.ts:365` (`diag: false`); CLAUDE.md:170-175.
   - Fix: rewrite to "`?diag=1` shows only the engine build stamp; the profiler is off on the platform".
3. CLAUDE.md names a non-existent `app.dispose()` call.
   - File: `CLAUDE.md:308`
   - Demonstrated by: `viewer.component.ts:218` `this.host?.dispose()`.
   - Fix: "`ngOnDestroy` calls `host.dispose()` (removes the frame, which ends the engine and its WebGL context)".
4. tech-stack.md says KTX2 is blocked by CSP.
   - File: `docs/tech-stack.md:367`
   - Demonstrated by: same file section 3 (transcoder runs in the frame under its own `unsafe-eval`), `e2e/tests/ktx2-render.spec.ts`.
   - Fix: restate as "KTX2 needs `unsafe-eval`, which only the player frame's CSP grants; the page keeps it absent".

**Verdict: FAIL - DW-6.1 (release-2 plan:261 residual old-Phase-1 text) plus three false statements in changed docs (Readme.md:229-243, CLAUDE.md:308, tech-stack.md:367). DW-6.2 PASS.**
