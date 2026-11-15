// ops/deploy/deploy.mjs
//
// The pipeline's command line (decision D-1: this is the whole entry point;
// `wk.sh deploy` is a thin wrapper around it that adds the HALT check, the
// locks and the exit-code mapping).
//
//   deploy deploy platform [--dry-run] [--env-file …] [--log-dir …]
//   deploy rollback platform [--dry-run]
//   deploy inspect platform [--dry-run] [--trust-new-host]
//
//   --transport local        run the remote scripts on this machine (the rehearsal)
//   --local-root <dir>       DEPLOY_PATH for the local transport (a temp directory)
//   --project <name>         the compose project; the rehearsal uses its own
//   --compose-file <path>    an extra compose file, repeatable (the rehearsal adds
//                            ops/deploy/compose.rehearsal.yml)
//   --bundle <path>          the release bundle tar to upload (written by writeBundle)
//   --smoke-expect-commit    (reserved) an explicit pin; the pipeline pins each release itself
//   --rehearsal              local commits are allowed (the rehearsal only)
//
// A gate refusal is exit 4 and one line naming the gate; a deploy failure that
// happened after the new images were up is 5 (rollback) or 10 (the smoke was
// red and rolled back); a rollback that could not finish is 11. Every line goes
// through the redactor, so nothing a deploy needs can reach a log.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

import { parseDeployEnv } from './lib/config.mjs';
import { makeRedactor } from './lib/redact.mjs';
import { createLogger } from './lib/log.mjs';
import { deployWindow } from './lib/window.mjs';
import { sshTransport, localTransport, dryRunTransport } from './lib/transport.mjs';
import { deployPlatform, rollbackRelease, writeBundle } from './lib/steps.mjs';
import { imageNames, tagOf, composeFiles } from './lib/release.mjs';
import { checkFreshSource } from './lib/build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VL_REPO = path.resolve(HERE, '../..');

/** The engine's own commit, as the release's tag. */
function commitOf(repo, defaultBranch = 'main') {
  return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

/**
 * Gate D-8's second refusal: the release is cut from a clean tree at its default
 * branch, so what runs in production is a commit someone can read. A dry run may
 * describe a deploy that was not pushed (it contacts nothing), so `--rehearsal`
 * and `--dry-run` skip only the HEAD comparison, never the porcelain one — which
 * is `checkFreshSource`'s own rule.
 */
function freshSourceGate(repo, { dryRun, rehearsal }) {
  const fresh = checkFreshSource(repo, 'main', { rehearsal: Boolean(rehearsal || dryRun) });
  return fresh.ok ? null : { ok: false, failed: 'fresh-source', exitCode: 4, reason: fresh.reason };
}

/** A line of arguments, `--flag value` and `--flag`, in order. */
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=');
      if (inline !== undefined) flags[key] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[key] = argv[++i];
      else flags[key] = true;
    } else positional.push(arg);
  }
  return { flags, positional };
}

/** The commit pair for this release: the platform, and the editor when asked. */
function commitsFor({ editor, repo = VL_REPO }) {
  const vl = commitOf(repo);
  const ed = editor ? commitOf(path.resolve(repo, '../WebEngineTSEditor'), 'master') : null;
  return { vl, ed };
}

/** Gate D-8's first refusal: a HALT written by any worker. */
function haltRefusal(haltFile, log) {
  if (!haltFile || !existsSync(haltFile)) return null;
  log?.warn(`HALT is present (${haltFile}) — nothing runs`);
  return { ok: false, failed: 'halt', exitCode: 4, reason: 'HALT is present' };
}

/**
 * The deploy command.
 *
 * @param {object} options — the CLI's own, injected in the tests. Everything the
 *   command line assembles (transport, project, compose list, bundle, smoke) is
 *   an option, so `main()` is a thin argument parser and this function is the one
 *   a test drives — which is what phase 5 fixed: the options were passed and
 *   then dropped, so `--transport local --project vlrehearsal` did nothing.
 */
