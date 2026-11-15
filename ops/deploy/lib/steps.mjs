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

import { createReadStream, existsSync, writeFileSync, mkdirSync, mkdtempSync, cpSync, rmSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createGzip } from 'node:zlib';
import { Readable } from 'node:stream';

import { deployWindow } from './window.mjs';
import { needsDbRestore } from './rollback.mjs';
import { composeFiles as releaseComposeFiles, releaseId, bundleFiles, nextState, keepTags, tagOf } from './release.mjs';
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
  // What the step answered, not only whether: `prepare → ok` without `env=created`
  // is how a fresh install can look fine and still have no `.env` (OPS1 phase 5).
  const said = Object.keys(fields)
    .filter(key => key !== `${name}_ok` && !key.endsWith('_ok'))
    .map(key => `${key}=${fields[key]}`)
    .join(' ');
  log?.info(`${name} → ${answer.code === 0 ? 'ok' : 'EXIT ' + answer.code}${said ? ` (${said})` : ''}`);
  // A failing step's stderr is the answer: `up → EXIT 1` without the compose error
  // under it is a line nobody can act on (OPS1 phase 5).
  if (answer.code !== 0 && answer.stderr?.trim()) log?.warn(`  ${answer.stderr.trim()}`);
  // The raw answer stays on the result: `state.sh` answers JSON, not fields.
  return { name, ...fields, stdout: answer.stdout, code: answer.code, ok: answer.code === 0 };
}

/** A refusal: which gate refused, what to say, and the exit code to answer. */
const refusal = (failed, steps, exitCode, extra = {}) => ({
  ok: false, failed, steps, exitCode, ...extra,
});

/**
 * The release env, written beside the compose files: the tag and the commit this
 * release runs, and the editor's tag when it ships. No secret — and no
 * `COMPOSE_FILE`, which is the *deploy's* list and not the release's: an env file
 * that names one overrides the list the script passes on the command line, and
 * the stack then reads a path that is not a compose file (OPS1 phase 5 — the
 * rehearsal's `up` step failed on exactly that).
 */
