# Discovery + Design: Phase 4 - Viewer (presentational HUD)

## Files Found
- `frontend/src/app/pages/viewer/viewer.component.{ts,html,scss}` (no spec; the HUD, loader, errors are inline, old dark/emoji look)
- `e2e/tests/viewer.spec.ts`, `student-golden-path.spec.ts`, `streaming.spec.ts`, `csp.spec.ts`, `ktx2.spec.ts`, `admin-golden-path.spec.ts`, `nocturne-foundation.spec.ts` (viewer half)
- `frontend/src/app/ui/{icon,format.ts}`, `styles/_legacy.scss` (neutraliser lists `app-viewer`)
- `docs/{test-plan,manual-browser-checks}.md`, `docs/upstream/webenginets.md`; `Time._reset()` at `WebEngineTS/src/engine/core/Time.ts:280`, no caller in `src/`.

## Current State
Viewer holds lifecycle (token guard, abort on leave, dispose, telemetry, `?stream=1`, `?diag=1` policy, context loss, WebGL2 probe). Several e2e specs use `.viewer-controls` as the "scene running" signal, `.loader-percent`, `.title-badge`, `.back-btn`, `.control-btn[aria-label=...]`.

## Gaps
- Back/exit goes to `/catalog`; must go to `/scenario/:id` (HUD exit and cancel).
- Progress carries a text label only; needs loadedBytes/totalBytes/stage signals.
- HUD has a diagnostics button -> removed from the template (orchestrator); `toggleDiagnostics` stays (Phase 5).
- "Space - pause" hint would be fake while pause is not built: shown only with `canPause`.

## Code Standards
Signals + OnPush + zoneless, path comments, English comments / Ukrainian UI, spec headers cite test-plan numbers (from 138), vitest fake timers.

## Test Infrastructure
Vitest via `ng test`; TestBed component specs (see `ui/scenario-card`); Playwright against the vl-e2e stack.

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-4.1 | Loading ring/percent, title, byte line, stage, Скасувати -> aborts, returns to /scenario/:id | COVERED | unit `viewer-loading.component.spec` (inputs -> DOM, cancel output), `viewer-format.spec` byteLabel (known / 0 / loaded>total); e2e "loading UI then HUD", "cancel returns to scenario page and aborts download" |
| DW-4.2 | HUD: Вийти -> /scenario/:id, title, restart/fullscreen aria-labels, hints wide only; FPS slot / pause only when supplied | COVERED | unit `viewer-hud.component.spec` (fps null hides slot, canPause false hides pause, outputs fire, Space inert); e2e "HUD controls + aria-labels + hints at 1440 vs 390", exit goes to /scenario/:id |
| DW-4.4 | Restart re-runs from buffer; disabled for streamed | COVERED | e2e "restart enabled for ZIP (no new archive request)", streaming.spec disabled with ?stream=1; unit hud `canRestart` disables button |
| DW-4.5 | Error / unsupported / context-lost in Nocturne with existing actions | COVERED | e2e unsupported (WebGL2-less), context lost (reload button), unknown-id error screen |
| DW-4.6 | G5 entry in upstream doc + shared row | COVERED | review: doc grep `Time._reset` / "fresh player frame"; shared row line 17 edited |
| DW-4.7 | Unit tests for components + byte label; e2e updated; green | COVERED | all of the above; full suites |

**All items COVERED:** YES

## Design Decisions
- Sprout `viewer-format.ts` (pure: `byteLabel`, `engineStage`, `readFlag` moved out of the component = characterization of the flag parsing) + two presentational components, no services injected.
- `loaded > total` -> total dropped (the Content-Length was wrong; do not print a number that is not true). Unknown total -> "X МБ". Both in МБ with one decimal, as the prototype.
- Byte line shown only when `loadedBytes` is supplied (hidden on the streamed path, which has no archive download).
- HUD controls keep the `viewer-controls` class (every e2e spec waits on it).
- Pause button rendered iff `canPause`; restart disabled (not hidden) when `!canRestart` = today's behaviour; the page passes `canPause=false`, `fps=null`.
- Error/unsupported/context-lost keep their actions (catalog / reload); only HUD exit and cancel move to `/scenario/:id` (route id, so it also works when the lookup failed).

## Prerequisites
- [x] files exist; [x] icons arrow-left, arrows-clockwise, corners-out, pause, play, mouse-*, keyboard, warning-circle already in ICON_NAMES (verify)

## Recommendation
BUILD
