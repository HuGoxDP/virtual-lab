# Review: Phase 7 - admin moderation UI

## Executed Results (Step 0)
- Unit: `npx ng test --no-watch` -> 45 files, 704 tests passed, 0 failed (coverage lines 98.29%).
- Build: `npm run build` OK; `npm run check:csp` OK (no bare engine import).
- Typecheck e2e: `tsc -p e2e/tsconfig.json --noEmit` -> only the 2 known base-commit errors in viewer.spec.ts (100/374).
- e2e: `playwright test admin-moderation` -> 2 passed, **1 failed**: `DW-7.6 issue a code, upload, submit, publish, new archive stays pending until accepted, revoke` at admin-moderation.spec.ts:92 (`expect(card).toHaveCount(0)` after clicking approve; card remained, 15 s timeout).
- Grep: no `innerHTML` / `bypassSecurityTrust*` in non-spec code; no `from 'WebEngineTS'` import.

## Requirement Fulfillment
DW-7.1 queue: queue.component.ts (tabs, cards with reviewChips, decide() -> api.transition/versionAction -> load(), decisions table). Unit specs pass (queue.component.spec.ts). e2e publish step FAILS (see issue 1). VERDICT: PASS on unit evidence; e2e evidence failing.
DW-7.2 dashboard: dashboard.component.ts, spec passes; e2e `DW-7.2` passed. PASS.
DW-7.3 categories: categories.component.ts (move/toggleVisible/add/remove, delete disabled when scenarioCount>0, 409 refetch); specs pass; e2e `DW-7.3` passed. PASS.
DW-7.4 keys: access.component.ts (issued signal cleared by dismiss/destroy, copy, revoke own key -> session.signOut()); specs pass. The e2e revoke/"revoked key stops working" assertion lives in the failing DW-7.6 test and was never reached. PASS on unit evidence only for revoked-key rejection (backend contract given).
DW-7.5 test run: test-run.component.ts + player/test-run-report.ts; specs pass (saves report with userAgent/engineBuild, crashing fixture stores `{error}`, 500-char build truncated to 100, host disposed on destroy). PASS.
DW-7.6 e2e: **FAIL** (test fails when run).

**All requirements met:** NO (DW-7.6)

## Test-DW Coverage
- DW items have named tests: yes. Level 100%: TestRunComponent has no own spec but its run/cancel/404/destroy paths are exercised through scenario-checks.component.spec.ts; accepted.
- The DW-7.6 test exists but fails.

## Correctness Dimensions
| Dimension | Status | Evidence |
|---|---|---|
| Concurrency | PASS | queue load() request counter; busyId guards double decisions |
| Error Handling | PASS | server refusals shown; run failures -> `{error}` |
| Resources | PASS | PlayerHost disposed in stop() on finish/cancel/destroy |
| Boundaries | PASS | clamping/truncation in test-run-report |
| Security | PASS | text interpolation only; token cleared on close/destroy |

## Loaded-Skill Criteria
| Skill | Criterion | Status | Evidence |
|---|---|---|---|
| aposd-verifying-correctness | Requirements coverage | FAIL | DW-7.6 e2e fails |
| aposd-verifying-correctness | Error handling / resources / boundaries / security | PASS | as above |
| cc-defensive-programming | External input validated (untrusted player metrics) | PASS | buildTestRunReport non-finite -> error, clamps, truncates |
| cc-defensive-programming | No empty catch | PASS | copy() catch sets a note; others set error |

## Edge cases
Token never re-shown: PASS. Revoke own key signs out: PASS (unit). Errored run stores error: PASS. engineBuild/userAgent truncation: PASS. Reorder 409 re-fetch: PASS (unit).

## Notes (non-blocking)
- Queue decide() uses `confirm()` when any chip is `bad` (e.g. fixture has no preview -> "Немає превʼю"); this is the cause of issue 1.

## Issues (if FAIL)
1. e2e DW-7.6 fails at the first publish.
   - File: e2e/tests/admin-moderation.spec.ts:91-92 (and queue.component.ts decide(), `confirm('Автоперевірка або заповненість мають проблеми. Опублікувати все одно?')`).
   - Demonstrated by: Playwright run above. The fixture scenario (createScenario + buildScenarioZip) has no preview image, so reviewChips yields a `bad` chip ("Немає превʼю"); clicking approve opens a native confirm; Playwright auto-dismisses it when no `dialog` handler is registered, `decide` returns early, the card stays. The spec registers `page.once('dialog', accept)` only for revoke (line 120) and category delete (151), not before the approve clicks at 91 and the proposal approve (~112; a proposal skips the confirm, so only 91 needs it).
   - Fix: register `page.once('dialog', d => void d.accept())` before the first approve click (or give the fixture a preview image). Re-run the full spec to confirm the remainder (new-archive-pending, accept, revoke, revoked key 403) passes; those steps were never executed.

**Verdict: FAIL** - DW-7.6 e2e test fails when run.
