# Questions for WebEngineTS

Found while wiring the streaming path, verifying KTX2 and adding a Content Security Policy in the
Virtual Lab platform. Measured against engine **`0.1.0-local.1786569427449`** (built
2026-08-12 21:17 UTC).

Ordered by how much they cost the consumer, not by difficulty.

---

## 1. The streamed path holds ~2.9× the texture VRAM of the ZIP path

**The one I would most like an answer to.**

### Observed

The same scenario (`solar-system`), same textures, run twice in the same browser — once via
`loadScenarioFromBuffer` (ZIP), once via `loadScenarioFromManifest`:

| | ZIP | manifest |
|---|---|---|
| live textures (`renderer.textures`) | 19 | 19 |
| `estimatedTextureVramBytes` | **92.8 MB** | **269.8 MB** |
| draw calls, settled | 25–27 | 25–27 |

Reproducible on every run; the two numbers were identical to the byte across four separate runs.

### Why it is not the obvious explanations

- **Not a retained LOD ladder.** Every asset in `solar-system.scenario.json` has exactly one LOD
  (`lods.length === 1` for all 18).
- **Not more textures.** The count matches exactly, 19 either way.
- **Not measured too early.** The sampler waits for `renderer.textures` *and*
  `estimatedTextureVramBytes` to stop changing for six seconds before reading.
- **Not different source files.** Both paths ultimately carry the same 12 JPEG textures.

### Why it matters

It is the opposite of what a VRAM budget assumes. `Resources.vramBudgetBytes` and
`TextureStreaming` exist to keep texture memory inside a limit, and the delivery mechanism that is
meant to enable them appears to cost three times more of exactly the resource being budgeted.

It is also why this platform does **not** default to the manifest path — see
[`../PLAN.md`](../PLAN.md#progress). Students would pay ~180 MB of extra texture memory for a
first-frame win that is not currently demonstrable.

### Asked

Is this expected? If it is an artefact of how `StreamingAssetSource` decodes or retains images,
is it something the engine can drop after upload? If `estimatedTextureVramBytes` merely *counts*
differently on the two paths and the real GPU cost is the same, that is just as good an answer —
but then the profiler is misleading, which matters for anyone using it to size a budget.

**Repro:** `e2e/tests/streaming.spec.ts`, test "an asset-heavy scenario renders the same scene from
a manifest as from its ZIP" — it prints both figures on every run.

---

## 2. The basis transcoder needs `'unsafe-eval'`, which blocks a strict CSP

### Observed

Loading `/assets/basis/basis_transcoder.js` and instantiating it under three policies:

| `script-src` | Result |
|---|---|
| `'self'` | `CompileError: WebAssembly.instantiate() … violates CSP` |
| `'self' 'wasm-unsafe-eval'` | compiles, then `EvalError: Evaluating a string as JavaScript violates … 'unsafe-eval'` |
| `'self' 'wasm-unsafe-eval' 'unsafe-eval'` | works |

So the Emscripten glue evaluates a string at run time, beyond compiling the WASM module.

### Why it matters

`'unsafe-eval'` is the single largest weakening available in a CSP, and a host that wants KTX2 has
to choose between compressed textures and a policy worth having. This platform chose the policy
(`nginx/csp.conf`), which means **KTX2 transcoding cannot run here at all** — acceptable only
because nothing currently ships a scenario that loads one (see the ScenarioCreator note).

### Asked

Can the transcoder be built without the eval path? Emscripten can usually be told to avoid it
(`-s DYNAMIC_EXECUTION=0`), and the KTX2 loader in some upstream distributions ships that way. If
the engine vendors this file, a CSP-safe build would remove the dilemma for every consumer.

Failing that: is a worker-based or WASM-only path available, so the eval stays out of the document?

---

## 3. Asset URLs are joined onto the manifest directory, not resolved

### Observed

`StreamingAssetSource` composes an asset URL by **string-joining** it onto the manifest's own
directory. A leading `/` is not treated as absolute:

```
manifest at /a/manifests/solar-system.json
asset url  "/a/objects/54/5400….js"
requested  /a/manifests//a/objects/54/5400….js   → 404
```

### Why it matters

It cost a full round of debugging and one abandoned design. It also constrains the store layout:
a manifest **must** sit exactly one level above `objects/`, and its URLs must stay relative, or
nothing loads. That is a real deployment constraint expressed nowhere in the type definitions —
`StreamingAssetSourceOptions.baseUrl` reads as though it makes the layout free, and it does not:
`baseUrl` replaces the base, so a `../` in the URL still climbs out of it.

### Asked

Is the join deliberate — for example so a manifest can be served from a path the host does not
control — or is it an oversight? Either way it is worth one sentence in the `loadScenarioFromManifest`
and `baseUrl` docs, because the failure is a 404 on a path that looks obviously wrong only in
hindsight.

If it is not deliberate, resolving with `new URL(url, manifestUrl)` would accept both absolute and
relative forms and break nothing that works today.

---

## 4. `MemoryProfiler` has no host-level lock, and no transcoded-format field

Two smaller things about the profiler.

### 4a. A scenario can open the overlay on a student

`MemoryProfiler.showOverlay()` is callable from scenario code, and
`solar-system-scenario.zip/scripts/Scenario.js` calls it — so the platform's flagship scenario
showed students a developer overlay of FPS and VRAM counters. Gating the host's own button cannot
prevent this, because a scenario is arbitrary engine code.

Worked around here: the viewer closes the overlay after load when `?diag=1` is absent, and an E2E
test holds the line. The content fix belongs to ScenarioCreator.

**Asked:** is a host-level policy possible — something like `MemoryProfiler.setEnabled(false)` that
a scenario cannot override? A host embedding untrusted-ish content has no way to say "diagnostics
are not available in this deployment" and have it stick.

### 4b. The report cannot say what a texture was transcoded to

`MemoryReport` exposes `estimatedTextureVramBytes` but no format, and `TextureFormat` is the
authoring enum (`RGBA32`, `RGB24`, …) with no compressed GPU formats in it. So "did KTX2 actually
transcode, and to what?" can only be answered indirectly, by comparing VRAM against the figure an
uncompressed fallback would give.

That works — the gap is ~8× and unmistakable — but it is inference, not observation, and it is the
only tool a host has for verifying a pipeline whose failure mode is silent.

**Asked:** could the report carry the resolved GPU format per texture, or at least a tally
(`{ BC7: 3, ETC2: 8, RGBA8: 1 }`)? It would turn a proxy measurement into a direct one.

---

## 5. Small notes, no action needed unless they surprise you

- **Scenario scripts execute from `blob:` URLs** (8 per run, on both delivery paths). Any host
  with a CSP needs `script-src blob:`, and without it *no scenario runs at all*. Worth a line in
  whatever integration docs exist — it is not guessable, and the failure is total.
- **`Application.version` is a fixed literal** (`"0.1.0"` across every local pack) while
  `BuildInfo.version` carries the real stamp. `BuildInfo` solved this properly; the older field
  now mostly exists to mislead. Consider deprecating it.
- **`BuildInfo.version` does distinguish local packs** — it reads `0.1.0-local.<timestamp>`, not
  the bare `0.1.0` the `IEngineBuildInfo` doc comment implies. The comment says `builtAt` is what
  tells builds apart "because version is fixed at 0.1.0 between real releases"; in the packs we
  receive, both work. Minor, but the comment sent us looking at the wrong field first.
