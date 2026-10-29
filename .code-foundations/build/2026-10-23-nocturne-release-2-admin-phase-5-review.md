# Review: Phase 5 - admin shell, list, Метадані, Публікація

## Executed Results (Step 0)
- `npx ng test --no-watch` (frontend): 33 files, 487 tests passed.
- `npm run build && npm run check:csp`: OK ("built app matches the CSP").
- e2e type-check (`tsc -p e2e/tsconfig.json --noEmit`): only the 2 known `viewer.spec.ts` (100/374) errors.
- Lint: no ESLint configured (`ng lint` offers `ng add angular-eslint`) - not run.
- e2e (Playwright) NOT executable here (needs docker stack). Judged by reading against UI/API code.
- Backend suite not re-run (unchanged). API calls checked by reading `backend/routes/*.js`: paths, methods, bodies, response shapes match.

## Requirement Fulfillment
### DW-5.1  PASS
EVIDENCE: admin-session.service.ts signIn/restore/signOut; admin.service.ts:32 (sessionStorage), endSession; admin-guards.ts; app.routes.ts `admin/legacy` + moderatorGuard; admin-shell user card.
TRACE: code -> `GET /api/auth/me` -> token stored in sessionStorage only if valid -> shell shows label + role; signOut clears token -> shell effect navigates to /admin/login; author at /admin/legacy -> moderatorGuard -> /admin/scenarios. No localStorage use; no innerHTML/bypassSecurityTrust in admin code (grep). Tests: admin-session, admin-login, admin-guards, admin-shell specs (passing). 503 branch removed (admin.service.ts diff); code-standards.md updated.
### DW-5.2  PASS
EVIDENCE: scenario-list.component.ts chips/categoryFilter/visible/bulk bar (moderator only)/report. TRACE: status chip + category select filter `rows` client-side; moderator selects rows -> `POST /api/scenarios/bulk {ids,action,category?}` -> per-id results shown. scenario-list spec passes.
### DW-5.3  PASS
EVIDENCE: scenario-meta-form.component.ts (MAX_FEATURES 6, 0/160 counter, author readOnly for non-moderators and never sent, uploadPreview + warnings, live card via vl-scenario-card, readiness()). TRACE: edit -> patch of changed fields only -> `PUT /api/catalog/:id`. Spec passes.
### DW-5.4  PASS (with a Note)
EVIDENCE: scenario-rules.ts transitionsFor; scenario-publish.component.ts run(); history via `GET /api/scenarios/:id/history`. TRACE: author draft -> submit; review -> withdraw; moderator approve/reject{note<=2000}/unpublish; "Відкрити в каталозі" when published. Specs pass.
### DW-5.5  FAIL
Parts that hold: 401/403(revoked) mid-session -> AdminApi.call -> admin.endSession(reason) -> shell effect -> /admin/login showing endedReason (admin-api, shell specs); beforeunload guard; 390px drawer markup/specs; sign-in -> edit -> submit e2e reads correctly against UI/API.
Part that fails: "unsaved edits survive tab switches" - see Issue 1.

**All requirements met:** NO

## Test-DW Coverage
- DW items all have named tests (DW-5.x in spec names).
- Coverage level 100% - GAPS (Issue 2): `frontend/src/app/pages/admin/admin-slot.component.ts` (AdminSlotComponent, new) has no spec; `AdminApi.createScenario, deleteScenario, uploadArchive, fromArchive, saveTestRun, createCategory, updateCategory, createKey` (admin-api.service.ts) have no test (admin-api.service.spec.ts "covers the remaining routes" omits them; grep finds no other caller).

## Dead Code
None found.

## Correctness Dimensions
| Dimension | Status | Evidence |
|---|---|---|
| Concurrency | PASS | scenario-edit refresh() guards stale id; busy flags on save/transition/bulk |
| Error Handling | FAIL | Issue 1 (guard misfires, user cannot cancel into a tab switch); otherwise errors surfaced via describeError |
| Resources | PASS | no leaks seen; router subscription uses takeUntilDestroyed |
| Boundaries | PASS | 6-feature cap, 160 counter, 300-char title wrapping (CSS + spec), empty code rejected |
| Security | PASS | text interpolation only; code in sessionStorage; code never in URL |

## Loaded-Skill Criteria
| Skill | Criterion | Status | Evidence |
|---|---|---|---|
| aposd-verifying-correctness | RC requirements mapped | FAIL | DW-5.5 tab-switch edge case |
| aposd-verifying-correctness | EH-5 no silent error path | PASS | queue badge failure is deliberately silent, session end is surfaced |
| cc-defensive-programming | external input validated at entry | PASS | signIn trims/rejects empty; server response `scenarios ?? []`; `versions()`/`categories()`/`keys()` read `.versions` etc. without a fallback (Note) |
| aposd-designing-deep-modules | interface depth | PASS | AdminSession/AdminApi hide token + session-ending behind small surface |

## Notes (non-blocking)
- A moderator is not offered `withdraw` (or `submit`) although the backend allows both; `approve`/`reject` cover the common cases. Judgement call vs "each allowed transition for the role".
- AdminApi.versions/categories/keys dereference the wrapper key with no `?? []` fallback (listScenarios has one).
- No ESLint configured; sign-out with unsaved edits discards them silently (guard skips when unauthenticated) - reasonable.

## Issues
1. **`unsavedChangesGuard` also fires on a tab switch** (blocking; edge case "unsaved edits survive tab switches")
   - File: frontend/src/app/app.routes.ts (route `scenarios/:id/:tab`, canDeactivate) and admin-guards.ts `unsavedChangesGuard`.
   - Demonstrated by: Angular router source `getRouteGuards` (node_modules/@angular/router/fesm2022/_router-chunk.mjs:2297-2308): same routeConfig + changed params (`:tab`) with default `runGuardsAndResolvers` pushes a CanDeactivate on the active component; the guard ignores next state, so dirty form + click "Публікація" calls `window.confirm`, and Cancel blocks the tab switch. The unit test "survive Метадані -> Публікація -> Метадані" passes only because jsdom's unimplemented `window.confirm` returns undefined (test log prints "Not implemented: Window's confirm() method" twice = the two goToTab calls) - it never exercises a real answer. e2e `DW-5.5 unsaved edits survive a tab switch` registers no dialog handler for the tab clicks; Playwright auto-dismisses -> navigation cancelled -> fails at `vl-scenario-publish` toBeVisible.
   - Fix: make the guard skip when the next route is the same scenario (use CanDeactivateFn's `currentState/nextState` or `currentRoute.paramMap.get('id')`), or set `runGuardsAndResolvers: 'pathParamsChange'` limited to id; add a unit test with confirm mocked to false that a tab switch still succeeds without calling confirm.
2. **Coverage gap vs 100% level** - AdminSlotComponent (no spec) and eight AdminApi methods without a test (listed above). Add a slot spec (title from route data) and extend the contract table in admin-api.service.spec.ts.

**Verdict: FAIL** - blockers: Issue 1 (tab-switch prompt; e2e would fail), Issue 2 (coverage gaps).
