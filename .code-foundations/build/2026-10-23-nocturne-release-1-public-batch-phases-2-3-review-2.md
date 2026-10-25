# Review: Batch Phases 2-3 (commits a1433b0, d800252, 5e73278)

## Executed Results (Step 0)
- Frontend unit: `npx ng test --no-watch` -> 17 files, 226 tests passed, 0 failed.
- Typecheck/build: `npm run build` -> exit 0.
- Icon idempotence: `npm run icons:check` -> exit 0 (no diff).
- e2e: `npm test` against the running stack -> 48 passed, 8 skipped, 0 failed. The skips are ktx2 transcode and streaming specs, outside both phases' DW items.
- Independent design-file check: a script I wrote compared every rule and token in `part01.style.txt` and `part03.style.txt` with the whitespace-collapsed `_tokens/_base/_components/_animations.scss`. 99 rules, 1 non-literal match: `*{box-sizing:border-box}` is present as the superset `*, *::before, *::after {...}`. No light-theme or `prefers-color-scheme` rule found. `nginx/` has no diff against 8940004.

# Phase 2: Nocturne foundation

| DW | Evidence | Verdict |
|---|---|---|
| 2.1 | `_tokens.scss` (`--color-bg: #161826`), `_base.scss`, `_components.scss`; `nocturne-styles.spec.ts` DW-2.1 (tokens, rules, classes, keyframes, no light theme). My independent diff against the design file also matches. | PASS |
| 2.2 | `_fonts.scss` (six faces, `/assets/fonts/`); spec DW-2.2 (files exist); e2e nocturne-foundation DW-2.2 (off-origin none) and csp.spec all ok. | PASS |
| 2.3 | `icon.component.ts` (`<svg><path [attr.d]>`, `Object.hasOwn` guard, folder fallback); `build-icons.mjs` `parsePaths` throws on non-path content; `icon.component.spec` DW-2.3 and `icon-generator.spec` DW-2.3; `icons:check` exit 0. No `innerHTML` or `bypassSecurityTrust` in non-spec code (grep). | PASS |
| 2.4 | `scenario-card.component.ts`: `onLaunch` calls `stopPropagation`, then emits `launch`; the article click emits `open`. Specs DW-2.4 for the card, toast, header and footer. | PASS |
| 2.5 | `format.ts`; `format.spec` DW-2.5 covers 50537267 -> `48,2 МБ`, the ISO date -> `12 бер 2026`, and plurals for 1/2/5/11/21. | PASS |
| 2.6 | `_legacy.scss` `:where()` scope; e2e DW-2.6 admin and viewer characterisations ok (5e73278 de-flake in place); the full frontend suite is green. | PASS |

Edge cases:
- Unknown icon name: handled, with a spec.
- No-image or failing image: the gradient is shown, with specs.
- Plurals for 1/2/5/11/21: tested.
- `null` bytes: `formatBytes` returns `''`.
- Long titles: `line-clamp: 2` in the card scss, plus a spec for a 200-character title.

All requirements met: YES.

# Phase 3: Catalog and scenario page

| DW | Evidence | Verdict |
|---|---|---|
| 3.1 | `catalog.component.html/ts` (header label, hero from `site.config` and `summary`, sort segment, chips in API order, `foundLabel`, footer limit). Specs DW-3.1 and e2e DW-3.1 ok. | PASS |
| 3.2 | `catalog-query.ts` and the URL-driven `filter` computed. `scenario.service.ts` `latestRequest` ticket drops stale successes, stale failures and stale appends. Specs DW-3.2 (stale, Back, load more) and e2e DW-3.2 ok. | PASS |
| 3.3 | `isEmpty` and `hasError` states with `resetFilters` and `reload`. Specs and e2e DW-3.3 ok. | PASS |
| 3.4 | `scenario.component.ts/html`: meta rows filtered by presence, blocks hidden when empty, `status` not-found (404) vs error (the rest), `Title` set. `fetchScenarioById` uses `encodeURIComponent`. Specs and e2e DW-3.4 ok. | PASS |
| 3.5 | `copyLink` catches a missing or rejected clipboard and sets `manualLink`; the download href is `scenarioUrl`. Specs and e2e DW-3.5 ok, including the no-Clipboard-API case. | PASS |
| 3.6 | Modal gone; spec and e2e DW-3.6 check no dialog, no toggle and no `theme` key (grep of non-spec source for `theme`: none). Card -> `/scenario/:id`, launch -> `/play/:id`. | PASS |
| 3.7 | e2e DW-3.7 at 390x844: no horizontal scroll, chips overflow-scroll, sticky `.launch-bar`. | PASS |
| 3.8 | admin `addFeature`/`removeFeature`/`updateFeature` with a cap of 6; the icon select is fed from `ICON_NAMES`; the server's 400 message is shown. Admin spec and e2e DW-3.8 ok. | PASS |
| 3.9 | e2e DW-3.9 records every request origin on the catalog and scenario page and expects none off-origin. This is a request listener rather than a literal HAR, with the same effect. | PASS |
| 3.10 | The unit specs and e2e files listed in the DW exist and are green (226 unit, 48 e2e). | PASS |

