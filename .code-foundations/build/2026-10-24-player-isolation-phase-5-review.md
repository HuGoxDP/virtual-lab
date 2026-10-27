# Review: Phase 5 - the viewer on PlayerHost (virtual-lab + WebEngineTS DW-5.U1)

Reviewer: post-gate agent. Verify-only. Worktrees: virtual-lab `player-isolation` (9b0ae09, 31 uncommitted paths), WebEngineTS `player-isolation` (32a4fd7, uncommitted PlayerRuntime/tests/smoke).

## Executed Results (Step 0)
- Frontend unit: `npx ng test --no-watch` -> 21 files, 293 passed, 0 failed.
- Frontend build: `npm run build` -> OK. `npm run check:csp` (against that fresh build) -> "no import map, nonce or inline script; no bare engine import; csp.conf: no blob:, no nonce in script-src, frame-src 'self'". `npm run test:scripts` -> 7/7 pass.
- Backend: `npm test` (DB :55432) -> 348 pass, 0 fail, **0 skipped**.
- e2e on :8045 (the exact command given): **100 passed, 3 skipped, 0 failed** (11.6 min, exit 0). Skips: both `editor-csp.spec.ts` tests (stack has no editor override) and `ktx2.spec.ts` "a scenario that loads .ktx2 transcodes it" (its own self-skip: `transcoder fetched: false`). No timing test failed; no re-run needed.
- Engine: `npm run typecheck` -> clean. `npx vitest run tests/PlayerRuntime.test.ts` -> 38/38. Full `npm test`, run twice: 2563 pass, 11 fail, both times in `tests/ApplicationDisposeInput.test.ts` (1, the known flake) and `tests/RenderBackend.test.ts` (10, a 5 s timeout in its first test, the rest cascade). Re-run alone: ApplicationDisposeInput 5/5, RenderBackend 10/10 pass. RenderBackend was not on the known-flake list; it is load-dependent, touches no player code (see Notes).
- `npm run player-smoke`: not run. `dist/player/player.js` (19:05) is newer than `src/.../PlayerRuntime.ts` (18:59), and its md5 equals both the installed tarball copy and the file served live at `http://localhost:8045/player/player.js` (contains the `"Space"` handler), so the stack runs the reviewed engine code.
- Live headers `curl -sI :8045/`: `script-src 'self'; script-src-attr 'none'; ... frame-src 'self'; frame-ancestors 'self'`. No lint configured in either repo.

## Requirement Fulfillment

### DW-5.1
PREMISE:  e2e hostile archive (built in the test, `e2-` row, torn down) fails to read `parent`/`top` storage, navigate `top` and call `/api/admin/scenarios`.
EVIDENCE: `e2e/tests/hostile-archive.spec.ts:98-135` (archive built by `helpers/zip.ts`, `uniqueScenarioId`, `deleteScenario` in `afterAll`).
TRACE:    hostile entry point runs in the sandboxed frame -> parent storage/document and `top.location` read throw SecurityError; own storage/cookie SecurityError; both admin fetches TypeError (null origin cannot read the answer); `windowOpen` not opened; host URL unchanged, `adminToken`/`vlClientId` intact, one page in context. Test #40 passed in the live run. `topNavigate` itself reports "navigated" without throwing (browser logs the block), so the proof is the host-URL assertion, which holds.
VERDICT:  PASS

### DW-5.2
PREMISE:  e2e: ZIP and `?stream=1` runs with pause (both focus cases), FPS, restart in a fresh frame (no second archive request for ZIP; old frame gone), fullscreen, cancel, exit, forced context loss, and no profiler overlay ever, even when a scenario opens it or `?diag=1` is set.
EVIDENCE: `e2e/tests/viewer-player.spec.ts:36-190` (both modes via `MODES`), dirty paths `:195-244`, `viewer.spec.ts:134-192` (solar-system opens overlay itself, `?diag=1`, in-frame re-open), `viewer.component.ts:352-383, 398-423, 441-445`.
TRACE:    tests 66-83 (both modes: sandbox attr exactly `allow-pointer-lock allow-scripts`, focus IFRAME, FPS "N FPS", Space x2 in both focus cases, restart: old frame detached, zip request count unchanged, not paused after, fullscreen element is `.viewer-container` and iframe `allow="autoplay"`, exit leaves 0 frames, context loss overlay, profiler state `{element:false,visible:false,allowed:false}` with `?diag=1` + Backquote), 84-86 (cancel mid-download, leave mid-load, silent player -> error overlay), 92-94 and 102 all passed. Unit: `viewer-lifecycle.spec.ts` (diag:false always, Blob retained, restart no re-download, restart while paused, teardown) 293/293.
VERDICT:  PASS

