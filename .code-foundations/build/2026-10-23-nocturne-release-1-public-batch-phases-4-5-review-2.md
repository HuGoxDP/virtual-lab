# Batch review 2: Phases 4 and 5 (Nocturne release 1)

## Executed Results (Step 0)
- Unit: `cd frontend && npx ng test --no-watch` -> 22 files, 287 tests passed.
- Build/typecheck: `npm run build` -> bundle generation complete, no errors.
- e2e (stack on :8044): 56 passed, 8 skipped (streaming x7, ktx2 transcode x1: no manifest store / expected), 0 failed, no reruns needed.
- Lint: not configured.

# Review: Phase 4 - Viewer (presentational HUD)

| DW | Evidence | Trace | Verdict |
|---|---|---|---|
| 4.1 loading ring/percent/title/byte line/stage/"Скасувати" -> abort + /scenario/:id | viewer-loading.component.html:1-23; viewer.component.html `(cancel)="exit()"`; viewer.component.ts exit() / ngOnDestroy abort | cancel -> exit() navigates /scenario/:id -> destroy aborts AbortController. e2e "DW-4.1 shows the loading screen", "DW-4.1 Скасувати aborts the download", lifecycle spec 149 | PASS |
| 4.2 HUD exit, title, aria-labels, hints wide only, FPS/pause conditional | viewer-hud.component.html (fpsLabel(), canPause() guards), scss `@media (max-width:559.98px){.hints{display:none}}` | fps null -> no slot; canPause false -> no pause button/Space hint; unit hud spec + e2e DW-4.2 (aria, 390 px) | PASS |
| 4.4 restart from buffer; disabled for streamed | viewer.component.ts canRestart (loadedBuffer signal), restart(), startStreaming sets buffer null | lifecycle spec 150-152 (incl. streamed disabled), e2e DW-4.4 (no 2nd download) | PASS |
| 4.5 error / unsupported / context-lost in Nocturne with actions | viewer.component.html error-overlay blocks (goBack, reloadPage) | e2e DW-4.5 x2, F7 context-loss test, lifecycle load-failure tests | PASS |
| 4.6 G5 entry + shared row | docs/upstream/webenginets.md §6; ENGINE-GAPS.md G5 row links §6; Time.ts:201 setter, :280 `_reset`, grep finds no caller (I re-ran it) | evidence accurate; fix is "fresh player frame per run" | PASS |
| 4.7 unit tests, e2e updated, suites green | viewer-format/hud/loading/lifecycle specs; e2e viewer.spec | all green above | PASS |

Constraints: no `Time.timeScale` write, pause or FPS sampler in page (grep clean); HUD fed `[fps]="null" [canPause]="false"`. Edge case unknown Content-Length: byteLabel returns "X МБ" without total for total 0/null/NaN or loaded>total (viewer-format.ts:28-34, spec'd); Space does nothing (no key handler). All handled.

All requirements met: YES

# Review: Phase 5 - Trim pages, profiler off

| DW | Evidence | Verdict |
|---|---|---|
| 5.1 no `.hero`, footer copyright only | catalog.component.html has no hero; site-footer.component.ts template is only `.footer-legal`; catalog spec "DW-5.1 no hero", footer spec | PASS |
| 5.2 no download link / `.launch-note`; launch + copy-link work | scenario.component.html (only launch + copyLink); scenario spec + e2e catalog-scenario-page | PASS |
| 5.3 no overlay with/without ?diag=1, Backquote inert, stamp stays | viewer-profiler.ts lockProfiler/enforceProfilerOff; viewer.component.ts init lock, armProfilerGuard at each load start (ZIP, streamed, restart), watchProfiler after load, 1000 ms guard; e2e 154/169/187 ran solar-system for real (38 s / 42 s) and passed; unit specs 154-157 | PASS |
| 5.4 suites green, docs say off | results above; CLAUDE.md:157-166, test-plan.md, manual-browser-checks.md 2.1.1 | PASS |

Constraints: `/admin` route still in app.routes.ts:27, no footer link; no `toggleDiagnostics`, `PlatformConfig`, `footer-inner`, `launch-note` left in non-spec source (grep). Edge cases (scenario calls showOverlay/enableToggle during load or later; ?diag=1; Backquote): gate shut before load so calls are inert; a scenario that re-opens the gate is closed at post-load and on the next 1 s tick (bounded blink, covered by unit 155/156 and e2e 187).

All requirements met: YES

## Specific item: the second timer (`vi.getTimerCount()` = 2)
Verdict: test-harness artefact, not a leak. Evidence: I ran a throwaway probe spec (created and deleted, working tree verified clean) that load + 2 restarts + destroy under `useFakeTimers({toFake:['setInterval','clearInterval']})` while recording every setInterval call with its stack. Counts were [2,2,2,1]. Recorded intervals: two at 16.67 ms from jsdom's `window.requestAnimationFrame` (Window.js:665, reached via Angular's `scheduleCallbackWithRafRace`, i.e. the zoneless scheduler), and exactly one 1000 ms from `armProfilerGuard` (viewer.component.ts:420, first runBuffer). Restarts added none (`??=`), destroy cleared the guard (count falls by one; the remainder is jsdom's rAF pump). The only setInterval in app source is that one line, and the engine dist has none.

## Test-DW coverage / level (100%)
Every new/changed routine has a unit test: byteLabel/readFlag (viewer-format.spec), lockProfiler/enforceProfilerOff (viewer-profiler.spec), HUD and loading components, ViewerComponent exit/canRestart/restart/setState/load paths/guard/destroy (viewer-lifecycle.spec, viewer.component.spec), catalog/scenario/footer specs. No gaps found. Each DW has named tests (DW-ids in test names).

## Correctness dimensions
- Concurrency: PASS. loadToken guards stale loads; destroy bumps token so an in-flight load cannot re-arm guard (lifecycle spec "cannot re-arm").
- Error handling: PASS. Lookup/download/engine/restart failures reach showError; aborted download is silent by design.
- Resources: PASS. Abort, listeners, telemetry, guard interval, app.dispose all released in ngOnDestroy; one interval total (see above).
- Boundaries: PASS. percent clamped/NaN-safe, total 0/null/NaN/less-than-loaded handled.
- Security: N/A (archive URL still comes from server, unchanged).

## Loaded-skill criteria
| Skill | Criterion | Status | Evidence |
|---|---|---|---|
| aposd-verifying-correctness | RC requirements mapped to code | PASS | tables above |
| aposd-verifying-correctness | CS/EH/RM/BC | PASS | as dimensions |
| welc-legacy-code | changed legacy viewer has characterization/lifecycle tests, seam via createApplication | PASS | viewer-lifecycle.spec uses the protected seam; behaviour-neutral |

## Cross-Phase Coherence
Phase 5 builds on Phase 2/3/4 interfaces as exposed: `<vl-site-footer>` (no inputs) used by catalog/scenario; viewer HUD/loading inputs used as declared; Phase 5 guard changes inside viewer.component.ts do not alter Phase 4 outputs (restart/streamed canRestart tests still green). `?diag=1` stamp (Phase 4 HUD/template) coexists with the Phase 5 lock. No contradictions or regressions found.

## Notes (non-blocking)
- Brief overlay flash is possible if a scenario opens the overlay between ticks (bounded to <=1 s, by design, acknowledged in docs).
- The `restart()` path does not abort an in-flight engine load; unchanged behaviour.

**Verdict: PASS**
