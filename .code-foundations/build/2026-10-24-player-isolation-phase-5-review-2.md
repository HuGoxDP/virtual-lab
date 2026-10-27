# Review: Phase 5 - viewer on PlayerHost, CSP tightening, DW-5.U1 (independent review 2)

## Executed Results (Step 0)
- Engine `npx vitest run tests/PlayerRuntime.test.ts` -> 38 passed (includes the DW_5_U1 block, 12 tests).
- Engine `npm test` -> 2573 passed, 1 failed: `tests/ApplicationDisposeInput.test.ts` "leaves no listener attached" (5 s timeout under load, the known load-dependent file). Re-run alone -> 5/5 passed.
- Engine `npm run typecheck` -> clean (build, player, test tsconfigs).
- Engine `npm run player-smoke` -> chromium, firefox, webkit: 14/14 checks each, including `space-pauses-focused-frame` and `space-resumes-focused-frame`. `dist/player/player.js` (19:05) is newer than `PlayerRuntime.ts` (18:59) and contains the pagehide code, so not stale.
- virtual-lab frontend `npx ng test --no-watch` -> 21 files, 293 passed. `npm run build` -> OK. `npm run check:csp` -> OK. `npm run test:scripts` -> 7/7.
- Backend `npm test` -> 348 pass, 0 fail, 0 skipped.
- e2e against :8045 (`npm test`, full) -> 101 passed, 3 skipped, 0 failed (10.4 m). Skips: the two `editor-csp` tests (they need the harness, run below) and `ktx2.spec.ts:97` "a scenario that loads .ktx2 transcodes" (skips because the KTX2 scenario is not in this catalog; DW-5.5 is covered by `ktx2-render.spec.ts`, which passed). No timing test failed, so no re-runs.
- Editor-CSP harness (`vl-editor-csp`, :8046) -> up, 2/2 `editor-csp` tests passed, `down --remove-orphans --rmi local` run; no containers remain.
- Live `curl -sI http://localhost:8045/`: `script-src 'self'`, `frame-src 'self'`, no `blob:` and no nonce. The body has 0 matches for `importmap` or `nonce`.

## Requirement Fulfillment

### DW-5.1
PREMISE: e2e hostile archive (built in the test, `e2e-` row, torn down) fails to read `parent`/`top` storage, navigate `top` and call `/api/admin/scenarios`.
EVIDENCE: e2e/tests/hostile-archive.spec.ts:98-135. The archive is built by `buildZip` (helpers/zip.ts) and the row comes from `uniqueScenarioId`. `beforeAll` creates it and `afterAll` calls `deleteScenario`.
TRACE: the hostile `awake` tries parent/top storage, `parent.document`, `top.location`, an admin fetch with credentials, an admin fetch with a bearer token, `top.location.href = '/admin'` and `window.open`. Storage, DOM and top reads give `blocked:SecurityError`. Both admin calls give `blocked:TypeError`. The host URL, sessionStorage token and localStorage id are unchanged and there is one page. The test ran and passed.
VERDICT: PASS

### DW-5.2
PREMISE: e2e: ZIP and `?stream=1` runs with pause (both focus cases), FPS, restart in a fresh frame (no second archive request for ZIP; old frame gone), fullscreen, cancel, exit, forced context loss, and no profiler overlay ever, even when a scenario opens it or `?diag=1` is set.
EVIDENCE: e2e/tests/viewer-player.spec.ts:49-190, run for both modes. Cancel and the dirty paths are at :195-244. Profiler checks are viewer-player.spec.ts:179 and viewer.spec.ts:134-178, including solar-system, which opens the overlay itself, and a scenario that re-opens it. Unit cover is in viewer-lifecycle.spec.ts.
TRACE: every one of these tests passed in the full run. Restart: the old frame is detached, `zipRequests` is unchanged, a fresh frame is not paused (timeScale 1), and Space then works. Fullscreen: `document.fullscreenElement` is `.viewer-container` and the iframe `allow` is `autoplay`. Profiler state in the frame is `{element:false, visible:false, allowed:false}` even with `?diag=1` and Backquote pressed. The code sends `diag: false` at viewer.component.ts:~270 and never calls `toggleDiagnostics` (grep: no match).
VERDICT: PASS

