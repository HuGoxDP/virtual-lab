# Review: batch Phases 4-5 (Viewer HUD; trim pages + profiler off)

## Executed Results (Step 0)
- Unit: `cd frontend && npx ng test --no-watch` -> 21 files, 242 tests passed.
- Build/typecheck: `cd frontend && npm run build` -> exit 0.
- e2e (full stack on :8044, E2E_SMALL_ARCHIVE override) -> 56 passed, 8 skipped, exit 0. Skipped: `ktx2.spec.ts:67` and all of `streaming.spec.ts` that touch a manifest (lines 143-277, including "with ?stream=1 it loads from the manifest instead"). The e2e stack has no manifest/object store, so streamed behaviour was not executed.
- Lint: none configured.

## Phase 4

| DW | Evidence | Verdict |
|---|---|---|
| 4.1 loading ring/percent/title/byte line/stage/Скасувати; cancel aborts and returns to /scenario/:id | viewer-loading.component.html; viewer.component.html `(cancel)="exit()"`, `exit()` navigates `['/scenario', routeId]`; ngOnDestroy aborts `downloadAbort`. Tests: viewer-loading.component.spec (DW-4.1 x4), viewer-format.spec, e2e viewer.spec:248 and :268 | PASS |
| 4.2 HUD Вийти/title/restart/fullscreen aria-labels, hints wide only, 390 px reachable, FPS and pause only when supplied | viewer-hud.component.html; scss `@media (max-width: 559.98px)` hides `.hints`; hud spec DW-4.2 x6; e2e viewer.spec:294, :310 | PASS |
| 4.4 restart from buffer; disabled for a streamed run | restart() uses `loadedBuffer()`; `canRestart` requires non-null buffer; streaming path sets `loadedBuffer(null)`. Restart-from-buffer: e2e :339 passes (no second archive request). HUD disabled state: hud spec DW-4.4. **Streamed half: no executed evidence** (streaming e2e skipped; no unit test of `ViewerComponent.canRestart`) | PARTIAL |
| 4.5 error / unsupported / context-lost in Nocturne with actions | viewer.component.html error, unsupported, contextLost blocks; e2e :110, :362, :373 pass | PASS |
| 4.6 G5 entry in docs/upstream/webenginets.md section 6 with evidence and "fresh player frame" fix; shared row points to it | docs section 6 cites Time.ts:201/:280; `Time._reset` has no caller (grep confirmed, only the definition at Time.ts:280); shared ENGINE-GAPS G5 row links `webenginets.md` section 6 | PASS (doc item; desk-checked) |
| 4.7 unit tests for components and byte label; e2e updated; suites green | viewer-format/loading/hud specs present; all suites green | PASS |

Constraints: no `Time.timeScale` write, pause logic or FPS sampler in the page (grep of viewer.component.ts); `[fps]="null"`, `[canPause]="false"`; the unknown-Content-Length edge case is handled (`byteLabel` with total <= 0/null/NaN gives "X МБ"; scenario.service passes `total: contentLength`, percent -1 handled -> 0; unit-tested); Space is handled nowhere (hud spec test).

## Phase 5

| DW | Evidence | Verdict |
|---|---|---|
| 5.1 no `.hero`; footer copyright bar only | catalog.component.html has none; site-footer.component.ts template is only `.footer-legal`; e2e catalog-scenario-page:40 passes | PASS |
| 5.2 no download link / `.launch-note`; launch and copy-link work | scenario.component.html diff; e2e :152 passes | PASS |
| 5.3 solar-system with/without `?diag=1`: no overlay, Backquote inert; `?diag=1` keeps build stamp | `lockProfiler()` at init and before each load/restart; `enforceProfilerOff` after load and every 1000 ms via `watchProfiler`; cleared in ngOnDestroy; e2e viewer.spec:154, :169, :187 pass; unit viewer-profiler.spec + viewer.component.spec pass | PASS |
| 5.4 unit/e2e/build green; docs say profiler off | all green; test-plan, manual-browser-checks, CLAUDE.md updated | PASS |

