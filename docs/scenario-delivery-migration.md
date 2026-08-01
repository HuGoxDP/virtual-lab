# Scenario Storage & Delivery — Migration Plan

Status: **plan** · Scope: `virtual-lab` (backend, db, nginx, docker-compose) · Related:
engine-side design in `WebEngineTS/design/asset-streaming-proposal.md`

This document describes how scenario **creation, storage and delivery** will evolve from the
current state to a streaming-capable platform, and in what order. Each stage is independently
deployable — the platform keeps working after every stage.

---

## 1. Current state

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

Stages map 1:1 onto the engine-side stages in `asset-streaming-proposal.md`. Platform work
leads; the engine consumes what the platform serves.

### Stage 0 — Own the storage (remove Google Drive) ⭐ start here
**Platform work only. No engine changes. Biggest risk reduction per effort.**

- Add a `scenarios` volume served by the existing **nginx** service (`nginx/nginx.conf` already
  caches `zip|ktx2|glb|wasm` with `Cache-Control: public, immutable`).
- Store archives under a **versioned, immutable** path: `/scenarios/<id>/v<version>.zip`.
- Add `POST /api/scenarios/:id/archive` (multipart) — backend writes the file, computes
  **SHA-256** and size, updates the row atomically.
- DB migration: add `archive_sha256`, `archive_bytes`, `storage_kind` (`drive|local|object`)
  to `scenarios`. Keep `scenario_url` (now points at our own domain).
- Migrate existing rows: download each Drive ZIP once, store locally, rewrite `scenario_url`.
- **Delete** `toGoogleDriveDirectUrl`, `extractDriveConfirmUrl`, `extractDriveConfirmToken`,
  `buildConfirmedUrl` and the `/api/proxy-download` scraping path from `backend/server.js`.

*Done when:* no code touches Google Drive; the viewer loads scenarios from our nginx with
immutable caching; every archive has a checksum. **Frontend change:** fetch `scenario_url`
directly instead of `/api/proxy-download`.

### Stage 1 — Manifest + asset table (format change, behaviour unchanged)
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

## 5. Immediate next steps (Stage 0 checklist)

1. `db/init.sql` + migration: add `archive_sha256`, `archive_bytes`, `storage_kind`.
2. `docker-compose.yml`: add a `scenarios` volume mounted into the `frontend` (nginx) service.
3. `nginx/nginx.conf`: serve `/scenarios/` from that volume (immutable caching already configured).
4. `backend/server.js`: add `POST /api/scenarios/:id/archive` (multipart + SHA-256); remove the
   Drive scraping helpers and `/api/proxy-download`.
5. One-off migration script: pull each Drive ZIP → store → update `scenario_url` + checksum.
6. Frontend `scenario.service.ts`: download from `scenario_url` directly (no proxy).
