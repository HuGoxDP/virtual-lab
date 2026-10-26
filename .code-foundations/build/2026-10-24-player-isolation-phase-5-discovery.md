# Discovery + Design: Phase 5 - Viewer on `PlayerHost`

## Files Found
- `frontend/src/app/pages/viewer/`: `viewer.component.{ts,html,scss}` (491 lines, runs the engine in the page), `viewer-profiler.ts` + spec (page-side lock/guard), `viewer-format.ts` (+spec), `viewer-hud.*`, `viewer-loading.*` (input-only, unchanged), `viewer-lifecycle.spec.ts` (632 lines, drives the component through the `createApplication()` seam), `viewer.component.spec.ts` (profiler policy).
- `frontend/src/index.html` (import map), `frontend/angular.json` (`externalDependencies: ["WebEngineTS"]`), `frontend/scripts/check-csp-assumptions.mjs`.
- `nginx/{nginx,csp,editor,csp-editor}.conf`; `docker-compose.editor.yml` (mounts `editor.conf` + `csp-editor.conf`; builds `../../WebEngineTSEditor` as a sibling checkout).
- `e2e/helpers/engine.ts` (`import('WebEngineTS')` in the page), `e2e/tests/{viewer,streaming,csp,ktx2,player-serving}.spec.ts`, `e2e/helpers/api.ts`.
- Engine reference: `PlayerHost.ts`, `PlayerRuntime.ts`, `protocol.ts`, `player-host.d.ts`.

## Current State
The page imports `Application`, `BuildInfo`, `Texture2D`, `MemoryProfiler` from `"WebEngineTS"` through an import map with a per-request nonce; `script-src` carries `blob:` and the nonce. Pause and FPS are not implemented anywhere (HUD gets `[fps]=null [canPause]=false`). Restart re-runs a retained `ArrayBuffer` (ZIP only; streamed restart disabled).

