// ops/deploy/lib/build.mjs
//
// The exact commands that build and ship a release (OPS1 phase 2, decision D-2:
// images are built on the worker and shipped over SSH — no registry).
//
// Everything here is a pure description of a command line: no process is spawned,
// so a unit test can compare the argv against a literal list, and the rehearsal
// is the first time a command actually runs.
//
// The gates that decide *whether* to build are here too (`checkFreshSource`),
// because a release built from a dirty worktree cannot be reproduced later —
// which is the one property the whole tagging scheme exists to give.

import { execFileSync } from 'node:child_process';

/** The three platform images and the editor, as `docker build` arguments. */
const SPECS = {
  backend: { dir: './backend', dockerfile: 'Dockerfile' },
  frontend: { dir: '.', dockerfile: 'Dockerfile.frontend' },
  backup: { dir: './backup', dockerfile: 'Dockerfile' },
};

/**
 * The `docker build` argv for each image, in build order.
 *
 * @param {{vlRepo: string, edRepo: string, vl: string, ed: string|null, editor: boolean}} release
 * @returns {Array<{service: string, name: string, argv: string[]}>}
 */
export function buildCommands({ vlRepo, edRepo, vl, ed, editor }) {
  const commands = [];
  const push = (service, name, argv) => commands.push({ service, name, argv });

  for (const [service, spec] of Object.entries(SPECS)) {
    push(service, `virtual-lab/${service}:${vl}`, [
      'build', '-t', `virtual-lab/${service}:${vl}`,
      '--label', `org.opencontainers.image.revision=${vl}`,
      '-f', spec.dockerfile,
      // Forward slashes: Docker accepts them on Windows, and a backslashed path
      // is a syntax error inside the daemon.
      spec.dir,
    ]);
  }

  if (editor && ed) {
    push('editor', `webengine-editor/editor:${ed}`, [
      'build', '-t', `webengine-editor/editor:${ed}`,
      '--label', `org.opencontainers.image.revision=${ed}`,
      '-f', 'Dockerfile',
      // The editor's own checkout, never docker-compose.editor.yml's build
      // context: that one resolves against a sibling directory a production
      // host does not have (research F-8).
      edRepo,
    ]);
  }
  void vlRepo;
  return commands;
}

/**
 * Whether a repository may be released from (decision D-5).
 *
 * A *modified or untracked* file is refused at any time: `--porcelain` lists
 * untracked files too, because an untracked file can be the whole difference
 * between what runs here and what runs in production. `--rehearsal` skips only
 * the HEAD comparison, never the porcelain one — a rehearsal is allowed to run
 * commits that were not pushed (the induced-migration case), not a worktree
 * whose content is unknown.
 *
 * @param {string} repo — the repository's directory.
 * @param {string} defaultBranch — e.g. `main`.
 * @param {{rehearsal?: boolean}} [options]
 * @returns {{ok: boolean, reason: string}}
 */
export function checkFreshSource(repo, defaultBranch, { rehearsal = false } = {}) {
  const git = (args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  const porcelain = git(['status', '--porcelain']).trim();
  if (porcelain !== '') {
    return { ok: false, reason: `the worktree has uncommitted or untracked changes in ${repo}` };
  }
  if (!rehearsal) {
    const head = git(['rev-parse', 'HEAD']).trim();
    const base = git(['rev-parse', `origin/${defaultBranch}`]).trim();
    if (head !== base) {
      return { ok: false, reason: `HEAD of ${repo} is not origin/${defaultBranch}` };
    }
  }
  return { ok: true, reason: '' };
}

/**
 * The image ids of the named images, read from the local Docker.
 * @param {string[]} names
 * @returns {string[]} one id per name, in the same order.
 */
export function imageIds(names) {
  return names.map(name => execFileSync('docker', [
    'image', 'inspect', '--format', '{{.Id}}', name,
  ], { encoding: 'utf8' }).trim());
}

/**
 * The pipeline that ships images: `docker save` | `gzip` on this side.
 * @param {string[]} names
 * @returns {{argv: string[], note: string}}
 */
export function saveCommand(names) {
  return {
    argv: ['save', ...names],
    note: 'the stream is gzipped and piped over SSH to `gunzip | docker load` (decision D-2)',
  };
}
