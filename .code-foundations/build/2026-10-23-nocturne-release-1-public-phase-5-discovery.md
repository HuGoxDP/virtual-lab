# Discovery + Design: Phase 5 - Trim the pages and switch the profiler off

## Files Found
Catalog (html/scss/ts/spec), scenario page (html/scss/ts/spec), viewer (component, html, spec absent), `ui/site-footer/*`, `services/platform-config.service.ts` (+spec), `e2e/tests/viewer.spec.ts`, `catalog-scenario-page.spec.ts`, docs, CLAUDE.md.

## Current State
Phase 4 viewer still held `toggleDiagnostics`, `diagnosticsVisible`, `diagnosticsEnabled` (gating the overlay policy) and `enforceDiagnosticsPolicy` (one-shot close after load). Engine d.ts: `MemoryProfiler.diagnosticsAllowed` is a two-way static setter; locked gate makes `showOverlay`/`toggleOverlay`/`enableToggle` no-ops and takes an open overlay down. Overlay DOM id: `#webengine-profiler`.

## Gaps
- No unit spec for `ViewerComponent` existed; jsdom has no WebGL2 so the component stops at "unsupported" (the earliest point a load could start). Flags were read after that probe, so the build stamp was missing on the unsupported screen; moved before the probe.
- `PlatformConfigService` lost its last consumer (footer limit) -> deleted with spec.
- e2e `admin-golden-path` needs `E2E_SMALL_ARCHIVE` in this worktree (helper resolves ScenarioCreator by relative depth).

## Code Standards
Zoneless + signals + OnPush, engine only from 'WebEngineTS', Ukrainian UI strings, English code/comments.

## DW Verification
| DW-ID | Item | Status | Tests |
|---|---|---|---|
| DW-5.1 | no `.hero`; no `.footer-inner`, copyright bar stays | COVERED | catalog spec "DW-5.1 no hero", "DW-5.1 footer is the copyright bar only"; site-footer spec x3; e2e "DW-5.1 the catalog has no hero..." |
| DW-5.2 | no download link / `.launch-note`; launch + copy-link work | COVERED | scenario spec "DW-5.2 ...", existing DW-3.4/3.5 launch + copy tests; e2e "DW-5.2 ..." |
| DW-5.3 | solar-system +/- `?diag=1`: no overlay, Backquote nothing, stamp shown | COVERED | viewer-profiler.spec (6), viewer.component.spec (5), HUD spec "DW-5.3"; e2e 4 tests in "the profiler never runs on the platform" |
| DW-5.4 | suites green; docs say profiler off | COVERED | unit 242, build, e2e; docs edited |

**All items COVERED:** YES

## Design Decisions
- New `viewer-profiler.ts`: `lockProfiler()` (gate shut) and `enforceProfilerOff()` (re-lock + hide, returns whether anything was undone). Deep, testable against the real engine class.
- Viewer: lock at `ngAfterViewInit` start, again immediately before each `loadScenarioFromBuffer` / `loadScenarioFromManifest` (restart included), `watchProfiler()` after load = one immediate enforce + `setInterval(1000 ms)` until destroy (covers a scenario re-opening the gate later with today's two-way setter).
- `diagnosticsEnabled` renamed `buildStampVisible` (it only drives the `BuildInfo` badge now).
- Footer reduced to the copyright bar, no inputs; `SiteLogoComponent` stays (header uses it).

## Prerequisites
All met.

## Recommendation
BUILD
