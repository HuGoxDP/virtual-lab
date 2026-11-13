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
// A gate refusal is exit 4 and one line naming the gate; a deploy failure that
// happened after the new images were up is 5 (rollback) or 10 (the smoke was
// red and rolled back); a rollback that could not finish is 11. Every line goes
// through the redactor, so nothing a deploy needs can reach a log.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { parseDeployEnv } from './lib/config.mjs';
import { makeRedactor } from './lib/redact.mjs';
import { createLogger } from './lib/log.mjs';
import { deployWindow } from './lib/window.mjs';
import { sshTransport, localTransport, dryRunTransport } from './lib/transport.mjs';
import { deployPlatform, rollbackRelease } from './lib/steps.mjs';
import { imageNames, tagOf } from './lib/release.mjs';
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
 * @param {object} options — the CLI's own, injected in the tests.
 */
export async function runDeploy(options) {
  const {
    argv = process.argv.slice(2),
    env = process.env,
    now = () => new Date(),
    haltFile = null,
    knownHosts = null,
    repo = null,
  } = options;

  const { flags, positional } = parseArgs(argv);
  const [command, target] = positional;
  if (!command || !target) {
    process.stderr.write('usage: deploy <deploy|rollback|inspect> <target> [--dry-run] [--env-file path]\n');
    return 2;
  }

  const envFile = flags['env-file'] ? path.resolve(String(flags['env-file'])) : null;
  const dryRun = flags['dry-run'] === true;
  const logDir = flags['log-dir'] ? path.resolve(String(flags['log-dir'])) : null;

  let cfg;
  try {
    cfg = parseDeployEnv(await readFile(envFile, 'utf8'));
  } catch (err) {
    process.stderr.write(`deploy.env: ${err.message}\n`);
    return 2;
  }

  const redact = makeRedactor(cfg);
  const log = createLogger({ redact, dir: logDir, command, now });
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

  const transport = dryRun
    ? dryRunTransport(line => log.write(line))
    : (env.VL_TRANSPORT === 'local' ? localTransport() : sshTransport(cfg, knownHosts ?? `${env.HOME}/.ssh/known_hosts`));

  const commits = commitsFor({ editor: flags.editor === true, repo: repoRoot });
  const images = imageNames({ vlTag: tagOf(commits.vl), edTag: commits.ed ? tagOf(commits.ed) : null })
    .map(image => image.name);

  const context = {
    transport, config: cfg, commits, images,
    locks: (flags.locks ? String(flags.locks).split(',') : []),
    log, now, red: flags.red,
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
      log.warn(`${command} ${target} stopped at ${result.failed} (exit ${result.exitCode})`);
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
    const result = await rollbackRelease(context);
    log.info(`rollback ${result.ok ? 'ok' : 'failed'} (exit ${result.exitCode ?? 0})`);
    return result.exitCode ?? 0;
  }

  log.warn(`unknown command ${command}`);
  return 2;
}
