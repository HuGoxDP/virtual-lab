# Batch review: Nocturne release 1 - Phases 2 and 3

## Executed Results (Step 0, shared by both phases)
- Frontend unit: `npx ng test --no-watch` -> 17 files, 226 tests passed.
- Build/typecheck: `npm run build` -> OK. `npm run icons:check` -> exit 0 (no diff).
- e2e (stack on :8044): `npm test` -> 47 passed, 8 skipped (ktx2/streaming, data-dependent `test.skip`), **1 failed**:
  `nocturne-foundation.spec.ts:153 DW-2.6 the old /admin keeps its computed look under the legacy-admin scope`.
  Diff: `.toolbar .btn-primary` backgroundColor expected `rgb(99,102,241)`, got `rgb(102,105,241)`.
  Re-run in isolation 3 times: 3/3 pass. Cause: old admin `.btn-primary` has `transition: background .15s` (admin.component.scss:70);
  the snapshot is taken straight after `.toolbar .btn-primary` is clicked while the pointer still hovers it, so a 150 ms hover transition can be
  mid-flight. A race in the characterization test, not a visual regression. It still failed in the full run.
- Lint: none configured.

## Phase 2 - Nocturne foundation

| DW | Evidence | Trace | Verdict |
|---|---|---|---|
| 2.1 | `styles/_tokens.scss`, `_base.scss`, `_components.scss`; `nocturne-styles.spec.ts`; `nocturne.fixture.ts` | I diffed all 51 `--token: value` pairs of `part01.style.txt` against `_tokens.scss`: identical. Every class in the design file exists. `--color-bg: #161826`, body paints it. Spec forbids light-theme / prefers-color-scheme. | PASS |
| 2.2 | `_fonts.scss` (6 faces, `/assets/fonts/`, files exist); spec DW-2.2; `csp.spec.ts` and `nginx/` have no diff in either commit | csp.spec passed in the e2e run | PASS |
| 2.3 | `icon.component.ts:35-46`, `build-icons.mjs`, `icon-generator.spec.ts`, `icon.component.spec.ts` | `<svg><path [attr.d]>`; no `innerHTML` / `bypassSecurityTrust*` in src (grep). Unknown/null name -> `folder`, uses `Object.hasOwn`. `icons:check` exit 0. Generator throws on non-path-only (parsePaths). | PASS |
| 2.4 | `scenario-card/*.spec.ts`, `site-header`, `site-footer`, `toast.spec.ts`, `category-gradient.spec.ts` | Card: `onLaunch` stopPropagation, so launch emits no `open`. No image or `(error)` -> gradient. Header/footer read `SITE`. Toast shows, hides at 2600 ms, replaced by newer. | PASS |
| 2.5 | `format.ts`, `format.spec.ts` | `formatBytes(50537267)` -> `48,2 МБ`; `formatDate('2026-03-12T10:00:00Z')` -> `12 бер 2026` (Kyiv, own month table); `pluralUk` 1/2/5/11/21; null -> `''` | PASS |
| 2.6 | `_legacy.scss`, `admin.component.html` (`legacy-admin`), e2e characterization | Frontend suite green. e2e characterization of /admin **failed once in the full run** (flaky, see Step 0); viewer characterization passed. | PARTIAL (see Issue 1) |

Edge cases: unknown icon (PASS), no/failing image -> gradient (PASS), plurals 1/2/5/11/21 (PASS), null bytes -> nothing (PASS), long-title clamp (PASS: `-webkit-line-clamp: 2`, spec at 200 chars).

Coverage level 100%: every new routine in Phase 2 files has a unit test (lcov: no unexecuted function in `ui/`, `styles`; `readPhosphorSvg`/`main` in build-icons run in the `--check` subprocess spec).

## Phase 3 - Catalog and scenario page

| DW | Evidence | Trace | Verdict |
|---|---|---|---|
| 3.1 | `catalog.component.html/ts`; unit + e2e `DW-3.1` | Header "Увійти"/"Панель" from `admin.isAuthenticated()`; hero tag `site.department`; counters from `summary`; chips `categories()` = "Усі" + API order with icon and count; "Знайдено N"; footer limit from `PlatformConfigService` | PASS |
| 3.2 | `catalog-query.ts`, `scenario.service.ts:fetchPage` (ticket `latestRequest`), catalog spec 190-340, service spec 274/289 | Filter is a `computed` from `queryParamMap`; controls only navigate; effect loads per distinct filter; loadMore passes full filter with held offset; a stale success and a stale failure are both dropped | PASS |
| 3.3 | catalog html empty/error blocks; spec + e2e | `isEmpty` -> "Нічого не знайдено"/"Скинути фільтри"; `hasError` -> retry calls `reload()` | PASS |
| 3.4 | `scenario.component.ts/html`; spec; e2e | meta rows built only when value exists (version, author, size, updated, ID); features/related/download blocks absent when empty; 404 -> not-found, other -> error + retry; title set and restored on destroy | PASS |
| 3.5 | `copyLink`, `pageUrl`; spec + e2e | `navigator.clipboard?.writeText` missing or rejecting -> `manualLink` input, selected after render; success -> toast. Absolute URL via `createUrlTree` + `new URL(.., location.origin)` (id is encoded). Download `href = scenarioUrl`. | PASS |
| 3.6 | grep: no `theme`/`localStorage` theme key in src; card `open` -> `/scenario/:id`, `launch` -> `/play/:id` | No modal/theme code left | PASS |
| 3.7 | e2e `390 x 844` tests; `.chips{overflow-x:auto}`, `.launch-bar` sticky at `<= $narrow` | e2e checks `scrollWidth <= innerWidth`, chip row scrolls, bar stays inside viewport at 3 scroll offsets | PASS |
| 3.8 | `admin.component.ts` (`MAX_FEATURES=6`, add/remove/update, cleanFeatures), html editor; `admin.component.spec.ts` (9 tests) | Icon picker = `ICON_NAMES`; 7th refused; server 400 message surfaced via `AdminService` error mapping | PASS |
| 3.9 | e2e `DW-3.9` HAR-style test | passed in the run | PASS |
| 3.10 | specs + e2e updated | Unit green; e2e **not fully green**: 1 failure (Issue 1) | PARTIAL |