export function releaseEnvContents({ vlTag, vlCommit, edTag = null }) {
  const lines = [`VL_TAG=${vlTag}`, `VL_COMMIT=${vlCommit}`];
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
  // A work directory of its own: the tar is written with a *relative* name beside
  // its stage and then moved, and it must not be a sibling of the destination —
  // writing it into the same directory the destination lives in made the
  // `finally` below delete the bundle it had just made (OPS1 phase 5).
  const work = mkdtempSync(path.join(os.tmpdir(), 'vl-bundle-work-'));
  const stage = path.join(work, 'stage');
  mkdirSync(stage, { recursive: true });
  try {
    for (const file of files) {
      const from = path.join(repoRoot, file);
      const to = path.join(stage, file);
      mkdirSync(path.dirname(to), { recursive: true });
      cpSync(from, to);
    }
    writeFileSync(path.join(stage, 'release.env'),
      releaseEnvContents({ ...release }));
    const target = out ?? path.join(os.tmpdir(), `vl-bundle-${release.vlTag.slice(0, 8)}.tar.gz`);
    // A *relative* archive name beside the stage, then a move: this machine's
    // `tar` (bsdtar) reads a `C:\…` argument as a remote host and exits 128
    // before writing anything, and `-C <drive path>` is the same failure. The
    // Linux host the production deploy runs on accepts either form, so this is
    // the shape that works on both (OPS1 phase 5).
    const archive = `vl-bundle-${release.vlTag.slice(0, 8)}.tar.gz`;
    const tar = spawnSync('tar', ['-czf', `../${archive}`, '.'], {
      cwd: stage, stdio: ['ignore', 'ignore', 'inherit'],
    });
    if (tar.status !== 0) throw new Error(`tar of the release bundle exited ${tar.status}`);
    renameSync(path.join(work, archive), target);
    return { path: target, files };
  } finally {
    rmSync(work, { recursive: true, force: true });
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

/**
 * A file opened for a transport that streams it.
 *
 * `createReadStream` opens the file asynchronously, so a bundle that is missing
 * or unreadable surfaces as an `error` event on a stream that may already have
 * been handed over — and an unhandled `error` takes the process down. A deploy
 * that crashes on a file it cannot read is worse than one that refuses the step,
 * so the error is handled here: the stream ends, the step fails, and the run
 * stops where it stands instead of dying mid-deploy.
 *
 * @param {string} file
 * @returns {import('node:fs').ReadStream}
 */
function readStreamOf(file) {
  const stream = createReadStream(file);
  stream.on('error', () => stream.destroy());
  return stream;
}

/** The release record as the host has it: what is current, what to go back to. */
async function readState(transport, deployPath, { locks = [], log = null } = {}) {
  await beat(locks, 'state');
  const answer = await transport.run(script('state'), [deployPath, 'read']);
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
  const answer = await transport.run(script('state'), [
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
 * `save` is injected so a test can prove the plumbing — which images are shipped,
 * what command they travel through — without a local Docker holding them.
 *
 * @param {string[]} missing — the image names to ship.
 * @param {{pipeIn: Function}} transport
 * @param {(name: string) => Promise<Readable>} [save]
 */
function shipImages(missing, transport, { save = defaultSave } = {}) {
  return Promise.all(missing.map(async name => {
    let stream;
    try {
      stream = await save(name);
    } catch (err) {
      return { name, code: 1, stderr: String(err.message ?? err) };
    }
    const answer = await transport.pipeIn(stream, 'gunzip | docker load');
    return { name, code: answer.code, stderr: '' };
  }));
}

/**
 * The real ship: `docker save` on this side, gzipped. A name the local Docker
 * does not have rejects, and the daemon's message is carried to the refusal —
 * "which image was missing" is the one thing a refusal has to say.
 */
function defaultSave(name) {
  return new Promise((resolve, reject) => {
    const stderr = [];
    const child = spawn('docker', ['save', name], { stdio: ['pipe', 'pipe', 'pipe'] });
    const gz = createGzip();
    const chunks = [];
    gz.on('data', chunk => chunks.push(chunk));
    gz.on('error', () => reject(new Error(`gzip of ${name} failed`)));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(Buffer.concat(stderr).toString('utf8').trim()
        || `docker save ${name} exited ${code}`));
    });
    gz.on('end', () => resolve(Readable.from(chunks)));
    child.stdout.pipe(gz);
    child.stderr.on('data', chunk => stderr.push(chunk));
  });
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
  // A dry run contacts nothing, so the steps that would move bytes (the image ship
  // and the bundle upload) are *described* instead of performed — the one thing a
  // dry run can do for them.
  const dry = transport.kind === 'dry-run';
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

  const inspect = await step('inspect', transport, [config.DEPLOY_PATH], { locks, log });
  done.push(inspect.name);
  if (!inspect.ok) return refusal(inspect.name, done, 4);

  // A fresh install is the *host's* answer, not the record the pipeline keeps for
  // itself: a hand-made deployment (or a release someone brought up by hand) has no
  // record and is still a host that already runs something, with a database worth
  // backing up (OPS1 phase 5 — the first rehearsal treated such a host as fresh
  // and never took a backup).
  const fresh = !inspect.current || inspect.current === 'none';
  // The release to go *back to* is the one that was running before, which the
  // record names — and, when the record is empty but the host is running one, the
  // host's own `releases/current`.
  const current = before.state?.current
    ?? (fresh ? null : { id: inspect.current, commit: '' });

  const ship = await step('have-images', transport, images, { locks, log });
  done.push(ship.name);
  if (!ship.ok) return refusal(ship.name, done, 4);
  const missing = images.filter((name, i) => ship[`image_${i}_have`] !== 'true');
  if (missing.length > 0) {
    if (dry) {
      // A dry run describes the ship it would make: the images are the host's to
      // have, and this machine's Docker is not the host's (it contacts nothing).
      log?.info(`ship → would ship ${missing.join(', ')} through gunzip | docker load`);
    } else {
      // The worker ships what the host lacks; a release is images plus a compose
      // list, and neither half alone is a release (decision D-2).
      const shipped = await shipImages(missing, transport, { save: context.save });
      done.push('ship');
      const failed = shipped.find(part => part.code !== 0);
      if (failed) {
        return refusal('ship', done, 4, {
          reason: `shipping ${failed.name} failed: ${failed.stderr?.trim() || `docker save exited ${failed.code}`}`,
        });
      }
    }
  }

  // The bundle is the release: if it was never written, there is nothing to
  // upload and no release to name afterwards — a refusal here, not a crash on a
  // stream that cannot be opened. A dry run has nothing on disk to stream, so it
  // *describes* the upload instead (the one step it cannot perform for real).
  const bundlePath = context.bundlePath;
  if (!dry && (!bundlePath || !existsSync(bundlePath))) {
    return refusal('upload-bundle', done, 4, { reason: 'the release bundle is missing' });
  }

  const upload = await transport.pipeIn(
    dry ? Readable.from([]) : readStreamOf(bundlePath),
    context.uploadCommand ?? UPLOAD_BUNDLE_COMMAND,
    // A POSIX join on a POSIX base: `path.join` on a Windows host uses `\`, which
    // turns `C:/Users/…` into `C:/Users/…\releases` — a path with two separators,
    // which is what made the rehearsal's upload answer exit 2 (OPS1 phase 5). On
    // the Linux host both joins are the same thing.
    [path.posix.join(config.DEPLOY_PATH, 'releases'), release],
  );
  done.push('upload-bundle');
  log?.info(`upload-bundle → ${upload.code === 0 ? 'ok' : 'EXIT ' + upload.code}`);
  if (upload.code !== 0) {
    // The script's own stderr is the answer: a bundle upload that fails with a
    // bare exit code is a refusal nobody can act on.
    return refusal('upload-bundle', done, 4, {
      reason: `unpacking the bundle failed: ${String(upload.stderr ?? '').trim() || `exit ${upload.code}`}`,
    });
  }

  // `prepare` runs *after* the upload, because a fresh host has no `.env` and the
  // template that makes one travels in the bundle: generating it before the upload
  // could only ever answer `env=absent`, which is how the rehearsal's first run
  // failed (OPS1 phase 5). It never overwrites an existing one (D-12).
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

  // `up` is the last step that can fail with the running release untouched:
  // everything after it has already replaced the stack, so a failure there is a
  // rollback (exit 10 when the rollback works, 11 when it does not — the wrapper
  // maps them for a human). Exit 5 is "failed before up" and nothing else.
  const up = await step('up', transport, [config.DEPLOY_PATH, release, projectOf(context), composeFiles], { locks, log });
  done.push(up.name);
  if (!up.ok) return refusal(up.name, done, 5);

  const waitHealthy = await step('wait-healthy', transport, [config.FRONTEND_PORT ?? '80', '300'], { locks, log });
  done.push(waitHealthy.name);

  // Whether the database may have changed under this deploy. The "after" read is
  // compared against the one before (D-10); a stack that never became healthy
  // never answers it — the backend applies migrations at start and it may have
  // applied some before it died — so there the answer is "it may have", and the
  // database comes back. A `needsDbRestore` that throws (a migration set that
  // shrank, which forward-only migrations cannot do) is not a deploy worth
  // trusting either: no rollback, exit 11, the reason named.
  let migrated = false;
  let migrationFailure = null;
  if (waitHealthy.ok) {
    try {
      const after = await step('migrations', transport, [config.DEPLOY_PATH, projectOf(context), composeFiles], { locks, log });
      done.push(after.name);
      if (!fresh) migrated = needsDbRestore(migrationList(beforeMigrations.migrations), migrationList(after.migrations));
    } catch (err) {
      migrationFailure = err.message;
    }
  }
  const mayHaveMigrated = fresh ? false : (waitHealthy.ok ? migrated : true);

  // The smoke is read-only and answers "is this release actually the one we shipped";
  // a red one is what the rollback answers. A stack that never answered is a red
  // stack, so the same hand-off applies.
  const smoke = waitHealthy.ok
    ? await runSmoke(context, {
      url: `http://127.0.0.1:${config.FRONTEND_PORT ?? '80'}`,
      // The commit that must answer. `--smoke-expect-commit` overrides it, which
      // is how a rehearsal induces a red smoke on a stack that is otherwise fine
      // — and the override is the rehearsal's, never a production deploy's.
      expectedCommit: context.smokePin ?? commits.vl,
    })
    : { name: 'smoke', ok: false, code: 1 };
  done.push(smoke.name);

  if (smoke.ok) {
    await writeState(transport, config.DEPLOY_PATH, {
      id: release, tag: tagOf(commits.vl), commit: commits.vl, migrated, backup: backup.backup_name ?? null,
    }, { locks, log });
    done.push('state(write)');
    const state = nextState(before.state ?? { current: null, previous: null, history: [] }, {
      id: release, tag: tagOf(commits.vl), commit: commits.vl, migrated, backup: backup.backup_name ?? null,
    });
    const prune = await step('prune', transport, ['dry', keepTags(state).join(','), ...images], { locks, log });
    done.push(prune.name);
    return { ok: true, steps: done, release, backupName: backup.backup_name ?? null, migrated };
  }

  // A migration set that shrank is not a deploy worth trusting: forward-only
  // migrations cannot lose one, so the schema went somewhere this run does not
  // know about. The database comes back from the verified backup and the exit is
  // 11 — the rollback worked, the deploy did not (DW-4.2).
  if (migrationFailure) {
    return {
      ok: false, failed: 'migrations', steps: done, exitCode: 11,
      reason: migrationFailure, rollback: true,
      // `needsDb`, the name `rollbackRelease` reads: a differently-named field
      // there defaulted the rollback to `true` and restored a database that was
      // never backed up (OPS1 phase 5).
      needsDb: Boolean(backup.backup_name),
      backupName: backup.backup_name ?? null,
      previousRelease: current?.id ?? null,
      previousCommit: current?.commit ?? null,
      fresh,
    };
  }

  // The database comes back only when there is a verified backup to come back
  // from: a fresh install has nothing older to return to, and a deploy that did
  // not migrate left the schema alone (D-10).
  return {
    ok: false, failed: waitHealthy.ok ? 'smoke' : 'wait-healthy', steps: done, exitCode: 10,
    rollback: true,
    needsDb: mayHaveMigrated && Boolean(backup.backup_name),
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

  // Nothing to go back to — a fresh install's red smoke, or a host whose record
  // is empty. The new stack is stopped (above) and the rollback finishes: an
  // empty target would otherwise run `up` with an empty release id and answer
  // "couldn't find env file …/releases/release.env", which is a failure nobody
  // asked for (OPS1 phase 5).
  if (!previousRelease) {
    log?.warn('there is no release to roll back to — the new stack is stopped');
    return { ok: true, steps: done, previousRelease: null, nothing: true };
  }

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