export async function runDeploy(options) {
  const {
    argv = process.argv.slice(2),
    env = process.env,
    now = () => new Date(),
    haltFile = null,
    knownHosts = null,
    repo = null,
    transport = null,
    project = null,
    composeFiles = null,
    extra = [],
    bundlePath = null,
    smoke = null,
    smokePin = null,
    locks = [],
    logDir = null,
  } = options;

  const { flags, positional } = parseArgs(argv);
  const [command, target] = positional;
  if (!command || !target) {
    process.stderr.write('usage: deploy <deploy|rollback|inspect> <target> [--dry-run] [--env-file path]\n');
    return 2;
  }

  const envFile = flags['env-file'] ? path.resolve(String(flags['env-file'])) : null;
  const dryRun = flags['dry-run'] === true;
  const logDir_ = logDir ?? (flags['log-dir'] ? path.resolve(String(flags['log-dir'])) : null);

  let cfg;
  try {
    cfg = parseDeployEnv(await readFile(envFile, 'utf8'));
  } catch (err) {
    process.stderr.write(`deploy.env: ${err.message}\n`);
    return 2;
  }

  const redact = makeRedactor(cfg);
  const log = createLogger({ redact, dir: logDir_, command, now });
  log.info(`${command} ${target}${dryRun ? ' (dry run)' : ''}`);

  const stop = haltRefusal(haltFile, log);
  if (stop) {
    log.warn('HALT is present — nothing runs');
    return stop.exitCode;
  }

  const repoRoot = repo ?? VL_REPO;
  const stale = freshSourceGate(repoRoot, { dryRun, rehearsal: flags.rehearsal === true });
  if (stale) {
    log.warn(`${stale.reason} — push it and start again`);
    return stale.exitCode;
  }

  const runTransport = transport ?? (dryRun
    ? dryRunTransport(line => log.write(line))
    : (env.VL_TRANSPORT === 'local' ? localTransport() : sshTransport(cfg, knownHosts ?? `${env.HOME}/.ssh/known_hosts`)));

  const commits = commitsFor({ editor: flags.editor === true, repo: repoRoot });
  const images = imageNames({ vlTag: tagOf(commits.vl), edTag: commits.ed ? tagOf(commits.ed) : null })
    .map(image => image.name);

  // The release bundle: the compose files, their inputs and `release.env`, cut
  // from this commit and written outside the worktree (so a release never
  // depends on an untracked file). A dry run contacts nothing, so it writes
  // nothing.
  let bundle = bundlePath;
  if (!dryRun && !bundle) {
    try {
      bundle = writeBundle(repoRoot, {
        vlTag: tagOf(commits.vl), vlCommit: commits.vl,
        editor: flags.editor === true, extra,
        edTag: commits.ed ? tagOf(commits.ed) : null,
      }).path;
    } catch (err) {
      log.warn(`the release bundle could not be written: ${err.message}`);
      return 4;
    }
  }

  const context = {
    transport: runTransport, config: cfg, commits, images,
    locks: locks.length > 0 ? locks : (flags.locks ? String(flags.locks).split(',') : []),
    log, now, red: flags.red,
    project: project ?? (flags.project ? String(flags.project) : null),
    composeFiles: composeFiles ?? null,
    extra,
    bundlePath: bundle,
    smoke,
    // The rehearsal's induced-failure knob: pin the smoke to a commit that is not
    // the one deployed, and the red-smoke path runs on a stack that is otherwise
    // fine. A production deploy never sets it.
    smokePin: smokePin ?? (flags['smoke-expect-commit'] ? String(flags['smoke-expect-commit']) : null),
  };

  if (command === 'deploy') {
    if (!dryRun) {
      const window = deployWindow(now());
      if (!window.allowed) {
        log.warn(window.reason);
        return 4;
      }
    }
    const result = await deployPlatform(context);
    if (!result.ok) {
      // The reason is part of the refusal: a log line that names the step without
      // saying why is a line nobody can act on (OPS1 phase 5).
      log.warn(`${command} ${target} stopped at ${result.failed} (exit ${result.exitCode})`
        + `${result.reason ? `: ${result.reason}` : ''}`);
      if (result.rollback) {
        log.info('rollback: bringing the previous release back');
        const back = await rollbackRelease({ ...context, ...result });
        log.info(`rollback ${back.ok ? 'ok' : 'FAILED'} (exit ${back.exitCode ?? 0})`);
        return back.ok ? result.exitCode : back.exitCode;
      }
    }
    log.info(`${command} ${target} ${result.ok ? 'ok' : 'failed'}`);
    return result.exitCode ?? 0;
  }

  if (command === 'rollback') {
    const record = await readReleaseRecord(runTransport, cfg.DEPLOY_PATH, { locks: context.locks, log });
    if (!record.current || !record.previous) {
      log.warn(`there is nothing to roll back to: the record names ${record.current?.id ?? 'no release'}`);
      return 4;
    }
    log.info(`rollback: ${record.current.id} → ${record.previous.id}`);
    const result = await rollbackRelease({
      ...context,
      // The release it came from, and the facts the rollback needs about it: the
      // verified backup that deploy took, and whether that deploy migrated.
      previousRelease: record.previous.id,
      previousCommit: record.previous.commit,
      previousRecord: record.previous,
      backupName: record.current.backup ?? null,
      needsDb: record.current.migrated === true && Boolean(record.current.backup),
    });
    log.info(`rollback ${result.ok ? 'ok' : 'failed'} (exit ${result.exitCode ?? 0})`);
    return result.exitCode ?? 0;
  }

  log.warn(`unknown command ${command}`);
  return 2;
}