### DW-5.3
PREMISE: `csp.spec.ts`/`check-csp-assumptions.mjs`: no import map, no nonce and no `blob:` on `/`; `frame-src 'self'`.
EVIDENCE: e2e/tests/csp.spec.ts:64 (DW-5.3 no import map, no nonce, no inline script, repeated responses). frontend/scripts/check-csp-assumptions.mjs checkIndexHtml/checkBundles/checkCsp, with check-csp-assumptions.test.mjs. nginx/csp.conf, index.html.
TRACE: `index.html` no longer has the import map. `check:csp` on the built dist plus csp.conf passes, and 7 script tests pass, including a failure for each of blob:, nonce, missing frame-src and a bare engine import. Live `/` carries `script-src 'self'; ... frame-src 'self'` with no nonce.
VERDICT: PASS

### DW-5.4
PREMISE: e2e: 10 viewer round trips leave no frame and no live WebGL context.
EVIDENCE: e2e/tests/viewer-player.spec.ts:246-270.
TRACE: ten `/play` -> Exit round trips, each asserting `iframe` count 0 and `playerFrames` 0. Then an eleventh run still draws (drawCalls > 0) and the browser logged no "too many contexts / context lost" warnings. Passed in 8.5 s.
VERDICT: PASS. The "no live context" half is shown indirectly (no frame, no eviction warning, the eleventh renders), not by counting contexts. See Notes.

### DW-5.5
PREMISE: If DW-1.3 records KTX2 as passing, a KTX2 scenario renders through the player. If it records KTX2 as dropped, the viewer stops passing `transcoderPath` and non-KTX2 content still loads.
EVIDENCE: design/player-sandbox.md in the engine worktree: line 90 "KTX2 is **not** dropped", line 117 `ktx2` pass in all three browsers. e2e/tests/ktx2-render.spec.ts:98. viewer.component.ts passes `transcoderPath: '/assets/basis/'`.
TRACE: KTX2 is recorded as passing. The e2e ran a KTX2 scenario through the player: the transcoder was fetched twice, texture formats `{"ASTC 4x4":1}`, and 1 draw call. Passed. ktx2.spec.ts:68 (the player can fetch the transcoder from its opaque origin) passed. The unit test at lifecycle.spec:130 pins the `transcoderPath`.
VERDICT: PASS

### DW-5.6
PREMISE: With the editor override stack, `/editor/` still receives its import map with the stamped nonce, under `csp-editor.conf`.
EVIDENCE: nginx/editor.conf (`sub_filter`, `sub_filter_once` and `sub_filter_types` inside `location ^~ /editor/`), nginx/nginx.conf (no sub_filter), e2e/tests/editor-csp.spec.ts, e2e/editor-csp-harness/.
TRACE: the harness mounts the real editor.conf and csp-editor.conf (`csp-editor.conf` is unmodified per git status) in front of the real frontend image. Two tests passed: the nonce on `/editor/`'s import map equals the CSP nonce and changes per response, and the platform root beside it has neither.
VERDICT: PASS

### DW-5.7
PREMISE: Backend, frontend and e2e suites green.
EVIDENCE: the Step 0 results above.
TRACE: backend 348/0/0 skipped. Frontend 293/293. e2e 101 passed and 0 failed, 3 skips explained above.
VERDICT: PASS

### DW-5.U1
PREMISE: Space pauses and resumes with the scenario frame focused - the engine's player handles Space inside the frame and reports `paused` - and with the host page focused; one key press never toggles twice; e2e asserts both focus cases.
EVIDENCE: WebEngineTS src/player/player/PlayerRuntime.ts (`isEditable`, `_onKeyDown`, and the registration with `pagehide` removal in `PlayerSession`); tests/PlayerRuntime.test.ts "DW-5.U1" block. Viewer side: viewer.component.ts `keydownHandler`/`togglePause`, viewer-format.ts `isPauseShortcut`. E2E: viewer-player.spec.ts:79-114 for both modes.
TRACE: with the frame focused (the default after load), one real Space press causes the player's capture-phase listener on the frame window to call `_setPaused(!_paused)`, which posts `paused:true`. The HUD flips, the clock in the frame is 0, and 800 ms later it has not flipped back. A second press resumes. With the host focused, the host handler calls `host.pause()`, the player confirms, and the same assertions hold. The interleave test mixes frame Space, host Space and the HUD button. All passed in ZIP and stream modes, and the player-smoke Space checks pass in three browsers. Engine edge cases, each with a unit test that passed: ignored before running (listener not registered while loading), ignored with Ctrl/Alt/Meta/Shift, `repeat` does not toggle (and the default is still consumed), input/textarea/select/contenteditable are ignored, the listener and the audio-unlock listeners are removed on `pagehide` (and a second signal is harmless), the audio unlock still fires on the first key, and one press is one toggle with a single registered handler. The key event goes to exactly one document, so there is no double delivery. `_setPaused` is idempotent against the current state.
VERDICT: PASS

