# Scenario Storage & Delivery — Target Architecture & Migration

Status: **design** · Scope: `virtual-lab` (backend, db, nginx, docker-compose) · Related:
engine-side design in `WebEngineTS/design/asset-streaming-proposal.md`

This document explains **why** scenario storage/delivery must change and **what** the end state
looks like (addressing model, manifest, data model). It is the architectural companion to
[`implementation-plan.md`](implementation-plan.md), which holds the actionable, estimated task
list with file anchors.

**How the two relate — do not duplicate work items:**

| This document (target design) | `implementation-plan.md` (execution) |
| --- | --- |
| Stage 0 — own the storage, content-addressed | **Phase 1 — Own the storage** ✅ done 2026-08-01 |
| Stage 1 — manifest + asset table | Phase 1/2 follow-up (new: `scenario_assets`, manifest endpoint) |
| Stage 2 — progressive delivery | **Phase 6 — Streaming client** |
| Stage 3 — object store + presigned URLs | Phase 1 alternative (MinIO), deferred until needed |
| Stage 4 — LOD streaming + atomic publish | **Phase 2** (publishing) + engine P1.7 Stage 3 |

When the two disagree on *how* or *when*, `implementation-plan.md` wins; this document defines
the *shape* of the destination.

---

## 1. Starting state — *historical, superseded 2026-08-13*