Constraints: `/admin` untouched; PlatformConfigService and its spec deleted and no residual references (grep); no `toggleDiagnostics`/`diagnosticsVisible` path (unit-asserted).

## Test-DW Coverage (Level 100%)
Every DW has a named test except the streamed half of DW-4.4 (above). **Gaps against 100%** — new or changed routines in `viewer.component.ts` with no unit test:
- `exit()` (new, DW-4.1/4.2 target; trivially testable with a Router spy, only e2e covers it)
- `watchProfiler()` and the 1000 ms guard / clear in `ngOnDestroy` (new; the guard re-closing a re-opened overlay is covered only by e2e, no fake-timer unit test)
- `canRestart` derivation, `startLoading`/`runBuffer`/`startStreaming`/`restart`/`setState` (changed; byte/stage signals and the buffer-null rule for streamed runs untested at unit level)
`viewer.component.spec.ts` covers only init/destroy through the jsdom "unsupported" path.

## Correctness Dimensions
| Dimension | Status | Evidence |
|---|---|---|
| Concurrency | PASS | `loadToken` guards stale loads; interval cleared in destroy; `profilerGuard` null-checked so restart does not stack timers |
| Error Handling | PASS | load errors surface via `showError`; abort suppressed intentionally |
| Resources | PASS | abort, listeners, interval, `app.dispose()` released in ngOnDestroy |
| Boundaries | PASS | byteLabel total 0/null/NaN/loaded > total, percent clamp, tested |
| Security | N/A | no new untrusted input (flag parsing only) |

## Loaded-Skill Criteria
| Skill | Criterion | Status | Evidence |
|---|---|---|---|
| aposd-verifying-correctness | Requirements coverage RC-1..3 | PASS except DW-4.4 streamed half (no executed evidence) | tables above |
| aposd-verifying-correctness | Concurrency / errors / resources / boundaries | PASS | table above |
| welc-legacy-code | Changed viewer.component.ts routines under test (characterization) | FAIL | gaps listed under Test-DW Coverage; new routines `exit`, `watchProfiler` added with e2e coverage only |

## Cross-Phase Coherence
- Phase 5 `viewer.component.html` builds on Phase 4's HUD inputs correctly (`[canPause]="false"`, no diagnostics control); Phase 5 deleted nothing Phase 4 consumes.
- Phase 5 footer/catalog/scenario changes use Phase 2's `<vl-site-footer>` with no inputs; no stale `maxArchiveBytes` binding remains.
- No contradictions between phases; earlier-phase e2e (golden path, DW-3.x) still pass.

## Notes (non-blocking)
- The guard starts only after a successful load; a scenario that re-opens the gate during a failed/partial load is not re-closed until destroy (destroy calls `enforceProfilerOff`). Not demonstrated harmful.
- `startStreaming` has no catch-time `watchProfiler`; same reasoning.
- Streaming e2e skipped here for environment reasons; `?stream=1`, abort-on-leave for the streamed path and restart-disabled were not exercised by this run.
- The HUD media breakpoint (559.98 px) is not verified against a screenshot, only the 390 px e2e.

## Issues
1. Coverage gap vs 100% level: `frontend/src/app/pages/viewer/viewer.component.ts` `exit()`, `watchProfiler()` (+ interval clear on destroy), `canRestart`, `setState` byte-signal reset have no unit tests.
   - Fix: add unit tests (Router spy for `exit()` with and without `routeId`; fake timers re-closing a re-opened overlay at 1000 ms and no timer after destroy; `canRestart` false for streamed state).
2. DW-4.4 streamed half ("restart stays disabled for a streamed run") has no executed evidence in this run (streaming e2e skipped, no unit test of the derivation).
   - Fix: unit test `canRestart` with `loadedBuffer` null while state is running, or run streaming e2e with a manifest store.

**Verdict: FAIL — blockers: Phase 4 DW-4.4 streamed-run clause lacks execution evidence; 100% coverage gap in viewer.component.ts routines (exit, watchProfiler, canRestart; attributed to Phase 4/Phase 5 code in the same file). All suites are green and all other DW items PASS.**
