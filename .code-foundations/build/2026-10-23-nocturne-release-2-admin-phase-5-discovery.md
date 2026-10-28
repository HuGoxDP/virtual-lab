# Discovery + Design: Phase 5 - Admin UI: sign-in, shell, list, metadata and publication

## Progress (update as you go)
- [x] Discovery, design, DW mapping (this file)
- [x] Models + services (`AdminService` 503 dropped, `AdminApi`, `AdminSession`, guards)
- [x] ui: `vl-status-pill`, `vl-icon-picker`
- [x] pages: legacy moved, login, shell, slots, list, edit, meta form, publish
- [x] routes
- [x] unit tests
- [x] e2e (key-parameterised helpers, golden path, affected specs) - written + type-checked, NOT run
- [x] docs (code-standards:96, CLAUDE.md, test-plan 208+, manual-browser-checks)
- [x] full frontend suite + `npm run build && npm run check:csp`

## Files Found
- `frontend/src/app/pages/admin/admin.component.{ts,html,scss,spec.ts}` - the old admin (selector `app-admin`, class `AdminComponent`; `src/styles/_legacy.scss` scopes by that selector, so keep it).
- `services/admin.service.ts` - token in `sessionStorage` key `adminToken`, legacy CRUD, `uploadArchive`, `describeError` (503 branch to drop). Read by `scenario.service.ts` and `catalog.component.ts` (bearer / "Панель" label).
- `app.routes.ts` - `admin` -> old component; `**` -> catalog (so `/admin/scenarios/x` redirected to catalog).
- `ui/`: `scenario-card` (`vl-scenario-card`, input `ScenarioCardData`), `icon` (`ICON_NAMES`), `toast`, `site-header`, `format`, `category-gradient`.
- `src/styles/` (global Nocturne tokens, `.btn*`, `.input`, `.field`, `.seg`, `.tag*`, `.table`, `.dialog`) - OUT of this phase's file scope; admin-specific CSS goes in component stylesheets.
- Backend routes (contract, read, not changed): catalog-admin, workflow, versions, previews, version-tools, bulk, dashboard, categories, keys, auth (`/api/auth/me`).
- e2e: `helpers/api.ts` (hardcoded `ADMIN_TOKEN`), `tests/admin-golden-path.spec.ts`; other specs that load `/admin`: `catalog-scenario-page`, `csp`, `nocturne-foundation`, `draft-preview`.

## Current State
Single token-gated `/admin` page with CRUD table; no roles, no statuses (only `isPublished` toggle), no shell.

## Gaps (plan vs reality)
1. Plan lists `/admin` as a child route but the dashboard is Phase 7 -> `/admin` redirects to `/admin/scenarios` for now (Phase 7 replaces it); the nav has no "Огляд" until then.
2. No "get one admin row" endpoint -> `AdminApi.scenario(id)` = list + find (unpaged admin list; backend not in scope).
3. 403 is overloaded server-side: wrong credential (`Невірний токен`) vs. forbidden (`Недостатньо прав`, `Це не ваш сценарій`). A forbidden action must not sign the user out -> only 401 and 403 `Невірний токен` end the session (decision D2).
4. Global styles (`src/styles`) out of scope -> component-local SCSS; status colours come from the research doc.
5. Old-admin e2e/characterisation specs assume `/admin` is the old page -> repointed at `/admin/legacy` (signed in via the new login).
6. Token codes are case-sensitive (base64url): the prototype's uppercase login field is not copied (D4).

## Code Standards
Angular standalone + OnPush + zoneless, signals, no `fakeAsync` (vitest fake timers), UI Ukrainian / code+comments English, `// path:` header in files, no `innerHTML`/`bypassSecurityTrust*`. `docs/code-standards.md:96` must stop saying the auth middleware answers 503.

## Test Infrastructure
Vitest via `ng test`; `provideHttpClientTesting` + `HttpTestingController`; settle signals with several `await Promise.resolve()` then `detectChanges()`. e2e = Playwright in `e2e/` (not run by me).

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-5.1 | Sign-in shows name and role from `/api/auth/me`; code only in `sessionStorage`, cleared on sign-out; old admin only at `/admin/legacy`, moderators | COVERED | admin-session.service.spec (signIn author/moderator, revoked 403, empty, sign-out clears), admin-login.component.spec, admin-shell.component.spec (name+role), admin-guards.spec (legacy: author -> /admin, moderator ok, anonymous -> login) |
| DW-5.2 | List filters by status and category, status pills; moderators bulk bar + results | COVERED | scenario-list.component.spec (status chip counts, filter by status, by category, pill text, author has no checkboxes/bulk bar, moderator bulk approve with per-id result display, set-category) |
| DW-5.3 | Метадані saves fields, <=6 features, preview; live card == catalog card; readiness reflects description/preview/archive | COVERED | scenario-meta-form.component.spec, icon-picker.component.spec, scenario-rules.spec (readiness) |
| DW-5.4 | Публікація: each allowed transition per role, audit history | COVERED | scenario-publish.component.spec, scenario-rules.spec (transitionsFor, describeEvent) |
| DW-5.5 | Unsaved guard; mid-session 401/403; 390px drawer; e2e sign-in -> edit -> submit | COVERED | scenario-edit.component.spec (tab switch keeps edits, guard confirm), admin-api.service.spec (401/403 end session), admin-shell.component.spec (burger/drawer), e2e admin-workflow.spec |

**All items COVERED:** YES

## Design Decisions
Design-it-twice for the session/API seam:
- A: one fat `AdminService` (token + user + all routes) - rejected: legacy admin, catalog and scenario.service already depend on its small surface, and `me()` vs token circularity.
- B: `AdminService` stays the token holder (+ `endSession(reason)`), `AdminApi` = typed routes (calls `endSession` on credential rejection), `AdminSession` = who am I (`signIn/restore/signOut`, `user`, `role`). No cycle: Session -> Api -> Service. `user` is `computed` over the token, so a token cleared anywhere signs the UI out. CHOSEN.
- C: HttpInterceptor for auth failures - rejected: the legacy admin and public requests share the client; 403 discrimination is admin-API specific.

Other choices:
- Edits survive tab switches because the Метадані form is never destroyed (`[hidden]` on other tabs); the edit page owns dirty state (`canDeactivate` confirm + `beforeunload`).
- `vl-scenario-meta-form` keeps `edits` (partial overrides over the `scenario` baseline); `dirty` = any edit differs from baseline; stale edits equal to a refreshed baseline are pruned.
- Authors' patch never contains `author`/`imageUrl`; a moderator's contains `author` only when changed; `categoryLabel` is sent with a changed category.
- Role-aware buttons from `scenario-rules.ts` (`transitionsFor`), the API stays the authority (its error is shown).
- Scenario text is only ever interpolated (`{{ }}`), never innerHTML; long unbroken text uses `overflow-wrap:anywhere`.
- `/admin/legacy` is a sibling route (no shell), `moderatorGuard`.

## Prerequisites
- [x] Phase 2-4 backend routes exist (read)
- [x] Release 1 Nocturne classes and ui components exist
- [x] Backend not needed (no change)

## Recommendation
BUILD
