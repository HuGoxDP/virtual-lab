// path: src/app/models/scenario.model.ts

/**
 * A single scenario entry as described by the remote catalog manifest.
 *
 * The Angular host maintains its OWN catalog model that is separate from
 * the engine's IScenarioManifest (which lives inside the ZIP).
 * This model drives the catalog UI; the engine never sees it.
 */
export interface ScenarioCatalogItem {
  /** Unique ID (matches the ID inside the ZIP manifest). */
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
}

/**
 * Filter category for the catalog sidebar / chip bar.
 */
export interface CategoryFilter {
  id: string;
  label: string;
  icon?: string;
}