> This is what the migration started from, kept because the stages below are written against it.
> **None of it is true any more:** archives are content-addressed in a local volume served by
> nginx, and the Drive proxy and its scraping are deleted. See [`PLAN.md`](PLAN.md#progress).

```
Editor/ScenarioCreator ──(manual)──> Google Drive (ZIP, "anyone with link")
                                            │
PostgreSQL `scenarios` (metadata + scenario_url) ──> Angular catalog
                                            │
Angular viewer ──> GET /api/proxy-download?url=… ──> backend scrapes Drive ──> ZIP stream
                                                                                │
                                                          Application.loadScenarioFromBuffer
```

- **Metadata:** PostgreSQL `scenarios` table (`db/init.sql`) — `id`, `title`, `category`,
  `image_url`, `scenario_url`, `version`, `is_published`, …
- **Binaries:** Google Drive; `scenario_url` is a Drive sharing link.
- **Delivery:** `GET /api/proxy-download` (`backend/server.js`) converts the sharing link to a
  direct link, **parses Google's HTML confirmation page** for large files
  (`extractDriveConfirmUrl` / `extractDriveConfirmToken`), and streams the ZIP to the browser
  (bypassing CORS).
- **Creation:** manual, 3 steps — build ZIP → upload to Drive → `POST /api/catalog` with the link.

### Why this must change

| Problem | Impact |
| --- | --- |
| Backend scrapes Google's HTML confirm page | Breaks whenever Google changes markup — not an API |
| Drive files must be "anyone with the link" | No access control; no private/unpublished content |
| Drive quotas/throttling on automated downloads | A class of students downloading at once can get blocked |
| No checksums / immutable URLs | No integrity check; browser re-downloads the whole ZIP every time |
| All traffic flows through the app backend | Backend is in the data path; doesn't scale |
| 3-step manual publish | Metadata and binary can drift out of sync |
| **Monolithic ZIP** | **Blocks LOD streaming, progressive first paint, preloading, dedup, partial updates** |

The last row is the strategic one: as long as a scenario is one opaque archive, the engine
*cannot* stream LODs or paint progressively, no matter how good the storage is.

---

## 2. Target state

```
Editor ──(Publish: one API call)──> POST /api/scenarios (ZIP or asset set)
                                          │
                     ┌────────────────────┴─────────────────────┐
                     ▼                                          ▼
        Object store (content-addressed)              PostgreSQL
        /a/<sha256>.<ext>  (immutable, dedup)         scenarios + scenario_assets
        nginx volume → MinIO/S3 (+CDN)                (manifest, hashes, sizes, LODs)
                     │
                     ▼
        Browser fetches manifest, then assets by priority/LOD
        (direct or presigned — backend not in the data path)
```

Principles:
1. **Metadata in Postgres, bytes in an object store** (already the right split — replace the
   store, not the model).
2. **Content-addressed URLs** (`/a/<sha256>.<ext>`) → immutable, cacheable forever,
   automatically deduplicated across scenarios and versions.
3. **Manifest-first delivery** — a small `scenario.json` lists scripts and assets with type,
   hash, size, priority and LOD variants (schema in the engine proposal).
4. **Single atomic publish** from the editor.
5. **Single-ZIP path stays supported** — small/offline scenarios keep working unchanged.

---

## 3. Migration stages

Stages describe the *destination* of each step and mirror the engine-side stages in
`asset-streaming-proposal.md`. Platform work leads; the engine consumes what the platform
serves. **Execution details (tasks, estimates, file anchors) live in
[`implementation-plan.md`](implementation-plan.md)** — the mapping table above says which phase
covers which stage.

### Stage 0 — Own the storage (remove Google Drive) ✅ **done 2026-08-01**
**Platform work only. No engine changes. Biggest risk reduction per effort.**

→ **Executed as [Phase 1 — Own the storage](implementation-plan.md)** — ✅ done 2026-08-01
(that phase is authoritative for the task list; Phase 0's security work blocked it and is also done).

Destination shape:
- Archives served by the existing **nginx** service from a volume (nginx already caches
  `zip|ktx2|glb|wasm` with `Cache-Control: public, immutable`), never streamed by Express.
- Archives stored **content-addressed** (`/scenarios/<sha256>.zip`) — immutable, cacheable
  forever, and dedup comes free once assets are split out in Stage 1.
- `scenarios` gains `archive_sha256` + `archive_bytes` (integrity + real `Content-Length`);
  a `storage_kind` (`drive|local|object`) discriminator lets old and new rows coexist while
  migrating.
- All Drive scraping (`toGoogleDriveDirectUrl`, `extractDriveConfirm*`, `buildConfirmedUrl`,
  `/api/proxy-download`) is deleted once the seeded scenarios are migrated.

*Done when:* loading a scenario issues zero external requests; every archive has a checksum;
an offline `docker compose up` still plays the whole catalog.

> **Done 2026-08-13.** All of that scraping is deleted, together with the import-from-URL
> endpoint, the host allowlist and `LEGACY_DRIVE_PROXY`. The guarantee now holds at first boot
> too, not just for a running deployment: the seed is gone from `db/init.sql`, and a fresh
> install starts with an empty catalog filled by `npm run publish:release`.

### Stage 1 — Manifest + asset table (format change, behaviour unchanged)

> **Partly done, and this section is partly wrong — corrected 2026-08-13.** The serving half
> exists: `nginx ^~ /a/`, the `virtual_lab_assets` volume, and `npm run import:assets`, verified by
> `e2e/tests/streaming.spec.ts`. Corrections from doing it, in
> [`PLAN.md`](PLAN.md#progress):
>
> - **An asset is addressed by `path` (+ optional `guid`), not by an `asset_id`.** The sketch below
>   predates the engine's implementation; `parseStreamingManifest` rejects that shape.
> - **The layout is `/a/objects/<2 chars>/<sha256>.<ext>`, not `/a/<sha256>.<ext>`.** Two-level
>   sharding, matching ScenarioCreator — one release is already ~100 objects.
> - **The manifest must sit one level above `objects/` with relative URLs.** The engine joins an
>   asset URL onto the manifest's directory as a string rather than resolving it, so an absolute
>   `/a/objects/…` becomes `/a/manifests//a/objects/…`.
> - `priority` and `lods` live on the asset in the manifest; a `lod_level` column would flatten a
>   ladder the manifest already expresses.

- New table `scenario_assets` (`scenario_id`, `asset_id`, `type`, `lod_level`, `sha256`,
  `bytes`, `priority`, `url`) + `GET /api/scenarios/:id/manifest` returning `scenario.json`.
- Publish pipeline (ScenarioCreator, later the editor) uploads **individual assets** to
  `/a/<sha256>.<ext>` in addition to the ZIP, and registers them.
- Engine still loads everything up front (parity) — this stage only changes *addressing*.

*Done when:* every scenario has a valid manifest; assets are content-addressed and deduped
(the same texture used by two scenarios is stored once).

### Stage 2 — Progressive delivery (first paint)
- Manifest marks assets `critical` vs deferred; engine paints after scripts + critical assets.
- nginx: HTTP/2 (cheap parallel small requests), long-lived immutable caching for `/a/*`.

*Done when:* measured time-to-first-frame drops materially on the real Solar System scenario.

### Stage 3 — Object store + presigned delivery (scale & access control)
- Add **MinIO** (S3-compatible, self-hosted) to `docker-compose.yml`; migrate `/a/*` into it.
- Backend issues **presigned GET URLs**; the browser fetches assets **directly** from the
  store — the backend leaves the data path.
- Enables private/unpublished scenarios (time-limited links) and horizontal scale; optional
  CDN in front for off-campus delivery.

*Done when:* asset traffic no longer flows through `backend`; unpublished scenarios are not
publicly readable.

### Stage 4 — LOD streaming & atomic editor publish
- Publish pipeline generates **LOD variants offline** (KTX2 via `toktx`/`gltf-transform`,
  downscaled mips, decimated meshes) and records them in `scenario_assets`.
- Editor "Publish" = one call: validate → upload **only changed hashes** → upsert metadata →
  new manifest version. Replaces the 3-step manual flow and retires ScenarioCreator.
- Engine streams LODs by on-screen size + VRAM budget (engine Stage 3).

*Done when:* peak texture VRAM drops on integrated GPUs; republishing an edited scenario
uploads only what changed.

---

## 4. Compatibility & rollback

- `storage_kind` lets old (Drive) and new (local/object) rows coexist during migration.
- The engine keeps `loadScenarioFromBuffer` (single ZIP); the manifest path is additive, so a
  scenario without a manifest still loads.
- Each stage is a separate deploy; rolling back one stage does not break the others.
- Postgres remains the single source of truth for metadata throughout.

---

## 5. Where to start

Stage 0 is **done** — see [Phase 1 in `implementation-plan.md`](implementation-plan.md) for what
landed. Archives are content-addressed on a Docker volume served by nginx, the write endpoints are
behind an admin token, and as of 2026-08-13 the Drive proxy is not gated but **deleted**.

Next up is **Stage 1** (manifest + `scenario_assets`), which pairs with Phase 2's publishing
workflow.

Everything beyond Stage 1 additionally depends on the engine shipping `StreamingAssetSource`
(engine P1.7); until then the platform can prepare manifests, but the viewer keeps using the
single-ZIP path.
