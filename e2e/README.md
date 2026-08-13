# Browser tests (Playwright)

The layer the 218 unit tests cannot reach: a rendered frame, a focus trap, a lost
WebGL context, a progress ring that actually moves. `docs/test-plan.md` §7 is the
list of things that used to be verifiable only by hand, and this suite is what
replaced that list.

## Running

The stack must be up **and** have a catalog — the tests open real scenarios.

```bash
docker compose up -d                     # from the repo root
cd backend && npm run publish:release    # fill the catalog from a ScenarioCreator release
cd backend && npm run import:assets      # optional: per-asset store, for streaming.spec.ts
cd ../e2e && npm ci && npx playwright install chromium

set -a && . ../.env && set +a            # ADMIN_TOKEN, used by the admin path
npm test                                 # ~4.5 min
npm run test:headed                      # watch it happen
npx playwright test viewer               # one file
```

`global-setup.ts` checks all of this before a browser starts and says which part
is missing, rather than letting the first test time out on a blank page.

## Why it is not a per-PR CI gate

These tests need scenarios, and scenario content lives in **ScenarioCreator** —
this repo deliberately stores none. A CI runner therefore has nothing to publish.
The alternative, committing a fixture archive here, is exactly the rule the repo
exists to keep, so the suite runs as a **pre-release gate** instead: the `e2e` job
in `ci.yml` is `workflow_dispatch` with a release directory supplied to it.

## What the tests assume

- **Chromium only.** Headless Chromium reaches WebGL2 through ANGLE + SwiftShader
  and reports ASTC, ETC and S3TC, so KTX2 transcoding has a real target format
  here. That was verified before the suite was written — without it, every viewer
  assertion would silently be testing the fallback path.
- **Serial, one worker.** The admin path mutates the shared catalog, and parallel
  WebGL contexts contend for the software rasteriser.
- **Anything created is prefixed `e2e-`** and deleted afterwards; a leaked row is
  greppable, and `cleanupE2EScenarios()` removes leftovers from an interrupted run.
- **Bench scenes are unpublished by policy.** `ktx2.spec.ts` publishes
  `benchscene3-solarsystem` for its own duration and restores it after.
- **`streaming.spec.ts` skips** unless the per-asset store is populated, since that store is
  filled by a separate command from the catalog.
- **Timings here do not support performance claims.** SwiftShader put a 30% spread across runs of
  an identical pair, which is larger than the effects worth measuring. The specs assert
  equivalence and loose bounds; a latency number needs a real GPU.

## Reading the engine from a test

`helpers/engine.ts` does `await import('WebEngineTS')` inside the page. The import
map in `index.html` applies to dynamic imports too, so a test holds the very same
module instance the app is using — no test hook in production code, nothing hung
off `window`.

That is what makes "did it render?" a direct question (`renderStats.drawCalls`)
rather than a screenshot diff, which under SwiftShader would be slow and flaky.
