// ops/deploy/lib/release.mjs
//
// What a release *is*: the identifier of every image, the files it is made of,
// and the small state machine that says what to roll back to.
//
// The tag is the content address (decision D-2): `vl` (virtual-lab) and `ed`
// (editor) commit SHAs, tagged per image, so a rollback names an exact object
// id that a cache cannot serve from memory of a different build.

/**
 * The image tag for one commit: the full sha, because a short tag is a
 * collision waiting for the first two repos to share a prefix.
 * @param {string} sha
 * @returns {string}
 */
export function tagOf(sha) {
  const text = String(sha ?? '').trim();
  if (!/^[0-9a-f]{40}$/i.test(text)) {
    throw new RangeError(`tagOf: expected a full 40-character commit sha, got "${text.slice(0, 20)}…"`);
  }
  return text.toLowerCase();
}

/**
 * The release id: a readable string that ties both repos together.
 * @param {{vl: string, ed: string|null}} commits
 * @returns {string} e.g. `vl-a1b2c3d` or `vl-a1b2c3d-ed-c4d5e6f`.
 */
export function releaseId({ vl, ed }) {
  const short = sha => String(sha ?? '').slice(0, 7);
  if (ed) return `vl-${short(vl)}-ed-${short(ed)}`;
  return `vl-${short(vl)}`;
}

/** The three platform images, in the order they are built and shipped. */
const IMAGES = {
  backend: { repo: 'virtual-lab', service: 'backend', context: './backend', dockerfile: 'Dockerfile' },
  frontend: { repo: 'virtual-lab', service: 'frontend', context: '.', dockerfile: 'Dockerfile.frontend' },
  backup: { repo: 'virtual-lab', service: 'backup', context: './backup', dockerfile: 'Dockerfile' },
  editor: { repo: 'editor', service: 'editor', context: '.', dockerfile: 'Dockerfile', sibling: true },
};

/**
 * `virtual-lab/<service>:<vlTag>` (and the editor's own name), in build order.
 * @param {{vlTag: string, edTag?: string|null}} tags
 * @returns {Array<{name: string, spec: typeof IMAGES[string]}>}
 */
export function imageNames({ vlTag, edTag = null }) {
  const names = [];
  for (const key of ['backend', 'frontend', 'backup']) {
    const spec = IMAGES[key];
    names.push({ name: `virtual-lab/${spec.service}:${vlTag}`, spec });
  }
  if (edTag) names.push({ name: `webengine-editor/${IMAGES.editor.service}:${edTag}`, spec: IMAGES.editor });
  return names;
}

/** The compose files a release is made of (decision D-4). */
export const BUNDLE_BASE = [
  'docker-compose.yml',
  'docker-compose.restore.yml',
  'ops/deploy/compose.release.yml',
  'db/init.sql',
];
/** Added when the release also carries the editor. */
export const BUNDLE_EDITOR = [
  'docker-compose.editor.yml',
  'ops/deploy/compose.release-editor.yml',
  'nginx/editor.conf',
  'nginx/csp-editor.conf',
];

/** A repo-relative path: no leading slash, no `..`, no driving letter. */
const REPO_RELATIVE = /^[\w./-]+$/;

/**
 * The compose `-f` order, in one place (decision D-4).
 *
 * `db/init.sql` is not a compose file, but it must travel with them (the
 * database mounts it), so the list is "the files a release carries" rather than
 * "the `-f` arguments"; the caller that builds the argv filters by extension.
 *
 * @param {{editor: boolean, extra?: string[]}} options
 * @returns {string[]} repo-relative paths, in order.
 */
export function composeFiles({ editor, extra = [] }) {
  const files = [...BUNDLE_BASE, ...(editor ? BUNDLE_EDITOR : []), ...extra];
  for (const file of files) {
    if (!REPO_RELATIVE.test(file) || file.startsWith('/') || file.includes('..')) {
      throw new Error(`composeFiles: "${file}" is not a repo-relative path`);
    }
  }
  // An extra is something a caller adds to the `-f` list, so it has to be a
  // compose file; the base list also carries inputs (db/init.sql) and those are
  // the plan's, not a caller's.
  for (const file of extra) {
    if (!/\.ya?ml$/.test(file)) {
      throw new Error(`composeFiles: an extra must be a .yml path, got "${file}"`);
    }
  }
  return files;
}

/** The bundle an rsync/archive carries: the compose files plus their inputs. */
export function bundleFiles({ editor, extra = [] }) {
  const compose = composeFiles({ editor, extra });
  const supporting = editor ? ['nginx/csp-editor.conf'] : [];
  return [...new Set([...compose, ...supporting])];
}

/**
 * The release state machine: what is current, what to roll back to.
 *
 * A record is `{id, tag, at}`. `nextState` moves current → previous, and history
 * is capped so a state file cannot grow with every deploy of the year.
 *
 * @param {{current: object|null, previous: object|null, history: object[]}} state
 * @param {object} record
 * @param {{cap?: number}} [options]
 */
export function nextState(state, record, { cap = 10 } = {}) {
  // The history is "what is current now, then what was" — one entry per release,
  // with `previous` naming the same record the head of the history holds.
  const history = [state.current, ...(state.history ?? [])].filter(Boolean).slice(0, cap);
  return { current: record, previous: state.current ?? null, history };
}

/** The release ids worth pruning images for: current, previous, one before. */
export function keepForPrune(state) {
  // current, then the history (whose head is the previous) — three distinct ids.
  return [state.current, ...(state.history ?? [])]
    .filter(Boolean)
    .slice(0, 3)
    .map(record => record.id);
}
