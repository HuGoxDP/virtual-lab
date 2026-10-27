# Review: Phase 4 - serving the player (additive)

## Executed Results (Step 0)
- Frontend unit: `npx ng test --no-watch` -> 22 files, 287 passed, 0 failed
- Frontend build: `npm run build` -> success
- Backend: `npm test` -> 348 tests, 348 pass, 0 fail, 0 skipped
- e2e (:8045): 69 passed, 8 skipped (7 in streaming.spec.ts, 1 KTX2 scenario test in ktx2.spec.ts; none touch this change), 0 failed; first run
- nginx -t (CI step mounts reproduced; snippet extracted from the tarball, identical to node_modules copy): syntax ok, test successful (only a pre-existing duplicate MIME warning)
- Live curl with `Origin: null`: player.html/player.js/bundle/transcoder.wasm//a/ 404 all `ACAO: *`; /api/health and /player/x have no ACAO and carry the platform CSP
- Lint: none configured

## Requirement Fulfillment

### DW-4.1
PREMISE: e2e asserts `/player/player.html` headers (CSP whose origin equals the browser's scheme://host:port, sandbox, frame-ancestors 'self', no X-Frame-Options) and ACAO: * on player.html, player.js, the bundle, the transcoder and /a/.
EVIDENCE: e2e/tests/player-serving.spec.ts:19-47 (exact CSP built from `location.origin`), :49-56 (ACAO paths), :58-67; nginx/nginx.conf include of snippet, `= /assets/WebEngineTS.standalone.js`, `^~ /assets/basis/`, `/a/objects/`, `/a/`.
TRACE: page origin http://localhost:8045 -> GET player.html -> CSP string equals expected, no X-Frame-Options -> ACAO `*` on all 7 paths. Live curl matches.
VERDICT: PASS (tests 42-50 passed)

### DW-4.2
PREMISE: e2e: a top-level visit to /player/player.html reports origin === 'null' and the player shows that it refused.
EVIDENCE: player-serving.spec.ts:86-97
TRACE: goto player.html -> header `sandbox` makes doc opaque -> window.origin 'null'; body text "This page only runs inside the scenario viewer."; console contains 'top-level page'.
VERDICT: PASS (test 53)

### DW-4.3
PREMISE: The existing viewer and all suites still pass unchanged.
EVIDENCE: Step 0 results above. Existing specs changed only in viewer-lifecycle/viewer-profiler (DW-4.5, sanctioned).
TRACE: full frontend, backend, e2e runs green; skips are the streaming/KTX2 tests unrelated to the diff.
VERDICT: PASS

### DW-4.4
PREMISE: e2e: `/`, `/index.html`, `/scenarios/...`, `/a/...`, `/api/health` still carry the platform CSP, and `/player/` carries the player's.
EVIDENCE: csp.spec.ts:98-115
TRACE: nonce-normalised CSP from `/` compared to /index.html, /scenarios/, /a/molecules.json, /a/objects/00/missing.js, /api/health (all equal, contain frame-src 'self', no sandbox); player.html CSP has default-src 'none' + sandbox, no frame-src.
VERDICT: PASS (test 34)

### DW-4.5
PREMISE: viewer profiler unit specs pass on the latching engine; reopening uses `_resetDiagnosticsPolicy()` or equivalent and the specs still prove the lock and re-close.
EVIDENCE: viewer-profiler.spec.ts:20,33,65; viewer-lifecycle.spec.ts:110,114,461,480,491,509,535,554,569,601,609 (all `MemoryProfiler.diagnosticsAllowed = true` replaced). Assertions untouched (still expect false before load, re-close at the 1000 ms tick, not at 999, no re-close after destroy).
TRACE: reopen via reset -> advance 999 ms -> still true -> +1 ms -> false. 287 unit tests pass.
VERDICT: PASS

Scope items: angular.json glob `{player.html,player.js}` -> /player (angular.json diff; built output served 200 live); Dockerfile.frontend COPY of player.nginx.conf from build stage (stack built from it serves the headers); no X-Frame-Options on /player/ (curl); ACAO limited to bundle, basis, /a/objects/, /a/, player files; platform CSP only gains `frame-src 'self'` (csp.conf diff); viewer, import map, blob: untouched (additive). All verified.

**All requirements met:** YES

## Test-DW Coverage
- [x] All DW items have tests that ran in Step 0
- [x] Coverage level 100%: no new/changed code routines (config, Dockerfile, build glob, and spec edits); e2e covers each header contract. Gaps: none

## Dead Code
None found.

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | N/A | static config |
| Error Handling | PASS | 404s under /player/ and /a/ still carry ACAO/CSP (curl); `/player/x` 404 not the SPA page (test 51) |
| Resources | N/A | none |
| Boundaries | PASS | `^~ /player/` + exact locations; `/player/player.js` not taken by regex (test 50: no-cache, no XFO, no CSP) |
| Security | PASS | ACAO `*` only on the listed static resources; /api/ has none (curl); every own-header location includes csp.conf (bundle, basis, objects, /a/, /index.html, /scenarios/); player CSP is the engine snippet verbatim; `$http_host` retained (CSP shows :8045) |

## Loaded-Skill Criteria
| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| cc-defensive-programming | External input validated / no empty catch / no side-effecting asserts | N/A | no executable application code changed; only nginx config and test edits |
| cc-defensive-programming | Fail closed on unexpected paths | PASS | unknown `/player/*` returns 404, never the SPA fallback |
| cc-defensive-programming | Defense in depth for security headers | PASS | each location repeats headers and csp.conf; player CSP carries both `sandbox` header and frame-ancestors |

## Notes (non-blocking)
- `/assets/WebEngineTS.standalone.js` location lacks the `immutable` caching the regex gave other js; it uses no-cache (matches engine-bundle intent). Unverified against prior behavior; the test only asserts a cache-control exists.
- DW-4.1 `/a/` ACAO is asserted only on 404 responses in e2e; the 200 path is covered only by config inspection (streaming specs skipped here).
- The two `location ^~ /assets/basis/` and bundle locations duplicate the header block (maintenance risk if csp.conf set changes).

## Issues
None.

**Verdict: PASS**
