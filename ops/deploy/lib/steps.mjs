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

import { createReadStream, existsSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createGzip } from 'node:zlib';
import { Readable } from 'node:stream';

import { deployWindow } from './window.mjs';
import { needsDbRestore } from './rollback.mjs';
import { composeFiles as releaseComposeFiles, releaseId, bundleFiles, nextState, keepForPrune, tagOf } from './release.mjs';
import { UPLOAD_BUNDLE_COMMAND } from './transport.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REMOTE = path.resolve(HERE, '../remote');

/** The remote script for a step, by name. */
const script = name => path.join(REMOTE, `${name}.sh`);

/** The compose project a release runs under; the rehearsal uses its own. */
export const projectOf = context => context.project ?? 'virtual-lab';

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
  // The raw answer stays on the result: `state.sh` answers JSON, not fields.
  return { name, ...fields, stdout: answer.stdout, code: answer.code, ok: answer.code === 0 };
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
 * A rollback smokes the release it came back to, which is a *different* commit — so the
 * caller says which commit must answer, and a stack running the wrong one is red.
 *
 * @param {{smoke?: Function, red?: string, log?: object}} context
 * @param {{url: string, expectedCommit: string}} options
 */
async function runSmoke(context, { url, expectedCommit }) {
  const { smoke } = context;
  if (!smoke) return { name: 'smoke', ok: context.red !== 'smoke' && !context.redPrevious };
  const answer = await smoke({ expectedCommit, url });
  if (answer.stdout) context.log?.info(`[smoke] ${answer.stdout.split('\n').slice(-3).join(' | ')}`);
  return { name: 'smoke', ok: answer.ok !== false, code: answer.ok ? 0 : 1 };
}

/**
 * The compose file list for a release, as the single string every compose-touching
 * script receives.
 *
 * Two rules, both learned by trying to pass the list as it stands (OPS1 phase 5):
 * `COMPOSE_FILE` only accepts compose files (`db/init.sql` travels in the bundle but
 * is not a `-f` argument), and it is split on the *OS* separator (`;` on Windows, `:`
 * on Linux) — a comma-joined list is one long path that does not exist on any host. The
 * separator belongs to the transport: only it knows where the script runs.
 *
 * @param {{transport: object, composeFiles?: string[]|string, extra?: string[], editor?: boolean}} context
 * @returns {string} the `-f` list, in order, joined for `COMPOSE_FILE`.
 */
export function composeFilesFor(context) {
  const files = context.composeFiles ?? releaseComposeFiles({ editor: context.editor === true, extra: context.extra ?? [] });
  const list = (Array.isArray(files) ? files : String(files).split(','))
    .filter(file => file.trim() !== '')
    .map(file => file.trim());
  const separator = context.transport?.listSeparator ?? ':';
  // An override wins as given: a caller that passes its own list has already
  // filtered it, and second-guessing it would drop a file it meant to add.
  return (context.composeFiles ? list : list.filter(file => /\.ya?ml$/.test(file))).join(separator);
}

/** The release record as the host has it: what is current, what to go back to. */
async function readState(transport, deployPath, { locks = [], log = null } = {}) {
  await beat(locks, 'state');
  const answer = await transport.run(script('state.sh'), [deployPath, 'read']);
  if (answer.code !== 0) {
    log?.warn('state.sh read failed — the release record is unreadable');
    return { ok: false, state: null };
  }
  try {
    return { ok: true, state: JSON.parse(String(answer.stdout).trim() || 'null') };
  } catch {
    log?.warn('state.sh read answered something that is not the release record');
    return { ok: false, state: null };
  }
}

/** Writes the release record: what is running now, and what to go back to. */
async function writeState(transport, deployPath, record, { locks = [], log = null } = {}) {
  await beat(locks, 'state');
  const answer = await transport.run(script('state.sh'), [
    deployPath, 'write', record.id, record.tag ?? '', record.commit,
    String(record.migrated === true), record.backup ?? '',
  ]);
  log?.info(`state write → ${answer.code === 0 ? 'ok' : 'EXIT ' + answer.code}`);
  return answer.code === 0;
}

/**
 * Ships the images the host does not have (decision D-2): `docker save` here,
 * gzipped, piped into the host's `docker load`. No registry is involved, so a
 * release can be pulled back out of a cache nobody controls.
 *
 * @param {string[]} missing — the image names to ship.
 * @param {{pipeIn: Function}} transport
 */
