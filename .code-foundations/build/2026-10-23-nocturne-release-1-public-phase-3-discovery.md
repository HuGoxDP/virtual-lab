# Discovery + Design: Phase 3 - Catalog and scenario page

## Files Found
- `frontend/src/app/pages/catalog/` - old component (modal, focus trap, theme toggle, emoji chips), spec, scss
- `frontend/src/app/services/scenario.service.ts` (+spec) - catalog state, `fetchScenarioById`, ZIP download (viewer uses the last two)
- `frontend/src/app/models/scenario.model.ts`, `app.routes.ts`, `app.component.ts`
- Phase 2 UI: `ui/{icon,site-header,site-footer,scenario-card,toast}`, `ui/format.ts`, `ui/category-gradient.ts`, `site.config.ts`
- `pages/admin/admin.component.{ts,html}` (+ `AdminService.ScenarioDraft`), no admin component spec
- e2e: `student-golden-path`, `catalog-a11y`, `admin-golden-path`, `csp` (catalog render), `nocturne-foundation`
- Backend contract (Phase 1): `/api/catalog` items + `categories[{category,categoryLabel,icon,count}]` + `summary`, `/api/catalog/:id` + `related[{id,title,category,categoryLabel,imageUrl}]`, `/api/config`

## Current State
Catalog is the pre-Nocturne page with an in-page modal; filters live in component signals only; service replaces/appends pages with no protection against out-of-order responses and clears chips on error.

## Gaps
- No `/scenario/:id` route, no `/api/config` client, no `summary`/`icon`/`count`/`sort` handling.
- `<vl-toast-host>` is not mounted anywhere (Phase 2 says "mount once in the app shell").
- `PUT /api/catalog/:id` already accepts `features`; `AdminScenario` already receives them. Only the `/admin` form lacks the editor.
- Phase 2 specs carry no test-plan numbers (this phase numbers them).
- "back from scenario page restores filters": the in-page "Katalog" button must carry the last filter, browser Back works through the URL.

## Code Standards
Signals only, OnPush, zoneless, `inject()`, `firstValueFrom`, services catch + set `_error`, path comment atop each file, UI Ukrainian / code English, spec headers cite test-plan numbers, no client-side filter/sort/page.

## Test Infrastructure
vitest through `ng test`, `TestBed` + `provideHttpClientTesting`, `await Promise.resolve()` after flush. Playwright in `e2e/` against `http://localhost:8044`.

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-3.1 | catalog header/hero/sort/chips/"Знайдено N"/grid/footer | COVERED | catalog.component.spec (hero counters, chips icon+count order, plural, Увійти/Панель, footer limit, sort drives request); platform-config.service.spec |
| DW-3.2 | server-side URL-backed filters, back restores, load more keeps, stale loses | COVERED | catalog-query.spec (round trip); catalog.component.spec (URL -> request, nav on chip/sort/search, load more keeps query); scenario.service.spec (out-of-order); e2e deep link + back |
| DW-3.3 | empty + reset, error + retry | COVERED | catalog.component.spec empty/reset/error/retry; e2e empty search |
| DW-3.4 | scenario page fields/blocks/not-found/error/title/header | COVERED | scenario.component.spec; e2e |
| DW-3.5 | copy link toast/fallback, download href | COVERED | scenario.component.spec (clipboard ok / missing / rejected, href); e2e |
| DW-3.6 | modal + theme gone, card/launch targets | COVERED | catalog.component.spec (no `theme` key, no dialog, navigation targets); e2e |
| DW-3.7 | 390px no h-scroll, chips scroll, sticky launch bar | COVERED | e2e catalog-mobile |
| DW-3.8 | /admin features editor (6 max, 400 surfaced) | COVERED | admin.component.spec; e2e admin golden path (features) |
| DW-3.9 | no cross-origin request (HAR) | COVERED | e2e same-origin spec |
| DW-3.10 | unit + e2e updated, green | COVERED | all suites |

**All items COVERED:** YES

## Design Decisions
- URL is the single source of truth for `category`, `q`, `sort` (default values omitted). Pure helpers in `services/catalog-query.ts`; the catalog derives a `filter` computed from `queryParamMap` and an effect loads it. Search typing keeps a local text signal and navigates (replaceUrl) after the debounce; sync from URL is skipped while a debounce is pending.
- Stale responses: `ScenarioService` takes a monotonically increasing ticket per request; a response/error for an older ticket is dropped and cannot flip `loading`.
- Service remembers the last requested filter so the scenario page's "Каталог" button returns with it.
- `PlatformConfigService.load()` for `/api/config`; failure leaves `maxArchiveBytes` null (footer states format only).
- Scenario page: route param -> ticketed load -> `status` signal (`loading|ready|not-found|error`). Clipboard failure shows a read-only selected input.
- Toast host mounted in `AppComponent`.

## Prerequisites
- [x] Phase 1 API and Phase 2 components available
- [x] Stack running on :8044

## Recommendation
BUILD