### Scope requirements
- Viewer keeps a Blob and drives PlayerHost, `diag:false`, no `toggleDiagnostics`, restart is a fresh frame, focus goes to the frame after load, fullscreen is of the container, telemetry stays in the host, teardown on leave: PASS, via viewer.component.ts and its unit and e2e tests.
- Only import from `"WebEngineTS"` is `WebEngineTS/player-host` (grep of src), and `externalDependencies` is removed from angular.json: PASS.
- The sub_filter moved into `location ^~ /editor/`, and csp.conf lost only `blob:` and the nonce (diff shows no other directive changed; `frame-src 'self'` was already present): PASS.
- Sandbox is exactly `allow-scripts allow-pointer-lock`, asserted in e2e and set by the given PlayerHost. The viewer only passes the container and options: PASS.

**All requirements met:** YES

## Edge cases
- Leaving mid-download: e2e (abort, no frame after 5 s) and unit. PASS.
- Leaving mid-load: e2e (the engine bundle held 8 s, then Cancel, no iframe, nothing resurrected). PASS.
- Space with the frame focused and with the host focused: e2e both modes. PASS.
- Context loss in the frame: e2e both modes. PASS.
- A player that never handshakes: e2e shows the error heading and the Ukrainian text, no loader, frame removed. PASS.
- Restart while paused: e2e both modes. The fresh frame is not paused and Space works. PASS.

## Test-DW Coverage
- [x] All DW items have corresponding tests that ran in Step 0.
- [x] Coverage matches 100%: every new or changed routine has a unit test. Viewer: openScenario, startLoading, runSource, readEngineBuild, restart, togglePause, toggleFullscreen, focusFrame, keydown, pagehide, ngOnDestroy and the error mapping in viewer-lifecycle.spec.ts. `mapPlayerError`, `absoluteUrl` and `isPauseShortcut` are in viewer-format.spec.ts. check-csp-assumptions has its test.mjs. Engine: `isEditable`/`_onKeyDown`/pagehide removal in PlayerRuntime.test.ts. Gaps: none.

## Dead Code
None found. Unused imports: none seen, and the build passes. `viewer-profiler.{ts,spec.ts}` are deleted.

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | PASS | The stale-load `loadToken` guard is traced on destroy-mid-load and a superseded restart (both unit-tested). Host and player Space use an idempotent `_setPaused`. |
| Error Handling | PASS | The host reports before it rejects. Every handshake/origin/version/load path ends in the error screen (e2e). An unreported rejection still shows an error (unit). |
| Resources | PASS | The frame is disposed on destroy, the download is aborted, the engine listeners are removed on `pagehide`. Ten round trips leave no frames. |
| Boundaries | PASS | Empty and absent manifestUrl falls back to the ZIP. `repeat` and the modifiers are handled. |
| Security | PASS | The hostile e2e passes. CSP only narrowed. The Space handler only calls `_setPaused`, which grants nothing new. Harness files are mounted only by `e2e/editor-csp-harness/docker-compose.yml`; Dockerfile.frontend copies `frontend/`, `nginx/` and the engine tgz only, not `e2e/`. |

## Loaded-Skill Criteria
| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| aposd-verifying-correctness | RC requirements coverage | PASS | Every DW item and scope item mapped above. |
| aposd-verifying-correctness | CS/EH/RM/BC/SE dimensions | PASS | See the table above. |
| cc-defensive-programming | External input validated at the boundary (the player messages) | PASS | The host/origin/`v` check is in the given PlayerHost. The viewer maps `PlayerError` codes in `mapPlayerError` and never trusts the message beyond showing it as text. |
| cc-defensive-programming | No empty catch / no side-effecting assertions | PASS | The catches log (`console.warn/error`) or show an error. `supportsWebGL2` returns false deliberately. |
| welc-legacy-code | Changes covered by characterization or unit tests | PASS | The viewer spec was rewritten; the changed routines are covered, see Coverage. |

## Notes (non-blocking)
- DW-5.4's "no live WebGL context" is asserted through proxies (no frame, no browser warning, the eleventh run draws), not a direct count of live contexts.
- `absoluteUrl(scenario.manifestUrl, ...)` in `startLoading` is outside any try. A malformed catalog `manifestUrl` would throw out of the `void openScenario()` call and leave the 'downloading' spinner. I could not make it happen with a realistic server value, so this is not a FAIL.
- `ktx2.spec.ts:97` skips on this catalog because the KTX2 scenario is not published. Real-scenario KTX2 coverage therefore rests on `ktx2-render.spec.ts`.
- Full engine `npm test` showed the known `ApplicationDisposeInput` timeout under load; it passed alone.

## Issues (if FAIL)
None.

**Verdict: PASS**