### DW-5.3
PREMISE:  `csp.spec.ts`/`check-csp-assumptions.mjs`: no import map, no nonce and no `blob:` on `/`; `frame-src 'self'`.
EVIDENCE: `e2e/tests/csp.spec.ts:45-62, 64-77`; `frontend/scripts/check-csp-assumptions.mjs:48-116`; `frontend/src/index.html`; `nginx/csp.conf:37`.
TRACE:    GET `/`, `/index.html`, `/play/solar-system` -> no `importmap`, no ` nonce=`, no `'nonce-` in header, no `blob:` in script-src, no inline script; `script-src` equals exactly `script-src 'self'`; `frame-src 'self'` present. e2e tests 31-32, 34 pass; `check:csp` on fresh build passes; script tests 7/7 incl. negative cases (import map, nonce, inline, bare specifier, blob, missing frame-src). `git diff nginx/csp.conf` shows the only change to the header string is removal of `blob:` and `'nonce-$request_id'` from `script-src`: nothing else loosened.
VERDICT:  PASS

### DW-5.4
PREMISE:  e2e: 10 viewer round trips leave no frame and no live WebGL context.
EVIDENCE: `e2e/tests/viewer-player.spec.ts:246-272` (test 87, passed, 10.6 s).
TRACE:    each of 10 iterations: `goto /play/id` -> frames drawn -> click "Вийти" (SPA route change, ngOnDestroy -> `host.dispose()`) -> `iframe` count 0 and `playerFrames` 0. Afterwards an 11th run still draws (`drawCalls > 0`) and no "too many active WebGL contexts"/"context lost" console warning appeared. "No live WebGL context" is inferred (frame detached + no browser warning + 11th renders), not counted directly; and every iteration begins with a full-page `goto`, so a context leaked across SPA visits within one page would not accumulate. See Notes.
VERDICT:  PASS (with the weakness in Notes)

### DW-5.5
PREMISE:  If DW-1.3 records KTX2 as passing, a KTX2 scenario renders through the player. If it records KTX2 as dropped, the viewer stops passing `transcoderPath` and non-KTX2 content still loads.
EVIDENCE: `WebEngineTS/design/player-sandbox.md` section 1 ("Nothing is dropped"), section 3 (`ktx2` pass in 3 browsers) -> KTX2 is recorded as **passing**, so the first branch applies. Viewer passes `transcoderPath: '/assets/basis/'` (`viewer.component.ts:41,175`; unit test DW-5.5 in `viewer-lifecycle.spec.ts:130`). `e2e/tests/ktx2.spec.ts:68-96` (path probe) and `:97-` (the render check).
TRACE:    The only test that renders a KTX2 scenario through the viewer + player, `ktx2.spec.ts` "a scenario that loads .ktx2 transcodes it...", ran and **skipped itself** (test 43; log line `transcoder fetched: false`; texture VRAM 208 MB, i.e. the .jpg fallback). What did execute (test 42) proves only that the engine in the frame carries `Texture2D.ktx2TranscoderPath = /assets/basis/` and that the opaque frame can fetch both transcoder files. No executed run transcodes a `.ktx2` in the viewer's player. A skipped test is not execution evidence, and the archive-building helper (`helpers/zip.ts`, used by the hostile spec) could have built a KTX2 scenario in-test but was not used for this.
VERDICT:  FAIL (no execution evidence that a KTX2 scenario renders through the player; the wiring is proven, the render is not)