Edge cases: clipboard missing/rejected (PASS), stale response (PASS), `encodeURIComponent` on `/api/catalog/:id` and the page URL (PASS), unknown/unpublished id -> not-found (PASS, 404 mapped), 5xx -> error with retry (PASS).

Coverage level 100%: new/changed routines in Phase 3 files are exercised (lcov). The only unexecuted template listeners in new files are the sort "За назвою" radio `(change)` handler (the `setSort` method is covered) and the related-thumbnail `(error)` handler (`imageFailed` is covered). Judged covered at routine level.

## Correctness Dimensions (both phases)
| Dimension | Status | Evidence |
|---|---|---|
| Concurrency | PASS | Request ticket in `ScenarioService`/`ScenarioComponent.load`; traced: older response (success or failure) returns before touching state; `loadMore` skipped while loading |
| Error Handling | PASS | Catalog/scenario/config failures surface (error state, console, null limit); no empty catch except clipboard fallback, which is the specified behaviour |
| Resources | PASS | Toast timer cleared on destroy; catalog search timer cleared in `ngOnDestroy`; page title restored on destroy |
| Boundaries | PASS | `q` capped at 100 chars, junk sort/category falls back; `formatBytes` null/NaN/negative -> `''`; empty features/related arrays |
| Security | PASS | No innerHTML/bypassSecurityTrust; icon names via `Object.hasOwn`; URL query parsed defensively; ids encoded |

## Loaded-Skill Criteria
| Skill | Criterion | Status | Evidence |
|---|---|---|---|
| aposd-verifying-correctness | Requirements coverage RC-1..4 | PASS except DW-2.6/3.10 execution | tables above |
| aposd-verifying-correctness | Concurrency, errors, resources, boundaries, security | PASS | see dimensions |
| cc-defensive-programming | External input validated at entry (URL query, `/api/config`, `/api/catalog` shape) | PASS | `parseCatalogQuery`, `PlatformConfigService.fetch` validates number, `fetchScenarioById` defaults arrays |
| cc-defensive-programming | No empty catch / side-effecting asserts | PASS | clipboard catch sets fallback state |
| aposd-designing-deep-modules | Interface depth / information hiding | PASS | `ScenarioService` hides paging/ticket/filter; `<vl-icon>` hides path data; small interfaces. Note: `categories()` hides the "all" chip. |
| cc-refactoring-guidance | Behavior-preserving changes (legacy scope) pinned by characterization | PARTIAL | characterization test exists but is racy (Issue 1) |

## Notes (non-blocking)
- `catalog.component.ts launchScenario` sends a scenario without `scenarioUrl` to its page instead of `/play`: sensible, goes slightly beyond the DW text.
- Admin icon `<select>` for a stored icon not in `ICON_NAMES`: no option is selected, so the UI shows the first icon while the saved value is unchanged until edited.
- `html, body { overflow-x: hidden }` (`_base.scss`) can hide a real sideways overflow; the e2e check compares `scrollWidth`, which is still meaningful for the element's own layout.
- Sort "За назвою" radio change listener and related-thumbnail error listener are not triggered through the DOM in unit tests.
- No cross-phase interface misuse found: Phase 3 uses `ICON_NAMES`, `vl-site-header` slots, `vl-scenario-card` outputs, `ToastService`, `formatBytes/formatDate/pluralUk`, `PlatformConfigService` as Phase 2 exposes them; viewer still compiles against `fetchScenarioById` -> `ScenarioDetail`; `_legacy.scss` correctly dropped `app-catalog` while keeping `app-admin, app-viewer`. API contract (`/api/catalog`, `/:id`, `/api/config`) used as documented.

## Issues
1. Failing e2e test in the full run (flake in the DW-2.6 characterization)
   - File: `e2e/tests/nocturne-foundation.spec.ts:61-64` (`snapshotAdmin`), asserted at line 155.
   - Demonstrated by: full `npm test` -> `DW-2.6 the old /admin keeps its computed look...` failed with `.toolbar .btn-primary` backgroundColor `rgb(102,105,241)` vs baseline `rgb(99,102,241)`; passes 3/3 alone. The old admin button has `transition: background .15s`; the snapshot is taken immediately after clicking it while hovered.
   - Fix: move the pointer away (`page.mouse.move(0,0)`) and/or wait for the transition (or `animations: 'disabled'` / emulate `prefers-reduced-motion` plus a settle) before `collect` of `LIST`; or measure `.toolbar .btn-primary` before clicking it.

**Verdict: FAIL** - one blocker: a test failed when run (e2e DW-2.6 admin characterization, timing flake). Phase 2 and Phase 3 implementation is otherwise correct: all other DW items, listed edge cases and coverage requirements are met. Phase 3 is blocked only through DW-3.10 ("all suites green").
