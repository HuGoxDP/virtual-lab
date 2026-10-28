# Review: Phase 5 - Admin shell, list, Метадані, Публікація (review 2)

## Executed Results (Step 0)
- Unit suite: `npx ng test --no-watch` (frontend/) -> 34 files, 500 tests passed, 0 failed (coverage: stmts 92.4%, branches 89.7%, funcs 88.4%, lines 94.3%).
- Build: `npm run build` -> OK. `npm run check:csp` -> "The built app matches the CSP".
- e2e type-check: `tsc -p e2e/tsconfig.json --noEmit` -> only the 2 base-commit errors in `e2e/tests/viewer.spec.ts` (100, 374).
- Lint: none configured.
- NOT executed: Playwright e2e (needs docker stack from this branch). `admin-workflow.spec.ts`, `admin-ui.ts`, `api.ts` helpers and the changed e2e specs were read and type-checked only; their steps trace correctly against the code and the backend contracts, but are unrun.

## Requirement Fulfillment

### DW-5.1
PREMISE:  Sign-in by code shows name and role from `/api/auth/me`; the code lives only in `sessionStorage` and is cleared on sign-out; the old admin answers only at `/admin/legacy`, for moderators.
EVIDENCE: admin-session.service.ts:34-69 (signIn/restore/signOut); admin.service.ts:31-52 (sessionStorage, clearToken, endSession); admin-shell.component.ts user card + signOut; app.routes.ts `admin/legacy` with `moderatorGuard`; admin-guards.ts:21-27.
TRACE:    code -> `api.me(code)` -> `/api/auth/me` {role,label} -> setToken (sessionStorage only; no localStorage use in admin code, grep) -> shell shows label/role; signOut -> removeItem + user null -> shell effect navigates to /admin/login. Author hitting /admin/legacy -> moderatorGuard -> redirect /admin/scenarios. Legacy component is a path-only move (diff = import paths).
VERDICT:  PASS (33 DW-5.1-named unit tests green: admin-login, admin-session, admin-guards, admin-shell, ...; e2e #214 unrun)

### DW-5.2
PREMISE:  The list filters by status and category, shows status pills; moderators get the bulk bar and its results.
EVIDENCE: scenario-list.component.ts chips/categoryOptions/visible (l.~190-215), bulk bar gated by `session.isModerator()`, `runBulk` -> `api.bulk` -> `report`; status-pill.component.ts.
TRACE:    rows -> chip counts per status; statusFilter+categoryFilter AND-filter -> table with `<vl-status-pill>`; moderator selects ids -> POST /api/scenarios/bulk {ids,action,category?} (matches backend bulk.js) -> `{results}` rendered per id with error; 400 keeps selection.
VERDICT:  PASS (28 DW-5.2 tests green)

### DW-5.3
PREMISE:  Метадані saves fields, up to six features and a preview; the live card matches the catalog card; the readiness list reflects missing description/preview/archive.
EVIDENCE: scenario-meta-form.component.ts (patch/save l.~330-370, features l.~300-330, preview l.~375-420, card computed uses the real `ScenarioCardComponent`, readiness via scenario-rules.ts `readiness`).
TRACE:    edits over baseline -> PUT /api/catalog/:id only changed fields (author omitted for authors; categoryLabel ignored server-side for authors, verified in catalog-admin.js) ; features capped at 6 client side (server 6); preview -> POST /preview multipart `preview`; readiness lists archive/description/preview.
VERDICT:  PASS (20 DW-5.3 tests green incl. 6-features cap, 0/160 counter, author read-only, card is the catalog component)

### DW-5.4
PREMISE:  Публікація performs each allowed transition for the role and shows the audit history.
EVIDENCE: scenario-rules.ts:36-60 `transitionsFor`; scenario-publish.component.ts `run`/`loadHistory`; admin-api.service.ts `transition`, `history`.
TRACE:    transitionsFor compared with backend/workflow.js TRANSITIONS: approve(review|draft|rejected, mod), reject(review, mod, note<=2000 via maxLength), unpublish(published, mod), submit(draft|rejected), withdraw(review) - identical. Button -> POST /api/scenarios/:id/<action> -> toast, `changed` emit, history refetch (GET /history returns array, audit.listActivity) rendered via describeEvent as text.
VERDICT:  PASS (20 DW-5.4 tests green)

### DW-5.5
PREMISE:  Unsaved-changes guard and mid-session 401/403 behave as stated; at 390 px the shell uses the drawer; e2e covers sign-in -> edit -> submit.
EVIDENCE: admin-guards.ts:36-51; scenario-edit.component.ts (form hidden not removed, beforeunload, effect on id); admin-api.service.ts:21-55 (`isCredentialRejection`, `call`); admin-shell.component.ts effect + drawer; admin-shell.component.scss:57-74 (@media narrow); e2e/tests/admin-workflow.spec.ts.
TRACE:    Tab switch (:tab param only) -> canDeactivate runs -> guard sees same `:id` prefix -> true, no confirm; spec uses the real router (RouterTestingHarness) with `confirm` stubbed to false and asserts no call and edits kept. Different scenario / other section -> `window.confirm(UNSAVED_PROMPT)`. 401, or 403 body "Невірний токен" -> endSession(reason) -> shell effect -> /admin/login showing `endedReason`; other 403s (Недостатньо прав, Це не ваш сценарій) do not sign out. Drawer: CSS media query + burger/scrim/Escape state tested in jsdom; the real 390 px viewport only by the unrun e2e.
VERDICT:  PASS (28 DW-5.5 tests green; the 390 px layout and e2e flow are unexecuted - reading only)

**All requirements met:** YES

## Edge cases (listed)
- Unsaved edits survive tab switches and warn on leaving: HANDLED (scenario-edit spec "survive Метадані -> Публікація -> Метадані", confirm stubbed explicitly; guard spec stubs `confirm` with mockReturnValue; the two spies without a mock only assert "not called").
- 401/403 mid-session -> login with reason: HANDLED (scenario-edit spec "a code the server stops accepting ends the session", shell spec, admin-api spec).
- Buttons follow the role, API stays authority: HANDLED (server refusal shown as sent).
- Long author text: title/author wrap rules in scss (`overflow-wrap:anywhere`), unit tests assert content kept; true layout only in unrun e2e.
- Login author/moderator/revoked/empty; six features; author read-only; no prompt on tab switch: tests present and green.

## Test-DW Coverage
- [x] All DW items have named tests (ran in Step 0).
- [x] 100% level: every new source file has a spec (admin-api, admin-session, guards, login, shell, slot, list, meta-form, publish, edit, rules, icon-picker, status-pill, format, admin.service). `admin-testing.ts` is a test helper. Gaps: none found.

## Dead Code
None found (no debug statements or unreachable code in the reviewed files).

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | PASS | Edit page ignores stale responses (`id !== this.id()`), busy flags prevent double submit; guards run concurrent `restore()` harmlessly. |
| Error Handling | PASS | Every API call surfaces `describeError`; credential rejection ends the session once, in `AdminApi.call`. |
| Resources | PASS | No handles; document listeners are HostListeners (auto-removed); router subscription uses takeUntilDestroyed. |
| Boundaries | PASS | Empty code, 0/160/161 description, 6/7 features, empty list, unknown status/tab all traced and tested. |
| Security | PASS | No innerHTML/bypassSecurityTrust in app code (grep); author text interpolated only; code only in sessionStorage; `[hidden]` tab not shadowed by a `display` rule. |

## Loaded-Skill Criteria
| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| aposd-verifying-correctness | RC requirements mapped to code | PASS | DW table above |
| aposd-verifying-correctness | CS/EH/RM/BC/SE | PASS | dimension table |
| aposd-designing-deep-modules | Interface depth / info hiding | PASS | `AdminApi` hides bearer and session-ending; `transitionsFor`/`readiness`/`describeEvent` centralise workflow knowledge; meta form takes only `[scenario] [role]` |
| cc-defensive-programming | External input validated at entry | PASS | code trimmed/empty-checked before request; server responses use `?? []` fallbacks; unknown status handled by `statusMeta` |
| cc-defensive-programming | No empty catch | PASS | the three silent catches (queue badge, config, ...) each set a neutral value and are commented |

## Notes (non-blocking)
- Manual sign-out (`AdminShell.signOut`) discards unsaved Метадані edits without asking; the guard deliberately skips once the session is gone. The requirement only names leaving a page, so not a FAIL.
- `AdminSession.restore()` drops the code on any failure of `/me`, including a transient 500/network error; the user must re-enter the code after a blip.
- `ScenarioPublishComponent.loadHistory` is not guarded against a stale response when the scenario id changes (cosmetic; component is recreated per scenario in practice).
- After a successful save, if the follow-up refetch fails the form stays "dirty" with already-saved values.
- `admin-testing.ts` lives in app source; unused in prod, tree-shaken (build OK).

## Issues (if FAIL)
None.

**Verdict: PASS** (e2e and the real 390 px layout were not executable here; they are verified by reading and type-check only)