### DW-5.6
PREMISE:  With the editor override stack, `/editor/` still receives its import map with the stamped nonce, under `csp-editor.conf`.
EVIDENCE: `nginx/editor.conf:30-38` (`sub_filter '<script type="importmap">' '<script type="importmap" nonce="$request_id">'`, `sub_filter_once on`, `sub_filter_types text/html` inside `location ^~ /editor/`, beside `Accept-Encoding ""` and `include csp-editor.conf`); `nginx/nginx.conf:23-26` (server-level filter removed); `nginx/csp-editor.conf` unchanged (git clean); `e2e/tests/editor-csp.spec.ts`.
TRACE:    By reading: the filter now sits in the one location that serves the editor and uses the same `$request_id` as the header from `csp-editor.conf`, which looks correct. By execution: both `editor-csp.spec.ts` tests **skipped** (stack started without `docker-compose.editor.yml`; `/editor/` has no import map), and I did not reproduce the editor stack myself (the one tool call that would have read the author's reproduction notes was declined, and I did not substitute an unsanctioned container run). So nothing I ran shows `/editor/` receiving the stamped nonce.
VERDICT:  FAIL (no execution evidence; config looks right)

### DW-5.7
PREMISE:  Backend, frontend and e2e suites green.
EVIDENCE: Step 0 above.
TRACE:    backend 348/348, 0 skipped; frontend 293/293; e2e 100 passed, 0 failed, 3 skipped (named above, all by design/stack shape).
VERDICT:  PASS

### DW-5.U1
PREMISE:  Space pauses and resumes with the scenario frame focused - the engine's player handles Space inside the frame and reports `paused` (WebEngineTS `src/player/player/**` + `tests/**`) - and with the host page focused; one key press never toggles twice; e2e asserts both focus cases.
EVIDENCE: `WebEngineTS/src/player/player/PlayerRuntime.ts:68-71, 242-276` (`_onKeyDown`, `isEditable`, `pagehide` removal); `tests/PlayerRuntime.test.ts:437-655` (13 tests); `virtual-lab viewer.component.ts:441-445`, `viewer-format.ts isPauseShortcut`; `e2e/tests/viewer-player.spec.ts:56-114`.
TRACE:    Frame focused: key goes only to the frame window -> listener (registered only after `running`) ignores non-Space, Ctrl/Alt/Meta/Shift, `input|textarea|select|contenteditable`; `preventDefault` always, toggles only if `!event.repeat`; `_setPaused` posts `paused`; propagation not stopped so the audio `unlock` still fires (tests: unlock-on-first-Space once, pointer unlock does not pause). Host focused: `keydownHandler` -> `canPause()` && `isPauseShortcut` (not repeat, no modifier, not in button/a/input/select/textarea/summary/contenteditable) -> `host.pause()/resume()` by the player-confirmed state. `pagehide` removes keydown + unlock listeners (test passes). e2e (tests 67-69, 76-78): one press = HUD label, clock in frame (`Time.timeScale` 0/1) and no flip-back 800 ms later; frame Space, host Space and the HUD button interleave. Engine 38/38 pass.
VERDICT:  PASS

**All requirements met:** NO (DW-5.5, DW-5.6)

### Scope requirements and edge cases
- Viewer keeps a `Blob`, drives `PlayerHost`; `diag:false` on every load, never `toggleDiagnostics`; `measure(1)` only for the `?diag=1` stamp; restart = `host.restart()` fresh frame for ZIP and stream; `focusFrame()` after load; fullscreen = `.viewer-container` by the host, iframe `allow="autoplay"` only; telemetry in host; teardown disposes host once, aborts download, removes listeners: PASS (unit + e2e above).
- Only `WebEngineTS/player-host` is imported (`viewer.component.ts:19-20`; `check:csp` bundle scan passes); `index.html` has no import map; `angular.json` `externalDependencies` removed: PASS.
- nginx: sub_filter moved to `location ^~ /editor/`; `csp.conf` lost only `blob:` and the nonce; `csp-editor.conf` unchanged: PASS by diff (live behaviour of the editor location unexecuted, see DW-5.6).
- Iframe sandbox exactly `allow-scripts allow-pointer-lock` asserted in e2e: PASS.
- Edge cases: leave mid-download (test 84, unit), leave mid-load (test 85, unit), Space both focus cases, context loss (tests 73/82, unit), silent player -> error state with the Ukrainian "не відповів" text, frame removed (test 86, unit), restart while paused (tests 70/79, unit): all handled. Engine edge cases (before running, modifiers, repeat, editable, listener removal, audio unlock, one press = one toggle): all pinned by engine tests.

## Test-DW Coverage
- [ ] All DW items have corresponding tests that ran: DW-5.5 (render test self-skipped) and DW-5.6 (both tests skipped) do not.
- [x] Coverage level 100%: `viewer-format.ts` `mapPlayerError`/`absoluteUrl`/`isPauseShortcut`, every public/private routine in `viewer.component.ts`, and `PlayerRuntime` `_onKeyDown`/`isEditable`/pagehide have unit tests. Gap (minor, not failed): the default body of `createPlayerHost` (`new PlayerHost(...)`) is always replaced by the spec's fake; it is exercised by every e2e viewer test.

## Dead Code
None found (no unreachable code, no debug statements in the reviewed files).

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | PASS | `loadToken` increments on navigation/restart/destroy; stale `host.load`/`measure` rejections write nothing (unit "leaving mid-load", "superseded restart"); one key goes to exactly one document. Rapid double-Space before the player confirms sends `pause` twice; the player no-ops the second (design, not a double toggle). |
| Error Handling | PASS | handshake/origin/version/load mapped to Ukrainian text, unreported rejection ends in error state, download failure/abort distinguished, fullscreen rejection is a warning. |
| Resources | PASS | `dispose()` once on destroy, download aborted, three listeners removed, frame gone after exit (e2e 72/81/84-86). |
| Boundaries | PASS | `readFlag`, `absoluteUrl` on absolute input, empty `error.message` falls back, unknown total (`percent -1`) leaves ring at 0. |
| Security | PASS | hostile archive blocked (DW-5.1); no `allow-same-origin`; Space handler only toggles `timeScale` and posts a boolean; no CSP loosening beyond the listed removals. |

## Loaded-Skill Criteria
| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| aposd-verifying-correctness | RC-1..3 requirements mapped | FAIL | DW-5.5 and DW-5.6 lack execution evidence (above). |
| aposd-verifying-correctness | CS, EH-1..5, RM-1..5, BC, SE | PASS | see dimensions table; no silent catch-and-continue (the `catch {}` in `supportsWebGL2` returns false = unsupported screen; the engine unlock `catch` is documented). |
| cc-defensive-programming | external input validated at the barricade | PASS | engine `PlayerHost` validates messages (given); viewer maps and truncates nothing it should not; `absoluteUrl` is fed only server-supplied `manifestUrl`. |
| cc-defensive-programming | no empty catch / no side-effecting assertions | PASS | none found. |
| welc-legacy-code | changed code is under test / seam | PASS | `createPlayerHost` seam is the introduced seam; characterization via lifecycle spec. |

## Notes (non-blocking)
1. DW-5.4: each round trip starts with a full-page `goto`, so the test cannot see a context that leaks across SPA visits in one page, and "no live WebGL context" is never counted (e.g. by wrapping `getContext` in an init script). The frame detaches and the 11th run renders, which is decent indirect evidence.
2. `tests/RenderBackend.test.ts` fails 10 tests under full-suite load in this worktree (reproduced twice; first test hits a 5 s timeout) and passes alone; not on the stated flake list, unrelated to player code.
3. `virtual-lab/CLAUDE.md` still documents the import map, `script-src blob:`/nonce, `viewer-profiler.ts` and the disabled streamed restart; it contradicts the new code. Doc drift, outside the listed files.
4. `topNavigate` in the hostile test is asserted only through the host URL, not the script's own report; sound because the browser does not throw.
5. `npm run player-smoke` was not run.

## Issues (if FAIL)
1. DW-5.5: no executed evidence that a KTX2 scenario renders through the player.
   - File: `e2e/tests/ktx2.spec.ts:97-` (self-skips; log `transcoder fetched: false`), substitute test `:68-96`.
   - Demonstrated by: e2e run, test 43 skipped, test 42 only probes path/fetch.
   - Fix: build a small KTX2 scenario in the test (as `hostile-archive.spec.ts` builds its ZIP) or record a manual run through the viewer, and assert the transcoder was requested and VRAM is low; or have the owner explicitly accept the path probe as the DW's evidence.
2. DW-5.6: the editor nonce path was not executed.
   - File: `e2e/tests/editor-csp.spec.ts` (both tests skip without the editor override), `nginx/editor.conf:30-38`.
   - Demonstrated by: e2e run, tests 38-39 skipped.
   - Fix: run the e2e against a stack started with `docker-compose.editor.yml` (or the throwaway nginx the author describes) and attach the passing output.

**Verdict: FAIL - DW-5.5 and DW-5.6 have no execution evidence (skipped tests). DW-5.1, 5.2, 5.3, 5.4, 5.7, 5.U1 PASS; all listed edge cases and scope items hold.**
