// backend/scripts/catalog-metadata.mjs
//
// Platform-owned catalog metadata, keyed by the manifest id inside each archive.
//
// Title, description and version are NOT here: they come from the archive's own
// `manifest.json`. ScenarioCreator owns that text, and republishing should pick
// up content edits rather than silently serve a stale copy typed in twice.
//
// What is left is what the manifest genuinely cannot know:
//
//   category / categoryLabel  which university subject the scenario is filed
//                             under. The manifest's own `category` field says
//                             "education" / "simulation" / "test" — a content
//                             type, not a subject — so it is deliberately unused.
//   published                 whether students see it at all.
//   fullDescription           the long text in the catalog's detail modal.
//                             Optional; see the fallback rule below.
//   supersedes                catalog ids this entry replaces, for rows created
//                             before manifest ids and catalog ids agreed.
//
// `fullDescription` rule: the modal renders *only* this field, so a new row must
// never be created with it empty — the publisher falls back to the manifest's
// description. On an existing row it is left alone unless authored here, so a
// hand-written long description is not overwritten by the short one.

/** Applied to every scenario unless the entry overrides it. */
export const DEFAULTS = {
  author: 'HuGox',
  imageUrl: '',
  published: true,
};

/**
 * Subject labels, kept in one place so a typo cannot split a category in two.
 * `category` is the value the catalog filters on; `categoryLabel` is the chip.
 */
const SUBJECT = {
  physics: { category: 'physics', categoryLabel: 'Фізика' },
  chemistry: { category: 'chemistry', categoryLabel: 'Хімія' },
  biology: { category: 'biology', categoryLabel: 'Біологія' },
  astronomy: { category: 'astronomy', categoryLabel: 'Астрономія' },
  test: { category: 'test', categoryLabel: 'Test' },
};

export const CATALOG_METADATA = {
  // ── Astronomy ──────────────────────────────────────
  'solar-system': {
    ...SUBJECT.astronomy,
    imageUrl:
      'https://images.unsplash.com/photo-1614730341194-75c607ae82b3?q=80&w=800&auto=format&fit=crop',
  },
  'orbital-mechanics': { ...SUBJECT.astronomy },

  // ── Physics ────────────────────────────────────────
  'mechanics-incline': { ...SUBJECT.physics },
  'optics-lenses': { ...SUBJECT.physics },
  'electric-circuits': { ...SUBJECT.physics },
  'gas-theory': { ...SUBJECT.physics },

  // ── Chemistry ──────────────────────────────────────
  // Atomic structure is taught on both sides of the physics/chemistry line;
  // filed under chemistry because the scenario opens on the periodic table.
  'atom-structure': { ...SUBJECT.chemistry },
  'molecules': { ...SUBJECT.chemistry },
  'crystal-lattices': { ...SUBJECT.chemistry },

  // ── Biology ────────────────────────────────────────
  'dna-protein-synthesis': { ...SUBJECT.biology },

  // ── Bench scenes ───────────────────────────────────
  // Engine benchmarks, not teaching material: unpublished so they stay out of
  // the student catalog while remaining visible and editable in /admin.
  //
  // `supersedes` carries the ids these rows were seeded under, before catalog
  // ids were aligned with manifest ids. Two of them contain a space, which ends
  // up in the /play/:id URL.
  //
  // Benchscene3 is the only archive in the release that ships .ktx2 textures,
  // so it is the scenario any KTX2 check has to run against — publish it
  // temporarily to do that, then unpublish it again.
  'benchscene1-primitives': {
    ...SUBJECT.test,
    published: false,
    supersedes: ['Benchscene1_primitives'],
  },
  'benchscene2-complexmodel': {
    ...SUBJECT.test,
    published: false,
    supersedes: ['Benchscene2 complexmodel'],
  },
  'benchscene3-solarsystem': {
    ...SUBJECT.test,
    published: false,
    supersedes: ['Benchscene3 solarsystem'],
  },
};
