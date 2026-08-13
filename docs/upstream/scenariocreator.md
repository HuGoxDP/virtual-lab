# Questions for ScenarioCreator

Found while republishing the catalog, verifying KTX2 and building the streaming store in the
Virtual Lab platform, against the `ReleaseScenarios/` output as of **2026-08-13**.

The release itself is in good shape — real ids, real Ukrainian titles and descriptions, real
`engineVersion`, honest priorities and a working content-addressed `objects/` store. All four
items below are about content and packaging, not about the pipeline being broken.

---

## 1. Nothing actually loads the `.ktx2` files — the scenarios ask for the `.jpg`

**The one with a real cost attached.**

### Observed

`Benchscene3_solarsystem.zip` contains **12 `.ktx2` and 12 `.jpg`** for the same 12 textures.
`Benchscene3_solarsystem.scenario.json` lists all 24 as separate assets with distinct guids. But
the scenario's own code asks for the originals:

```
scripts/Scenario.js  →  skybox/stars_panorama.jpg
```

Confirmed from the other side too: during a full run in a real browser,
**`basis_transcoder.js` is never requested at all.** It is served over HTTP, so any run decoding
even one `.ktx2` would have to fetch it. Texture VRAM sits at **242.7 MB**, essentially the
~279 MB an uncompressed RGBA8 fallback predicts, where transcoding would give **~36 MB**.

### Why it matters

- The `.ktx2` files are carried, catalogued and never referenced — payload with no benefit.
  Measured inside `Benchscene3_solarsystem.zip`: **3.66 MB of the 9.95 MB archive is the unused
  `.ktx2` set**, against 6.28 MB for the `.jpg` files that are actually loaded. Every student
  downloads that 3.66 MB and nothing reads it.
- The compression work itself is **correct**: all 12 are properly supercompressed (11 ETC1S/BasisLZ,
  `earth_normal` UASTC/Zstd), verified from the file headers by `backend/scripts/verify-ktx2.mjs`.
  So this is a wiring problem, not an encoding one.
- It made KTX2 unverifiable end to end. The platform's transcoder path is correct and simply
  unexercised.

### Asked

Should the scenario reference the `.ktx2` variants, with the `.jpg` kept only as a fallback for
browsers without the extensions — or is shipping both by design? If both, is there a reason the
`.jpg` wins?

**One constraint to know before switching:** this platform now ships a Content Security Policy
without `'unsafe-eval'`, and the basis transcoder needs it (see
[`webenginets.md`](webenginets.md) §2). Turning KTX2 on therefore needs a decision on both sides,
not just here. `e2e/tests/ktx2.spec.ts` is written to activate itself the moment a scenario
references a `.ktx2`, so the platform will notice immediately either way.

---

## 2. `solar-system` opens the memory profiler on whoever runs it

### Observed

`solar-system-scenario.zip/scripts/Scenario.js` calls, directly:

```
MemoryProfiler.showOverlay      ×2
MemoryProfiler.logReport        ×3
MemoryProfiler.hideOverlay      ×2
MemoryProfiler.isOverlayVisible ×1
```

So opening the platform's flagship scenario showed **students** a developer overlay of FPS, CPU
frame time and VRAM counters, plus a console dump on every run. `Molecules.zip` and the other
production scenarios have none of this.

### Why it matters

It is user-visible, on the scenario a first-time visitor is most likely to open. The platform's
`?diag=1` gate governs its own button; it cannot govern what content does once running.

Worked around here — the viewer now closes the overlay after load when `?diag=1` is absent, and an
E2E test holds the line — so nothing is on fire. But the call is presumably left-over debugging
rather than intent.

### Asked

Remove the profiler calls from the scenario source, unless they are deliberate. If they are
deliberate, they need a flag rather than being unconditional, because the host has no say.

---

## 3. Two different relative-URL conventions in one release

### Observed

Manifests at the release root use a bare path; the bench scenes one directory deeper use `../`:

```
ReleaseScenarios/Molecules.scenario.json          "url": "objects/aa/aabc….js"
ReleaseScenarios/test/Benchscene3….scenario.json  "url": "../objects/83/83a9….ktx2"
```

Both resolve correctly *in place*, so nothing is wrong with the release as a directory. It only
bites a consumer that serves them from a single location.

### Why it matters here

The importer has to normalise both, and the naive normalisation is actively dangerous:
`path.join(stagingDir, '../objects/x')` **escapes the staging directory**, which silently wrote
objects outside the tree on the first attempt and produced 404s. It also split the dedup key —
the same file under two spellings was stored twice, costing 16 objects and 7 MB until the key was
normalised.

Handled on this side (`backend/scripts/import-release-assets.mjs` derives a canonical
`objects/<2>/<file>` from the last two path segments).

### Asked

Could the emitted URLs be uniform — either always relative to the manifest's own directory in a
layout where that means the same thing, or always relative to the release root? It is not urgent
now that it is handled, but every future consumer will hit the same `../` trap.

---

## 4. Manifest priorities are set, and the scenario code declines them

### Observed

`solar-system.scenario.json` carries differentiated priorities: **1 critical, 6 high, 11 low.**
Benchscene3 likewise (2 / 4 / 18). That is exactly what progressive first paint needs.

But measured in a browser, both the ZIP path and the manifest path report the **same draw calls at
first frame** — the whole scene. Nothing was deferred. The scenario's own code loads every asset
before it first renders, so the priorities have nothing to act on.

### Why it matters

It is the reason the streaming path shows no first-frame benefit here, and therefore the reason
this platform serves it only behind `?stream=1` rather than by default. The delivery mechanism
works; the content is not written to take advantage of it.

(The timing measurements were taken under SwiftShader, where run-to-run spread is ~30% and larger
than the effect being looked for — so "no benefit" is properly "no benefit demonstrable here". The
draw-call observation is not timing-dependent and does stand.)

### Asked

Is it feasible for a scenario to render before its `low` assets arrive — placeholder materials, or
simply creating objects as textures land rather than awaiting them all up front? Without that,
`priority` in the manifest is descriptive rather than functional, and progressive loading cannot
show a win no matter what the platform or engine do.

---

## Not a question — things that got better

Worth saying, since the list above is all problems:

- **Manifest metadata is real now.** Ids, versions, Ukrainian titles and descriptions,
  `engineVersion`. That is what let this repo's publisher take title/description/version straight
  from the archive instead of duplicating them — and it closed roadmap item R7 outright.
- **Catalog ids and manifest ids now agree** on all 13 scenarios, because the emitted id is a slug.
- **Supercompression is correct.** UASTC/Zstd for the normal map, ETC1S/BasisLZ for everything
  else — the right split, verified from the headers.
- **Archives shrank a lot.** Benchscene2 went from 28.0 MB to 9.26 MB (both MiB, from the stored
  object this platform replaced and the one that replaced it).