/** The remote directory, for the one script the orchestrator reads directly. */
const REMOTE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'remote');

/**
 * The release record as the host has it, for the `rollback` command: it needs the
 * release that is running (whose backup and migration fact it carries) *and* the
 * one to go back to. A host with no record has nothing to roll back.
 *
 * @param {{run: Function}} transport
 * @param {string} deployPath
 */
async function readReleaseRecord(transport, deployPath, { locks = [], log = null } = {}) {
  for (const dir of locks) {
    try { writeFileSync(`${dir}/heartbeat`, `${new Date().toISOString()} state\n`); } catch { /* a lock that vanished is the wrapper's business */ }
  }
  const answer = await transport.run(path.join(REMOTE_DIR, 'state.sh'), [deployPath, 'read']);
  if (answer.code !== 0) return { current: null, previous: null, history: [] };
  try {
    const state = JSON.parse(String(answer.stdout).trim() || 'null');
    state.history ??= [];
    return state;
  } catch {
    log?.warn('the release record is not readable — nothing to roll back to');
    return { current: null, previous: null, history: [] };
  }
}

/**
 * The smoke as the deployed stack is asked to prove itself: the Phase 3 suite, read-only,
 * against the live URL, with the commit pinned.
 *
 * `SMOKE_EXPECT_COMMIT` is what turns a wrong release red: the stack would otherwise answer
 * "healthy" while running the previous images, which is the failure a rollback must catch.
 * The caller says *which* commit must answer, because a rollback smokes a different release
 * than the deploy it undoes — pinning nothing there would pass the very failure the smoke
 * exists to catch (OPS1 phase 5).
 *
 * @param {string} e2eDir — the worktree's `e2e/`.
 * @param {string} url — the deployed base URL.
 * @returns {({expectedCommit: string}) => Promise<{ok: boolean, stdout: string}>}
 */
export function smokeRunner(e2eDir, url) {
  return async ({ expectedCommit = '' } = {}) => {
    const env = {
      ...process.env,
      E2E_BASE_URL: url,
      SMOKE_EXPECT_COMMIT: expectedCommit,
    };
    const run = spawnSync('npm', ['run', 'smoke'], { cwd: e2eDir, env, encoding: 'utf8' });
    const stdout = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
    return { ok: run.status === 0, stdout };
  };
}

