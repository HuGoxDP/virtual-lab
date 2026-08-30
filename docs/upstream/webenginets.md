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

---

## Closed

### 2. The basis transcoder needs `'unsafe-eval'` — **not the engine's to fix**

The engine ships no transcoder. There is no copy in that repository and the build does not vendor
one: `Texture2D.ktx2TranscoderPath` is a URL **this platform** serves, and the file comes from
`three/examples/jsm/libs/basis/`. So `-s DYNAMIC_EXECUTION=0` is a request to make to three.js,
not a change the engine can apply.

The decision here does not change: keep the CSP (`nginx/csp.conf`), accept that KTX2 does not
transcode.

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

**Action for this repo:** the viewer's close-after-load workaround can be replaced by this. Keep
the E2E test — it now guards a guarantee instead of a race.

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
