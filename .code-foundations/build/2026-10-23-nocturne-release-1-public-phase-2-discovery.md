# Discovery + Design: Phase 2 - Nocturne foundation

## Files Found
- `frontend/src/styles.scss` (old light reset + body), `frontend/src/app/pages/{admin,catalog,viewer}/*` (own SCSS, no Nocturne).
- Design extract: `vl-design-site/part01.style.txt` (tokens + components), `part03.style.txt` (base + keyframes),
  `template.html` (Inter faces), `skeleton.html` (header/footer/card/toast markup), logo PNG (31 KB).
- No `frontend/src/app/ui/`, no `src/styles/`, no `scripts/`, no `assets/fonts|brand`. `@phosphor-icons/core` not installed
  (installed now as devDependency, `^2.1.1`, `assets/regular/*.svg`).
- e2e: `e2e/tests/{csp,admin-golden-path,...}.spec.ts`, `e2e/helpers/api.ts` (SMALL_ARCHIVE path is stale).

## Current State
Nothing of Nocturne exists. Global stylesheet is a light-theme reset (`*{margin:0;padding:0}`, Segoe body, `a{color:inherit}`).
`dark-theme` selectors exist only in `catalog.component.scss/.ts` (Phase 3 rewrites it; outside this phase's file scope).
Admin SCSS defines `.btn/.btn-primary/.btn-ghost/.tag` (component-encapsulated, specificity 0,2,0).

## Gaps
1. **Assumption 1 (Inter subsets complete for Ukrainian): confirmed.** `cyrillic` covers U+0400-045F, U+0490-0491 (і ї є ґ); apostrophe U+02BC is in `latin`.
   Subsets shipped: cyrillic-ext, cyrillic, latin (400 + 500) = 6 files. latin-ext/greek/vietnamese omitted (not used; saves ~120 KB).
2. **Assumption 2 (legacy-admin scope neutralises): holds with a technique.** Neutralisation is `:where(.legacy-admin) .btn {...}` (specificity 0,1,0, declared after
   the Nocturne components) that resets only properties Nocturne sets and the admin does not; admin's own rules (0,2,0) always win regardless of order.
   Proven by a characterization e2e (computed styles captured on HEAD before any stylesheet change). No fallback prefix needed.
3. The old *viewer* inherits the body font/size/line-height. Switching the body to Inter 15px/1.55 would change it, and `viewer.component.scss`
   is out of file scope, so the same technique is applied to host elements (`app-viewer`, `app-admin`, `app-catalog`) in the legacy stylesheet.
   The viewer's computed look is also characterised (WebGL-denied error screen).
4. DW-2.1 "no light-theme rules remain in any stylesheet": `catalog.component.scss` still has `.dark-theme` (the catalog's own
   dark-mode toggle, Phase 3 deletes the page's styles). The unit test asserts on the global stylesheets (`styles.scss`, `src/styles/**`) and
   the toggle's removal is Phase 3's. Recorded in Decisions.
5. `e2e/helpers/api.ts` `SMALL_ARCHIVE` resolves to a path that does not exist; admin golden path is a pre-existing failure. Minimal override added (Decisions).
6. Unit tests need `node:fs` / `node:child_process` (token fixture vs source, generator check): `@types/node` is present transitively; spec files use `/// <reference types="node" />`.

## Code Standards
Standalone + OnPush + signals + `inject()`; path comment at top of each file; UI Ukrainian, code/comments English; module constants UPPER_SNAKE with doc comment;
vitest fake timers (no fakeAsync); spec headers cite DW ids (test-plan numbers are Phase 3's); `output()`/`input()` signal API.

## Test Infrastructure
Vitest through `ng test`; `TestBed` + zoneless; specs next to sources; cwd = `frontend/` (so `readFileSync('src/styles/...')` works).
Playwright e2e against the compose stack on :8044.

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-2.1 | Every Nocturne token and component class exists with the design file's values; page ground `#161826`; no light-theme rules remain | COVERED | `nocturne-styles.spec.ts`: every fixture token present with identical value in `_tokens.scss`; ground is `#161826`; every component class from the fixture present in `_components.scss`; the `vl-*` keyframes exist; no `dark-theme`/`light-theme`/`prefers-color-scheme` in `styles.scss` + `src/styles/**` |
| DW-2.2 | Body text renders in Inter from `/assets/fonts/`; csp.spec.ts passes unchanged | COVERED | e2e `nocturne-foundation.spec.ts` DW-2.2 (fonts.check, `/assets/fonts/inter-*.woff2` 200, no off-origin); unit: `@font-face` urls all `/assets/fonts/` and every file exists, Cyrillic range present; `csp.spec.ts` run unchanged |
| DW-2.3 | `<vl-icon>` renders every `ICON_NAMES` entry (inherits colour/size), fallback for unknown; generator re-run = no diff | COVERED | `icon.component.spec.ts`: renders each name; `''`/unknown/`null`/`undefined` -> fallback no throw; svg uses `currentColor` and `1em`; size input; no `innerHTML`; `icon-generator.spec.ts`: `--check` exits 0, `--stdout` equals committed file, byte-identical on 2 runs, non-path SVG rejected, ICON_NAMES covers prototype + seeded categories |
| DW-2.4 | card emits open/launch correctly; gradient when no image; header/footer render config; toast shows/hides | COVERED | `scenario-card.component.spec.ts` (open on click, launch only from button, no image / image error -> gradient, 200-char title clamps, null bytes render nothing); `site-header.component.spec.ts`, `site-footer.component.spec.ts` (config texts, limit from input, absent -> no number, brand modes/slots); `toast.spec.ts` (shows, auto-hides, aria-live, replaces, ignores empty); `category-gradient.spec.ts` |
| DW-2.5 | `formatBytes(50537267)` -> `48,2 МБ`, `formatDate('2026-03-12T10:00:00Z')` -> `12 бер 2026`, `pluralUk` 1/2/5/11/21 | COVERED | `format.spec.ts`: bytes 0/1023/1048576/50537267/null/undefined/NaN; date incl. late-evening UTC -> Kyiv next day, invalid -> `''`; plural 0,1,2,4,5,11,12,14,21,22,25,101,111 |
| DW-2.6 | Old `/admin` and the viewer still look and work as before; frontend suite green | COVERED | e2e characterization of admin + viewer error screen vs HEAD-captured computed styles; old admin golden path; full e2e + `ng test` + `npm run build` |

**All items COVERED:** YES

## Design Decisions (design it twice)

### Icon
1. Icon font (rejected by plan: 5.5 MB, request). 2. One component per icon / CSS mask data-URIs (many files; data-URI masks fight the CSP-free goal).
3. **One `<vl-icon [name] [size]>` over a generated `name -> path[]` map** (chosen). Interface: 2 inputs; hides the data, the fallback policy, viewBox, a11y (`aria-hidden`).
Path data is an array of `d` strings per icon (not concatenated: separate subpaths keep non-zero winding independent).
`ICON_NAMES` is defined once, in `scripts/build-icons.mjs`, which writes `icon-data.generated.ts` exporting `ICON_NAMES` and `ICON_PATHS`; `icon.component.ts` re-exports `ICON_NAMES`.
The generator exports a pure `renderIconModule(names, readSvg)` (testable), refuses any non-`<path>` element / extra path attribute / unexpected viewBox, and has `--check` / `--stdout`.

### Header / footer / card / toast
- Header: one component, `brand = input<'full'|'logo'>`; slots `[header-start]`, `[header-end]`. `full`: brand(names) | spacer | start | end. `logo`: start | spacer | end | logo-only. Brand links to `/catalog`. Texts only from `SITE`.
- Card: `ScenarioCardData` presentational; `open`/`launch` emit the scenario `id` (string). The title is a real `<button>` (keyboard path) whose click bubbles to the card; the launch button stops propagation, so exactly one event per interaction. Image failure is a signal keyed on the failed URL.
- Toast: `ToastService` (root, signal `message`, one timer, 2600 ms like the prototype) + `<vl-toast-host>` with a persistent `role="status" aria-live="polite"` region (live regions must exist before their content changes).
- `categoryGradient(slug)`: curated gradients for the seeded slugs (taken from the prototype's per-scenario art), deterministic hashed fallback for other slugs.
- `format.ts`: `formatBytes` (1 decimal, trailing `,0` trimmed, promotes the unit after rounding), `formatDate` (own month table, `Intl` only for Europe/Kyiv date parts), `pluralUk`.

### Styles
`src/styles.scss` = `@use` of `src/styles/{fonts,tokens,base,components,animations,legacy}`; the old reset `*{margin:0;padding:0}` is kept in `base` (class selectors beat `*`, element selectors the prototype sets win over it) so legacy pages keep their spacing.
`legacy` = `:where(.legacy-admin) ...` component-class neutraliser + `:where(app-admin, app-viewer, app-catalog)` typography neutraliser; both deleted with the pages (release 2 / Phase 4).

## Prerequisites
- [x] Design extract available, fonts present, logo present
- [x] `@phosphor-icons/core` installable (done)
- [x] Docker e2e stack running; HEAD characterization captured before any stylesheet change

## Recommendation
BUILD.