## Gaps (plan vs reality)
1. **`angular.json` `externalDependencies: ["WebEngineTS"]`**: esbuild treats an external package name as covering its subpaths, so `WebEngineTS/player-host` would stay a bare import in the browser (no import map any more). Must be removed (nothing imports the engine's main entry after this phase). Not named in the plan; required for the phase to work.
2. **Manifest URL must be absolute**: the player's `readUrl` rejects relative `load.source.url`. The viewer absolutises `scenario.manifestUrl` against `location.href`.
3. **Space with the frame focused** (resolved, plan decision #23 / DW-5.U1): the first player had no key handling, so only the host-focused case could pause on Space. Engine `0.1.0-local.1793037703840` handles Space inside the frame and reports `paused`; the host keeps its own handler for the host-focused case. A key event reaches exactly one of the two documents, so one press is one toggle.
4. **`?diag=1` build stamp**: no engine in the page. Only channel without an engine change: `PlayerMetrics.engineBuild` via `host.measure(1)` after the scenario is running. The stamp therefore appears ~1 s after running and never on the unsupported/error screens (no frame exists there).
5. Streamed restart becomes possible (PlayerHost.restart re-runs any source in a fresh frame): the "restart disabled for ?stream=1" statements in `streaming.spec.ts`, `viewer-lifecycle.spec.ts`, `docs/manual-browser-checks.md` are updated.
6. KTX2 (DW-5.5): DW-1.3 recorded KTX2 as passing in the player. Viewer passes `transcoderPath: '/assets/basis/'`. `ktx2.spec.ts` self-skips unless a scenario references `.ktx2`; the render check for DW-5.5 additionally transcodes in-frame (see e2e plan) so it does not depend on content.
7. `CLAUDE.md` (outside this phase's file scope) still describes the page-side engine/profiler/import map; flagged for the docs phase.
8. The streaming store of the `vl-iso` stack is empty (`/a/molecules.json` 404): populate with `import:assets` into `vl_iso_assets` only, to run the `?stream=1` specs.

## Code Standards
No `docs/code-standards.md` in the worktree. Follow the files' own conventions: standalone, OnPush, signals only for UI state, zoneless (no NgZone, no `fakeAsync`), English comments/identifiers, Ukrainian UI strings, `protected` seams for specs.

## Test Infrastructure
Angular unit tests: vitest via `ng test`, jsdom (no WebGL2; component spec stubs `supportsWebGL2`). Playwright e2e on `:8045`, one worker, shared catalog, `e2e-` id prefix for created rows (`helpers/api.ts`). Chromium + SwiftShader.

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-5.1 | hostile archive (built in the test, `e2e-` row, torn down) cannot read `parent`/`top` storage, navigate `top`, call `/api/admin/scenarios` | COVERED | e2e `hostile-archive.spec.ts`: zip built in-test, uploaded as `e2e-hostile-*`, played; script reports results on console; asserts storage SecurityError, `top.location` blocked, admin fetch unreadable/401, `parent.document` blocked, admin token intact; row deleted in `afterAll` |
| DW-5.2 | ZIP + `?stream=1`: pause (both focus cases), FPS, restart fresh frame (no 2nd archive request; old frame gone), fullscreen, cancel, exit, context loss, no overlay even with `?diag=1`/scenario opening it | COVERED (frame-focused Space: Gap 3, resolved by DW-5.U1) | e2e `viewer.spec.ts` + `streaming.spec.ts` (ZIP and stream variants); unit `viewer-lifecycle.spec.ts` (pause toggle, Space handling, fps/paused signals, restart, error mapping), `viewer-player.spec`/format specs; dirty e2e: leave mid-download, leave mid-load, restart while paused, never-handshake -> error |
| DW-5.3 | no import map, nonce or `blob:` on `/`; `frame-src 'self'` | COVERED | `csp.spec.ts` (rewritten nonce test, `script-src` has no blob/nonce), `check-csp-assumptions.mjs` (asserts none) + a script test |
| DW-5.4 | 10 round trips leave no frame and no live WebGL context | COVERED | e2e `viewer-roundtrips.spec.ts` |
| DW-5.5 | KTX2 renders through the player (DW-1.3: passing) | COVERED | e2e `ktx2.spec.ts` updated to frame helpers + in-frame transcoder check; unit asserts `transcoderPath` is `/assets/basis/` |
| DW-5.6 | `/editor/` import map carries the stamped nonce under `csp-editor.conf` with the override stack | COVERED (stack or nginx-level fallback, recorded) | e2e `editor-csp.spec.ts` (skips when `/editor/` absent) + `nginx -t` / container-local curl against a throwaway nginx with a stub editor upstream |
| DW-5.U1 | Space pauses and resumes with the frame focused and with the host focused; one press never toggles twice | COVERED | e2e `viewer-player.spec.ts` (frame, host, interleaved; ZIP and stream), unit 166 |
| DW-5.7 | backend, frontend, e2e suites green | COVERED | full runs |

**All items COVERED:** YES (DW-5.2 frame-focused Space carries the Gap 3 caveat)

## Design Decisions
- **Seam**: `protected createPlayerHost(container, options): PlayerHostLike` (replaces `createApplication`); `PlayerHostLike` = the slice of `PlayerHost` the viewer uses, so specs substitute a fake that captures `callbacks`.
- **Signals from callbacks**: `fps: number|null`, `paused`, `contextLost`; reset on every run start (a fresh frame is never paused). `canPause = running && !contextLost`; `canRestart = running && !contextLost && source retained`.
- **Source retention**: ZIP bytes become a `Blob` (`loadedSource` signal holds `{kind:'blob'}` / `{kind:'manifest'}`); the `ArrayBuffer` is dropped. Restart = `host.restart()` (fresh frame, no re-download).
- **Errors**: `mapPlayerError(error)` in `viewer-format.ts`: handshake -> "no response" copy; origin/version -> "incompatible player" copy; load -> the player's message; runtime -> `null` (the scenario's last state stays on screen, console warning only; a student is not thrown out by a script error after a successful start).
- **Space**: document `keydown`, ignored for interactive targets (button/a/input/select/textarea/contenteditable), `repeat`, modifiers; `preventDefault` when it acts.
- **Fullscreen**: `.viewer-container` (frame + HUD), as before; the frame carries no `fullscreen` permission.
- **Focus**: `frame.focus()` after each run reaches `running`.
- **Profiler**: page-side lock/guard deleted; host always `diag: false`.
- **nginx**: `sub_filter` trio moves into `location ^~ /editor/`; `csp.conf` loses `blob:` and the nonce (worker-src `blob:` also dropped? kept: not in the plan; `worker-src 'self' blob:` is a precaution and nothing in the page spawns workers - left untouched to stay inside the plan's stated change).

## Prerequisites
- [x] Engine release with `WebEngineTS/player-host`, player served at `/player/`
- [x] Release 1 input-only HUD / loading components
- [ ] `vl-iso` per-asset store empty (populate for stream specs)

## Recommendation
BUILD.