Edge cases (all handled, each with a test):
- Clipboard missing or rejected: the link is shown selectable.
- Stale response for an older filter: dropped.
- `encodeURIComponent` on the API request and on the related links (a router array, so encoded by the router).
- Unknown or unpublished id: not-found state.
- 5xx and network failure (status 0): error state with retry.

All requirements met: YES.

## Test-DW Coverage
- [x] Every DW item has a named test that ran in Step 0.
- [x] 100% level: I found no new or changed routine without a unit test. `site-logo.component.ts` has no spec of its own but is exercised through the header spec ("logo comes from site.config.ts"), the footer spec and the card specs. `build-icons.mjs` routines are covered by `icon-generator.spec`. Gaps: none.

## Dead Code
None found (no unreachable code or debug statements in the reviewed files).

## Correctness Dimensions
| Dimension | Status | Evidence |
|---|---|---|
| Concurrency | PASS | Catalog and scenario page both use a request ticket. I traced a slow response for filter A arriving after filter B: dropped, and its `finally` does not clear `loading`. `PlatformConfigService.load` assigns `pending` before its failure handler resets it, so a failure is retryable. |
| Error Handling | PASS | The service's `catch` logs and surfaces `CATALOG_ERROR`. The scenario page separates 404 from the rest. The clipboard `catch` is a deliberate fallback that sets observable state. |
| Resources | PASS | The search debounce timer is cleared in `ngOnDestroy`. The toast timer is cleared on destroy. The document title is restored on destroy. |
| Boundaries | PASS | `formatBytes` handles null, NaN and negative values and the 1023,999 КБ rounding; `formatDate` returns `''` for an invalid date; the URL query is trimmed and capped at 100 characters; empty lists hide their blocks. |
| Security | PASS | Icons render through `[attr.d]` from generated data only. Ids are encoded. A `?q=` value goes through `HttpParams`. Interpolated text is Angular-escaped. |

## Loaded-Skill Criteria
| Skill | Criterion | Status | Evidence |
|---|---|---|---|
| aposd-verifying-correctness | Requirements coverage (RC-1..4) | PASS | Every DW mapped to code and a test above; no unrequested code found. |
| aposd-verifying-correctness | Concurrency, errors, resources, boundaries, security | PASS | See the dimension table. |
| cc-defensive-programming | External input validated at entry (`/api/config`, the catalog manifest, URL query, icon names) | PASS | `PlatformConfigService` checks the type and finiteness of `maxArchiveBytes`. `parseCatalogQuery` is total. `fetchScenarioById` defaults `features` and `related` to arrays. `IconComponent` guards the unknown name with `Object.hasOwn`. |
| cc-defensive-programming | No empty catch, no side-effecting assertions | PASS | The `catch {}` in `copyLink` and in the `KYIV_PARTS` Intl fallback each set state or fall back. There are no assertions. |
| aposd-designing-deep-modules | Depth, information hiding, silent failure | PASS | `ScenarioService` hides tickets and paging behind `loadCatalog`/`loadMore`. `categoryGradient` is total. The failure paths are observable (the `error` signal, `manualLink`, console). |
| cc-refactoring-guidance | Fix and refactor not mixed; small changes reviewed | N/A | Feature commits plus one fix commit (5e73278, test-only de-flake). Nothing here is refactoring-only, so nothing to demonstrate. |

## Cross-Phase Coherence
- Phase 3 consumes the Phase 2 interfaces as they actually exist: `vl-site-header` slots and `brand` input, `vl-site-footer [maxArchiveBytes]`, `vl-scenario-card` `(open)`/`(launch)`, `ToastService`/`<vl-toast-host>` (mounted in `app.component`), `ICON_NAMES` in the admin picker, `pluralUk`/`formatDate`/`formatBytes`, `categoryGradient`.
- Phase 3 removed `app-catalog` from `_legacy.scss` and updated the legacy-scope spec. `nocturne-foundation.spec` DW-2.6 still passes.
- The viewer still compiles against `ScenarioDetail` (build exit 0) and the viewer e2e specs pass.
- The Phase 2 specs were touched in d800252 only by a `Covers test-plan` header line, with no behaviour change.
- The `/api/catalog`, `/api/catalog/:id` and `/api/config` consumption matches the documented contract. I found no misuse.
- No contradictions between the phases.

## Notes (non-blocking)
- Admin feature-icon `<select>`: a stored icon name that is not in `ICON_NAMES` would display as the first option while the draft keeps the old value. This is undemonstrated and unlikely, since the server only stores names the editor offers. Low severity, medium confidence.
- DW-3.9 is verified through a Playwright request listener rather than a literal HAR file. The behaviour is equivalent.
- `npm run build` rewrote `frontend/dist/`, which is build output, not a source change.
- The 8 skipped e2e tests (ktx2 transcode, streaming) are environment-gated and pre-existing, and are not tied to any DW item here.

## Issues (if FAIL)
None.

**Verdict: PASS**

Phase 2: PASS - clean
Phase 3: PASS - clean
