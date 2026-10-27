# Questions for WebEngineTS

Found while wiring the streaming path, verifying KTX2 and adding a Content Security Policy.

Answered by the engine on 2026-08-20 — write-up in `WebEngineTS/design/upstream-answers.md`,
changelog in `WebEngineTS/CHANGELOG.md`. **One item is still open and needs a measurement from
this repository.**

---

## Open

### 1. The streamed path holds ~2.9× the texture VRAM of the ZIP path

**Not reproduced from the engine side, and the engine has added the instrument to find out why.**

The same scenario (`solar-system`), same textures, run twice in the same browser:

| | ZIP | manifest |
|---|---|---|
| live textures (`renderer.textures`) | 19 | 19 |
| `estimatedTextureVramBytes` | **92.8 MB** | **269.8 MB** |
| draw calls, settled | 25–27 | 25–27 |

The engine tested the part it owns: the same files, under the same paths, with the same decoder,
loaded through a plain source and through a `StreamingAssetSource`. Cache entries and estimated
VRAM come out **identical**, and loading one path twice retains one texture rather than two. That
is pinned by `WebEngineTS/tests/SourceVramParity.test.ts`.

So the difference is not in `Resources` plus a source. It is above them — how the scenario asks
for its textures on each path, or an object one path retains and the other does not.

#### What to do next, here

`MemoryReport.renderer` now carries **`liveTextures`** alongside `textures`. The two count
deliberately different sets: engine texture objects, uploaded or not, versus GPU uploads. Re-run
`e2e/tests/streaming.spec.ts` printing both, and the answer is one comparison:

- **`liveTextures` differs, `textures` matches** → the streamed path really is retaining more
  texture objects, and they are ones nothing has drawn. That is a leak, and the count localises
  it. Send the two figures upstream; that is enough to act on.
- **Both match** → the same textures are estimated at different sizes. Then check
  `textureFormats` for a format difference; what remains is dimensions.

Until then this platform's choice stands: do **not** default to the manifest path — see
[`../PLAN.md`](../PLAN.md#progress).

### 6. `Time.timeScale` survives `Application.dispose()` and the next scenario load (G5)

Found against `0.1.0-local.1792706134341`; shared-index row **G5** in `../../../.claude-shared/ENGINE-GAPS.md`.

`Time` is a static class. Its `timeScale` setter (`WebEngineTS/src/engine/core/Time.ts:201`) writes
a static, and the only routine that puts it back to `1.0` is `Time._reset()`
(`WebEngineTS/src/engine/core/Time.ts:280`, `@internal`, "Useful for testing or scene reloads").
**Nothing calls it**: `grep -rn "Time\._reset" WebEngineTS/src` finds no caller outside the method's
own definition, whereas the sibling statics (`Profiler._reset()`, `AudioManager._reset()`) are called
from `Application`. So a scenario that pauses or slows time (`Time.timeScale = 0`) leaves that scale
behind through `dispose()` and the next `loadScenarioFrom*` in the same page — the next scenario
starts frozen or slowed.

**What is affected:** any host that runs more than one scenario per page load. This platform's viewer
is a single-page app: leaving `/play/a` and opening `/play/b` reuses the same JS realm and the same
`Time` statics.

**What the platform does about it:** nothing page-side, on purpose. As of release 1 phase 4 the viewer
carries no `Time.timeScale` write and no reset — pause, FPS and the scale reset were deliberately not
built in the page. The platform's fix is **a fresh player frame per run** (the isolated player,
`WebEngineTS/player-host`, plan `2026-10-24-player-isolation.md` phase 5): every scenario then starts in
a new JS realm with a new `Time`, so the scale cannot leak, whatever the engine does. Until that ships,
a scale set by one scenario can carry into the next one opened in the same tab.

**What is asked of the engine (optional, it does not block the platform):** call `Time._reset()` from
`Application.dispose()` (or at the start of a scenario load), so a host that reuses the page is also safe.

---

## Closed

### 2. The basis transcoder needs `'unsafe-eval'` — **not the engine's to fix**

The engine ships no transcoder. There is no copy in that repository and the build does not vendor
one: `Texture2D.ktx2TranscoderPath` is a URL **this platform** serves, and the file comes from
`three/examples/jsm/libs/basis/`. So `-s DYNAMIC_EXECUTION=0` is a request to make to three.js,
not a change the engine can apply.

*Superseded by player isolation:* the page's CSP (`nginx/csp.conf`) still has no `'unsafe-eval'`, but KTX2
now transcodes inside the sandboxed player frame, whose own CSP (the engine's `player.nginx.conf`) grants it;
`e2e/tests/ktx2-render.spec.ts` pins that. What follows is the decision as it stood before.

What did change is that the condition is now **detectable rather than silent**:
`MemoryReport.renderer.textureFormats` reports `RGBA8` for a KTX2 asset that failed to transcode,
instead of the failure being visible only as an unexpected VRAM figure. Worth asserting in the E2E
suite so a future policy change that breaks transcoding is caught.

### 3. Asset URLs are joined onto the manifest directory — **fixed**

`StreamingAssetSource._resolveUrl` resolves with `new URL(url, base)`, making a root-relative base
absolute against the document first. Both `objects/ab/cd.bin` and `/store/objects/ab/cd.bin` work.
The `/a/manifests//a/objects/…` 404 is named in the code comment so it is not re-introduced.

`loadScenarioFromManifest` now documents this, including that `baseUrl` replaces what asset URLs
resolve against. The deployment constraint that cost a round of debugging is gone.

### 4a. A scenario could open the overlay on a student — **fixed**

`MemoryProfiler.diagnosticsAllowed` is a host-level policy scenario code cannot get past. While it
is `false`, `showOverlay`, `toggleOverlay` and `enableToggle` are inert and an overlay already on
screen is taken down. `snapshot()` still works — it puts nothing on screen, and a host may want
the numbers without the panel.

```ts
// Platform startup, before any scenario is loaded:
MemoryProfiler.diagnosticsAllowed = new URLSearchParams(location.search).has("diag");
```

**Done here:** the close-after-load workaround is gone. The host sends `diag: false` to the player and the
latch (one-way since the player-isolation work) holds it. The E2E test stays.

### 4b. The report could not say what a texture was transcoded to — **fixed**

`MemoryReport.renderer.textureFormats` tallies live textures by the GPU format they actually ended
up in: `{ BC7: 3, ETC2: 8, RGBA8: 1 }`. The transcoder picks its target from what the device
supports, so the same asset reads `BC7` on a desktop and `ASTC 4x4` or `ETC2` on a phone.

### 5. Small notes — **all addressed**

- **Scenario scripts execute from `blob:` URLs.** Now stated on all three `loadScenarioFrom*`
  entry points, including that without `script-src blob:` no scenario runs at all and the failure
  is total.
- **`Application.version` was a fixed literal.** Fixed — it reads `BuildInfo.version` and carries
  the real stamp.
- **The `IEngineBuildInfo` comment sent us to the wrong field.** Already corrected upstream: it
  names `0.1.0-local.<timestamp>` and says to check `version` first, since that is the one a
  consumer's lockfile also records.

---

## How to use this file

Newest question first under **Open**, with what was observed, why it is not the obvious
explanations, why it matters, and what is being asked. Move an item to **Closed** with how it
landed — including "not ours to fix", which is an answer and stops the question being re-asked.

Re-verify against a current engine build before adding anything: of the nine items originally on
this list and its siblings, six were already fixed by the time they were re-checked.