/**
 * The command line. `rehearse.mjs` and `wk.sh deploy` drive `runDeploy` directly; this is
 * what a human runs.
 *
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<number>} the exit code.
 */
export async function main(argv = process.argv.slice(2), env = process.env) {
  const { flags, positional } = parseArgs(argv);
  const [command, target] = positional;
  if (!command || !target) {
    process.stderr.write(USAGE);
    return 2;
  }

  const dryRun = flags['dry-run'] === true;
  const kind = flags.transport ?? env.VL_TRANSPORT ?? 'ssh';
  // Not resolved: the rehearsal hands this flag in the POSIX form its scripts need,
  // and `path.resolve` on this machine would turn `/c/Users/…` into `C:\c\Users\…` —
  // which is what made `up` fail with "couldn't find env file" (OPS1 phase 5).
  const localRoot = flags['local-root'] ? String(flags['local-root']) : null;
  const project = flags.project ? String(flags.project) : 'virtual-lab';
  const repo = flags.repo ? path.resolve(String(flags.repo)) : null;
  const haltFile = flags.halt ? path.resolve(String(flags.halt)) : null;
  const logDir = flags['log-dir'] ? path.resolve(String(flags['log-dir'])) : null;
  const locks = flags.locks ? String(flags.locks).split(',') : [];
  const extras = [];
  for (const value of Array.isArray(flags['compose-file']) ? flags['compose-file'] : [flags['compose-file']]) {
    if (value) extras.push(String(value));
  }

  const envFile = flags['env-file'] ? path.resolve(String(flags['env-file'])) : null;
  if (!envFile) {
    process.stderr.write('deploy: --env-file is required\n');
    return 2;
  }

  let cfg;
  try {
    cfg = parseDeployEnv(await readFile(envFile, 'utf8'));
  } catch (err) {
    process.stderr.write(`deploy.env: ${err.message}\n`);
    return 2;
  }

  // The rehearsal's root: the same scripts with the same arguments, run here, so
  // every script sees `--local-root` as its DEPLOY_PATH. Parsed here and then
  // dropped was the first form of that flag (OPS1 phase 5), and nothing about it
  // was provable until it moved this line.
  if (localRoot && (kind === 'local' || env.VL_TRANSPORT === 'local')) {
    cfg = { ...cfg, DEPLOY_PATH: localRoot };
  }

  const transport = dryRun
    ? dryRunTransport(line => process.stdout.write(`${line}\n`))
    : (kind === 'local' ? localTransport() : sshTransport(cfg, String(flags['known-hosts'] ?? `${env.HOME}/.ssh/known_hosts`)));

  const repoRoot = repo ?? VL_REPO;
  const e2eDir = path.resolve(repoRoot, 'e2e');

  return runDeploy({
    argv,
    env,
    haltFile,
    logDir,
    repo: repoRoot,
    locks,
    transport,
    project,
    // The compose list is derived from the release and the extras the caller
    // added (`--compose-file`, repeatable) — never passed in pre-joined, because
    // the separator belongs to the host the scripts run on.
    composeFiles: null,
    extra: extras,
    bundlePath: flags.bundle ? path.resolve(String(flags.bundle)) : null,
    smoke: smokeRunner(e2eDir, `http://127.0.0.1:${cfg.FRONTEND_PORT ?? 80}`),
  });
}

const USAGE = 'usage: deploy <deploy|rollback|inspect> <target> [--dry-run]\n'
  + '                [--env-file path] [--log-dir dir] [--transport local|ssh]\n'
  + '                [--local-root dir] [--project name] [--compose-file path]\n'
  + '                [--bundle path] [--smoke-expect-commit sha] [--rehearsal]\n';

// Run as a command when this file is the entry point.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().then(code => process.exit(code)).catch(err => {
    process.stderr.write(`deploy: ${err.message}\n`);
    process.exit(1);
  });
}
