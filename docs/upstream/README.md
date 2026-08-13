# Questions for the other repositories

Findings from this repo that **belong to someone else's code**, written down here because they
were discovered here and would otherwise be lost in a commit message.

| File | Repo | Open items |
|---|---|---|
| [`webenginets.md`](webenginets.md) | `WebEngineTS` — the 3D engine | 5 |
| [`scenariocreator.md`](scenariocreator.md) | `ScenarioCreator` — the build pipeline | 4 |

## How these are written

Each item states **what was observed**, **how to reproduce it**, **why it matters here**, and
**what is actually being asked**. Where this repo has already worked around something, that is
said too, so nobody fixes the same thing twice — and so the workaround can be removed if the
underlying issue is fixed.

Measurements were taken against:

- engine `0.1.0-local.1786569427449` (built 2026-08-12 21:17 UTC)
- the ScenarioCreator release in `ReleaseScenarios/` as of 2026-08-13
- headless Chromium via Playwright, WebGL2 through ANGLE + SwiftShader

**SwiftShader matters for the timing numbers and not for the rest.** Anything below quoting
milliseconds is soft; counts, byte sizes and pass/fail behaviour are not.

## Nothing here is a bug report against this platform

The platform-side halves are done and recorded in [`../PLAN.md`](../PLAN.md#progress). These are
the parts this repo cannot fix, either because the code lives elsewhere or because the answer is a
design decision that is not ours to make.
