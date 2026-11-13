// ops/deploy/lib/steps.mjs
//
// The deploy sequence, one function per step, in the order the gates of
// decision D-8 demand. Each step speaks to a transport, returns a small
// result, and beats the lock directories it is given — a long deploy never
// looks stale (D-7), and a step that fails stops the run where it stands.
//
// The order is the point of this file: it is what makes a red smoke roll back
// rather than leave a half-deployed stack, and what makes the database come
// back only when the deploy migrated (D-10).

import { writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { deployWindow } from './window.mjs';
import { needsDbRestore } from './rollback.mjs';
import { composeFiles as releaseComposeFiles, releaseId, bundleFiles } from './release.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REMOTE = path.resolve(HERE, '../remote');

/** The remote script for a step, by name. */
const script = name => path.join(REMOTE, `${name}.sh`);

/** The compose project a release runs under; the rehearsal uses its own. */
const projectOf = context => context.project ?? 'virtual-lab';

/** `key=value` lines from a script's stdout, as an object. */
export function parseFields(stdout) {
  const out = {};
  for (const line of String(stdout ?? '').split('\n')) {
    const match = /^([a-z_][a-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) out[match[1]] = match[2];
  }
  return out;
}

/** A migration set as printed by `migrations.sh`, as a list. */
const migrationList = text => String(text ?? '').split(',').map(s => s.trim()).filter(Boolean);

/** Beats every lock directory, so a long step never looks abandoned (D-7). */
async function beat(locks, phase) {
  for (const dir of locks ?? []) {
    try {
      writeFileSync(`${dir}/heartbeat`, `${new Date().toISOString()} ${phase}\n`);
    } catch {
      // A lock directory that vanished mid-run is the wrapper's business; a
      // heartbeat that fails must not stop a deploy.
    }
  }
}

/** One step: run a remote script, parse its answer, beat the locks. */
async function step(name, transport, args, { locks = [], log = null } = {}) {
  await beat(locks, name);
  const answer = await transport.run(script(name), args);
  const fields = parseFields(answer.stdout);
  log?.info(`${name} → ${answer.code === 0 ? 'ok' : 'EXIT ' + answer.code}`);
  return { name, ...fields, code: answer.code, ok: answer.code === 0 };
}

/** A refusal: which gate refused, what to say, and the exit code to answer. */
const refusal = (failed, steps, exitCode, extra = {}) => ({
  ok: false, failed, steps, exitCode, ...extra,
});

/** The release env written beside the compose files: tag, commit, the file list. No secret. */
export function releaseEnvContents({ vlTag, vlCommit, composeFiles: files, edTag = null }) {
  const lines = [
    `VL_TAG=${vlTag}`,
    `VL_COMMIT=${vlCommit}`,
    `COMPOSE_FILE=${files.join(',')}`,
  ];
  if (edTag) lines.push(`ED_TAG=${edTag}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Writes the release bundle as a tar: the compose files, the inputs they need beside
 * them, and `release.env`. Returns its absolute path.
 *
 * A bundle is a directory copied out of the worktree and tarred, so what reaches the
 * server is exactly what a release declares, not whatever the worktree happened to
 * contain. It is deliberately written *outside* the worktree: a release never depends on
 * an untracked file that could be missing.
 *
 * @param {string} repoRoot — the worktree the release is cut from.
 * @param {{vlTag: string, vlCommit: string, editor?: boolean, extra?: string[], edTag?: string|null}} release
 * @param {string} [out] — where the tar goes; a temp file when unset.
 */
export function writeBundle(repoRoot, release, { out = null } = {}) {
  const files = bundleFiles({ editor: release.editor === true, extra: release.extra ?? [] });
  const stage = path.join(os.tmpdir(), `vl-bundle-${release.vlTag.slice(0, 8)}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  try {
    for (const file of files) {
      const from = path.join(repoRoot, file);
      const to = path.join(stage, file);
      mkdirSync(path.dirname(to), { recursive: true });
      cpSync(from, to);
    }
    writeFileSync(path.join(stage, 'release.env'),
      releaseEnvContents({ ...release, composeFiles: files }));
    const target = out ?? path.join(os.tmpdir(), `vl-bundle-${release.vlTag.slice(0, 8)}.tar.gz`);
    const tar = spawnSync('tar', ['-czf', target, '-C', stage, '.'], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (tar.status !== 0) throw new Error(`tar of the release bundle exited ${tar.status}`);
    return { path: target, files };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * The smoke: a read-only Playwright pass against the deployed stack, with the commit
 * pinned. Injected into the context, so the rehearsal runs the real suite and the unit
 * tests replace it with a stub.
 *
 * A rollback smokes the release it came back to, which is a *different* commit — hence
 * the `previous` flag, which the injected smoker reads to pin the right one.
 *
 * @param {{smoke?: Function, red?: string, commits: object, log?: object}} context
 * @param {{url: string, previous?: boolean}} options
 */
async function runSmoke(context, { url, previous = false }) {
  const { smoke } = context;
  if (!smoke) return { name: 'smoke', ok: context.red !== 'smoke' && !context.redPrevious };
  const answer = await smoke({ expectedCommit: context.commits.vl, url, previous });
  if (answer.stdout) context.log?.info(`[smoke] ${answer.stdout.split('\n').slice(-3).join(' | ')}`);
  return { name: 'smoke', ok: answer.ok !== false, code: answer.ok ? 0 : 1 };
}

/**
 * The compose file list for a release, as the single string every compose-touching
 * script receives.
 *
 * @param {{composeFiles?: string[]|string, extra?: string[], editor?: boolean}} context
 * @returns {string} comma-separated, in order.
 */
function composeFilesFor(context) {
  const files = context.composeFiles ?? releaseComposeFiles({ editor: context.editor === true, extra: context.extra ?? [] });
  return Array.isArray(files) ? files.join(',') : String(files);
}

/**
 * The deploy sequence.
 *
 * @param {object} context
 * @param {{run: Function, pipeIn: Function}} context.transport
 * @param {object} context.config — the parsed deploy configuration.
 * @param {{vl: string, ed: string|null}} context.commits
 * @param {string[]} context.images — the images the release is made of.
 * @param {string[]} context.locks — lock directories to beat (D-7).
 * @param {object} [context.log]
 * @param {() => Date} [context.now]
 * @param {string} [context.red] — a rehearsal's induced failure: `smoke` or `waitHealthy`.
 */
export async function deployPlatform(context) {
  const { transport, config, commits, images, locks = [], log = null, now = () => new Date(), red } = context;
  const done = [];
  // The compose file list every step that talks to compose needs, as one string the
  // scripts pass to `COMPOSE_FILE` (a path in a value cannot become a flag).
  const composeFiles = composeFilesFor(context);

  // D-8, first gate: the teaching-hours window. `inspect` and a dry run are
  // allowed at any time, which is why this is the caller's to ask about.
  const window = deployWindow(now());
  if (!window.allowed) return refusal('window', done, 4, { reason: window.reason });

  const release = releaseId(commits);

  const inspect = await step('inspect', transport, [config.DEPLOY_PATH], { locks, log });
  done.push(inspect.name);
  if (!inspect.ok) return refusal(inspect.name, done, 4);

  const prepare = await step('prepare', transport, [config.DEPLOY_PATH], { locks, log });
  done.push(prepare.name);
  if (!prepare.ok) return refusal(prepare.name, done, 4);

  const backup = await step('backup', transport, [config.DEPLOY_PATH, projectOf(context), composeFiles], { locks, log });
  done.push(backup.name);
  if (!backup.ok) return refusal(backup.name, done, 4);

  const verifyBackup = await step('verify-backup', transport, [backup.backup_path], { locks, log });
  done.push(verifyBackup.name);
  if (!verifyBackup.ok || verifyBackup.verified !== '1') {
    return refusal(verifyBackup.name, done, 4, { reason: 'the backup did not read back' });
  }

  const before = await step('migrations', transport, [config.DEPLOY_PATH, projectOf(context), composeFiles], { locks, log });
  done.push(before.name);
  if (!before.ok) return refusal(before.name, done, 4);

  const ship = await step('have-images', transport, images, { locks, log });
  done.push(ship.name);
  if (!ship.ok) return refusal(ship.name, done, 4);

  const upload = await step('upload-bundle', transport, [
    config.DEPLOY_PATH, `${release}.tmp`, context.bundlePath ?? 'bundle.tar.gz',
  ], { locks, log });
  done.push(upload.name);
  if (!upload.ok) return refusal(upload.name, done, 4);

  const up = await step('up', transport, [config.DEPLOY_PATH, release, projectOf(context), composeFiles], { locks, log });
  done.push(up.name);
  if (!up.ok) return refusal(up.name, done, 5);

  if (red === 'waitHealthy') return refusal('waitHealthy', done, 5);

  const waitHealthy = await step('wait-healthy', transport, [config.FRONTEND_PORT ?? '80', '300'], { locks, log });
  done.push(waitHealthy.name);
  if (!waitHealthy.ok) return refusal(waitHealthy.name, done, 5);

  const after = await step('migrations', transport, [config.DEPLOY_PATH, projectOf(context), composeFiles], { locks, log });
  done.push(after.name);

  // The smoke is read-only and answers "is this release actually the one we shipped";
  // a red one is what the rollback answers.
  const smoke = await runSmoke(context, { url: `http://127.0.0.1:${config.FRONTEND_PORT ?? 80}` });
  done.push(smoke.name);

  if (smoke.ok) {
    const record = await step('state', transport, [config.DEPLOY_PATH, release, 'write'], { locks, log });
    done.push(record.name);
    const prune = await step('prune', transport, ['dry', '', ...images], { locks, log });
    done.push(prune.name);
    return { ok: true, steps: done, release, backupName: backup.backup_name };
  }

  // A red smoke after a deploy that migrated: the database comes back too.
  let needsDb;
  try {
    needsDb = needsDbRestore(migrationList(before.migrations), migrationList(after.migrations));
  } catch (err) {
    return { ok: false, failed: 'smoke', steps: done, exitCode: 11, reason: err.message, rollback: true };
  }
  return {
    ok: false, failed: 'smoke', steps: done, exitCode: 10,
    rollback: true, needsDbRestore: needsDb, backupName: backup.backup_name, previousRelease: release,
  };
}

/**
 * The rollback (D-10): stop the new backend, restore the database when the
 * deploy migrated, bring the previous release up, wait for it, smoke it. A red
 * smoke of the previous release is exit 11 and nothing more — never a second
 * rollback.
 *
 * @param {object} context — as `deployPlatform`, plus the failure it answers.
 * @param {string} context.previousRelease — the release record to go back to.
 * @param {string} context.backupName — the verified backup taken before the deploy.
 * @param {boolean} [context.needsDb] — whether the deploy migrated.
 * @param {boolean} [context.redPrevious] — a rehearsal's induced smoke failure.
 */
export async function rollbackRelease(context) {
  const { transport, config, previousRelease, backupName, needsDb = true, redPrevious = false } = context;
  const { locks = [], log = null } = context;
  const done = [];
  const composeFiles = composeFilesFor(context);

  const stop = await step('stop', transport, [config.DEPLOY_PATH, projectOf(context), previousRelease, composeFiles], { locks, log });
  done.push(stop.name);

  if (needsDb) {
    const restore = await step('restore-db', transport, [config.DEPLOY_PATH, backupName, projectOf(context), composeFiles], { locks, log });
    done.push(restore.name);
    if (!restore.ok) return refusal(restore.name, done, 11);
  }

  const up = await step('up', transport, [config.DEPLOY_PATH, previousRelease, projectOf(context), composeFiles], { locks, log });
  done.push(up.name);
  if (!up.ok) return refusal(up.name, done, 11);

  const waitHealthy = await step('wait-healthy', transport, [config.FRONTEND_PORT ?? '80', '300'], { locks, log });
  done.push(waitHealthy.name);
  if (!waitHealthy.ok) return refusal(waitHealthy.name, done, 11);

  const smoke = await runSmoke(context, { url: `http://127.0.0.1:${config.FRONTEND_PORT ?? 80}`, previous: true });
  done.push(smoke.name);
  if (!smoke.ok) return refusal('smoke', done, 11);
  return { ok: true, steps: done, previousRelease };
}

/** The release env a deploy writes and ships with its compose files. */
export const RELEASE_ENV = 'ops/deploy/release.env';

/**
 * The bundle manifest: the compose files the release runs with, and the release
 * env beside them. They travel together, which is why one function names both.
 */
export function bundleManifest({ editor = false, extra = [] }) {
  return { compose: releaseComposeFiles({ editor, extra }), releaseEnv: RELEASE_ENV };
}