function shipImages(missing, transport) {
  return Promise.all(missing.map(name => new Promise((resolve, reject) => {
    const child = spawn('docker', ['save', name], { stdio: ['pipe', 'pipe', 'pipe'] });
    const gz = createGzip();
    const chunks = [];
    gz.on('data', chunk => chunks.push(chunk));
    gz.on('end', () => {
      transport.pipeIn(Readable.from(chunks), 'gunzip | docker load')
        .then(answer => resolve({ name, code: answer.code }), reject);
    });
    gz.on('error', reject);
    child.on('error', reject);
    child.stdout.pipe(gz);
    child.stderr.on('data', () => {});
  })));
}

/**
 * The deploy sequence.
 *
 * A host that has never run a release (no `releases/` record) is a *fresh install*:
 * there is no stack to back up, so `backup`, `verify-backup` and the migration read
 * before the deploy are skipped and the record says `backup: none`. A rollback of a
 * fresh install has no database to restore, which is why `needsDbRestore` also asks
 * whether a backup exists — the two facts together, never either alone (D-10).
 *
 * @param {object} context
 * @param {{run: Function, pipeIn: Function, listSeparator: string}} context.transport
 * @param {object} context.config — the parsed deploy configuration.
 * @param {{vl: string, ed: string|null}} context.commits
 * @param {string[]} context.images — the images the release is made of.
 * @param {string[]} context.locks — lock directories to beat (D-7).
 * @param {string} [context.bundlePath] — the release bundle tar, written by `writeBundle`.
 * @param {Function} [context.smoke] — `({expectedCommit, url}) => {ok, stdout}`.
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
  const before = await readState(transport, config.DEPLOY_PATH, { locks, log });
  done.push('state(read)');
  const current = before.state?.current ?? null;
  const fresh = !current;

  const inspect = await step('inspect', transport, [config.DEPLOY_PATH], { locks, log });
  done.push(inspect.name);
  if (!inspect.ok) return refusal(inspect.name, done, 4);

  const prepare = await step('prepare', transport, [config.DEPLOY_PATH], { locks, log });
  done.push(prepare.name);
  if (!prepare.ok) return refusal(prepare.name, done, 4);

  // A fresh install has nothing to back up and no migration set to compare
  // against; an existing one is backed up before anything changes (D-9).
  const backup = fresh
    ? { name: 'backup', ok: true, backup_name: null, fresh: true }
    : await step('backup', transport, [config.DEPLOY_PATH, projectOf(context), composeFiles], { locks, log });
  if (!fresh) {
    done.push(backup.name);
    if (!backup.ok) return refusal(backup.name, done, 4);
  }

  const verifyBackup = fresh
    ? { name: 'verify-backup', ok: true, verified: '1', fresh: true }
    : await step('verify-backup', transport, [backup.backup_path], { locks, log });
  if (!fresh) {
    done.push(verifyBackup.name);
    if (!verifyBackup.ok || verifyBackup.verified !== '1') {
      return refusal(verifyBackup.name, done, 4, { reason: 'the backup did not read back' });
    }
  }

  const beforeMigrations = fresh
    ? { name: 'migrations', migrations: '', fresh: true }
    : await step('migrations', transport, [config.DEPLOY_PATH, projectOf(context), composeFiles], { locks, log });
  if (!fresh) {
    done.push(beforeMigrations.name);
    if (!beforeMigrations.ok) return refusal(beforeMigrations.name, done, 4);
  }

  const ship = await step('have-images', transport, images, { locks, log });
  done.push(ship.name);
  if (!ship.ok) return refusal(ship.name, done, 4);
  const missing = images.filter((name, i) => ship[`image_${i}_have`] !== 'true');
  if (missing.length > 0) {
    // The worker ships what the host lacks; a release is images plus a compose
    // list, and neither half alone is a release (decision D-2).
    const shipped = await shipImages(missing, transport);
    done.push('ship');
    const failed = shipped.find(part => part.code !== 0);
    if (failed) return refusal('ship', done, 4, { reason: `shipping ${failed.name} failed` });
  }

  // The bundle is the release: if it was never written, there is nothing to
  // upload and no release to name afterwards — a refusal here, not a crash on a
  // stream that cannot be opened.
  const bundlePath = context.bundlePath;
  if (!bundlePath || !existsSync(bundlePath)) {
    return refusal('upload-bundle', done, 4, { reason: 'the release bundle is missing' });
  }

  const upload = await transport.pipeIn(
    createReadStream(bundlePath),
    context.uploadCommand ?? UPLOAD_BUNDLE_COMMAND,
    [path.join(config.DEPLOY_PATH, 'releases'), release],
  );
  done.push('upload-bundle');
  log?.info(`upload-bundle → ${upload.code === 0 ? 'ok' : 'EXIT ' + upload.code}`);
  if (upload.code !== 0) return refusal('upload-bundle', done, 4);

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
  const smoke = await runSmoke(context, { url: `http://127.0.0.1:${config.FRONTEND_PORT ?? '80'}`, expectedCommit: commits.vl });
  done.push(smoke.name);

  let migrated = false;
  if (!fresh) {
    try {
      migrated = needsDbRestore(migrationList(beforeMigrations.migrations), migrationList(after.migrations));
    } catch (err) {
      return { ok: false, failed: 'smoke', steps: done, exitCode: 11, reason: err.message, rollback: true };
    }
  }

  if (smoke.ok) {
    await writeState(transport, config.DEPLOY_PATH, {
      id: release, tag: tagOf(commits.vl), commit: commits.vl, migrated, backup: backup.backup_name ?? null,
    }, { locks, log });
    done.push('state(write)');
    const state = nextState(before.state ?? { current: null, previous: null, history: [] }, {
      id: release, tag: tagOf(commits.vl), commit: commits.vl, migrated, backup: backup.backup_name ?? null,
    });
    const prune = await step('prune', transport, ['dry', keepForPrune(state).join(','), ...images], { locks, log });
    done.push(prune.name);
    return { ok: true, steps: done, release, backupName: backup.backup_name ?? null, migrated };
  }

  // A red smoke after a deploy that migrated: the database comes back too, but
  // only when there is a verified backup to come back from — a fresh install has
  // nothing older to return to.
  return {
    ok: false, failed: 'smoke', steps: done, exitCode: 10,
    rollback: true,
    needsDbRestore: migrated && !fresh && Boolean(backup.backup_name),
    backupName: backup.backup_name ?? null,
    // The release to go *back to* is the one that was running before, not the one
    // that just failed: `previous` in the record, never the release we deployed.
    previousRelease: current?.id ?? null,
    previousCommit: current?.commit ?? null,
    fresh,
  };
}

/**
 * The rollback (D-10): stop the new backend, restore the database when the
 * deploy migrated, bring the previous release up, wait for it, smoke it. A red
 * smoke of the previous release is exit 11 and nothing more — never a second
 * rollback.
 *
 * The record is written after a successful rollback: without it the next one
 * would go back to the release that just failed, which is the bug this step
 * exists to prevent.
 *
 * @param {object} context — as `deployPlatform`, plus the target.
 * @param {string} context.previousRelease — the release record id to go back to.
 * @param {string} [context.previousCommit] — the commit that must answer after it.
 * @param {string} [context.backupName] — the verified backup taken before the deploy.
 * @param {boolean} [context.needsDb] — whether the deploy migrated.
 * @param {boolean} [context.redPrevious] — a rehearsal's induced smoke failure.
 */
export async function rollbackRelease(context) {
  const {
    transport, config, previousRelease, previousCommit, backupName, needsDb = true,
    redPrevious = false, locks = [], log = null,
  } = context;
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

  const smoke = await runSmoke(context, {
    url: `http://127.0.0.1:${config.FRONTEND_PORT ?? '80'}`, expectedCommit: previousCommit,
  });
  done.push(smoke.name);
  if (!smoke.ok) return refusal('smoke', done, 11);

  // The stack is running the previous release again, so that is what the record
  // must say — a rollback that left the record pointing at the failed release
  // would roll the next one back into the same failure.
  if (previousRelease) {
    const target = context.previousRecord ?? { id: previousRelease, commit: previousCommit ?? '' };
    await writeState(transport, config.DEPLOY_PATH, {
      id: target.id, tag: target.tag ?? '', commit: target.commit ?? '',
      // The database was just restored, so the release running now did not
      // migrate forward from here.
      migrated: false, backup: backupName ?? null,
    }, { locks, log });
    done.push('state(write)');
  }
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