// path: src/app/models/scenario.model.ts

/**
 * A single scenario entry as described by the remote catalog manifest.
 *
 * The Angular host maintains its OWN catalog model that is separate from
 * the engine's IScenarioManifest (which lives inside the ZIP).
 * This model drives the catalog UI; the engine never sees it.
 */
export interface ScenarioCatalogItem {
  /**
   * Unique catalog ID; goes into the `/play/:id` path.
   *
   * **Not** the same as the `id` inside the ZIP's `manifest.json` — catalog rows
   * use slugs while manifests use reverse-domain ids, and the engine never
   * compares them (`loadScenarioFromBuffer` only receives the bytes). The admin
   * screen surfaces both so the drift stays visible.
   */
  id: string;

  /** Human-readable title shown in cards and modals. */
  title: string;

  /** Short description for the card preview (1–2 sentences). */
  description: string;

  /** Full description shown in the detail modal. */
  fullDescription: string;

  /** Category key for filtering (e.g. "physics", "biology"). */
  category: string;

  /** Localized category label for display (e.g. "Фізика"). */
  categoryLabel: string;

  /** URL to the preview image (thumbnail). */
  imageUrl: string;

  /** URL to the scenario ZIP archive (engine downloads this). */
  scenarioUrl: string;

  /**
   * URL of the streaming manifest, when this scenario is also published as one.
   *
   * The alternative delivery path: scripts and assets fetched individually from
   * a `scenario.json` instead of unpacked from one ZIP. Null for scenarios that
   * only exist as an archive — which is most of them, and the viewer falls back
   * to `scenarioUrl` in that case.
   */
  manifestUrl?: string | null;

  /** Scenario version string. */
  version?: string;

  /** Author name. */
  author?: string;

  /** Upload / publish date (ISO string). */
  uploadDate?: string;
}

/**
 * The shape of the remote catalog manifest JSON file.
 *
 * Hosted as a static JSON (e.g. on GitHub Pages, S3, or a simple API).
 * The Angular app fetches this on CatalogComponent init.
 *
 * @example
 * ```json
 * {
 *   "version": "1",
 *   "scenarios": [
 *     {
 *       "id": "solar-system",
 *       "title": "Сонячна Система",
 *       "description": "...",
 *       "scenarioUrl": "https://storage.example.com/scenarios/solar-system.zip"
 *     }
 *   ]
 * }
 * ```
 */
export interface ScenarioCatalogManifest {
  /** Manifest format version. */
  version: string;

  /** Array of available scenarios. */
  scenarios: ScenarioCatalogItem[];

  /**
   * Distinct categories actually used by the published scenarios.
   *
   * Sent by the API so the filter bar reflects the data instead of a
   * hard-coded list; the client only supplies the icon per category key.
   */
  categories?: CatalogCategory[];

  /** Total rows matching the current filter, across all pages. */
  total?: number;

  /** Page size the server applied (it caps the requested value). */
  limit?: number;

  /** Offset of this page. */
  offset?: number;
}

/**
 * One category as reported by the catalog API.
 */
export interface CatalogCategory {
  /** Category key, e.g. "physics". */
  category: string;

  /** Localized label for display, e.g. "Фізика". */
  categoryLabel: string;
}

/**
 * Filter category for the catalog sidebar / chip bar.
 */
export interface CategoryFilter {
  id: string;
  label: string;
  icon?: string;
}

/**
 * A scenario as seen by the admin screen: everything the public catalog hides.
 *
 * Only reachable with `Authorization: Bearer $ADMIN_TOKEN`
 * (`GET /api/admin/scenarios`).
 */
export interface AdminScenario extends ScenarioCatalogItem {
  /** Whether the scenario appears in the public catalog. */
  isPublished: boolean;

  /** `local` = archive in our storage, `drive` = legacy external link. */
  storageKind: 'local' | 'drive';

  /** Content hash of the stored archive, if any. */
  archiveSha256: string | null;

  /** Archive size in bytes, if known. */
  archiveBytes: number | null;

  /**
   * `id` from the archive's own `manifest.json`.
   *
   * Deliberately independent of the catalog `id`: manifests use reverse-domain
   * ids while the catalog uses slugs, and the engine never compares the two.
   */
  manifestId: string | null;

  /** `version` from the archive's manifest. */
  manifestVersion: string | null;

  /**
   * Which engine build the archive was compiled against, from the manifest's
   * `engineVersion`. Null for archives built before ScenarioCreator stamped it.
   *
   * Compare against the build the viewer reports under `?diag=1`: this says what
   * the scenario was built against, that says what is actually running them.
   */
  manifestEngineVersion: string | null;
}

/**
 * Result of a successful archive upload / import.
 */
export interface ArchiveUploadResult {
  id: string;
  sha256: string;
  bytes: number;
  url: string;
  deduplicated: boolean;
  manifestId: string;
  warnings: string[];
}
