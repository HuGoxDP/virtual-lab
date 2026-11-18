#!/usr/bin/env node
// scripts/selfhost-check.mjs
//
// `npm run selfhost-check` — does a clean clone of this repo come up and work?
//
// The university downloads the repo, builds it with Docker and runs it (there is
// no production access, no deploy pipeline: HO1). This is the local proof of
// exactly that: clone the default branch into a temp dir, write the `.env` a
// first-time admin is told to write, `up -d --build` on a renamed stack, wait
// until the platform answers, take and verify one backup, run the e2e smoke,
// tear everything down.
//
// Two rules it does not break:
//   * it never touches a stack that is already running (renamed project,
//     volumes and containers — see docker-compose.selfcheck.yml — and a port of
//     its own);
//   * it refuses to run without the workflow lock directory it is handed
//     (`--lock <dir>`), because a check that fights the lab stack on 8044 or the
//     Docker Postgres on 55432 is the failure mode the lock exists for.
//
// Every step prints one line: `step=<n> <name> ok=1|0 [detail]`. A failure is
// named, not thrown as a stack trace, and the exit code is non-zero.

import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { newestBackup, verifyBackup, VERIFIED_MARKER } from './lib/verify-backup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

/** Default spare port: 8044/8045 are the lab stack, 8046 the editor-csp harness, 8047/8049 the OPS1 rehearsal, 3998 scratch TLS. */
export const DEFAULT_PORT = 8051;
export const PROJECT = 'vl-selfcheck';

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.selfcheck.yml'];

const USAGE = `Usage: npm run selfhost-check -- [options]

Clones a branch of this repo into a temp directory, builds and starts it with
Docker Compose on a spare port, waits until it is healthy, takes and verifies one
backup, runs the e2e smoke against it, then tears it down.

  --ref <name>           git ref to clone (default: main)
  --source <dir|url>     clone source (default: this checkout)
  --frontend-port <n>    host port for the check's stack (default: ${DEFAULT_PORT})
  --lock <dir>           required: a held lock directory, e.g. .workers/locks/vl-db.lock
  --keep                 leave the temp clone and its stack on disk for inspection
  --help                 this text

The lock is the caller's job: bash .workers/wk.sh lock vl-db W<n> HO1
`;

/**
 * Flag parsing, deliberately literal: an unknown flag is a refusal, not a
 * silently ignored typo, because a mistyped `--lock` would otherwise read as
 * "no lock required".
 *
 * @param {string[]} argv
 * @returns {{ref: string, source: string|null, port: number, lock: string|null, keep: boolean, help: boolean}}
 */
export function parseArgs(argv) {
  const out = { ref: 'main', source: null, port: DEFAULT_PORT, lock: null, keep: false, help: false };
  const need = (flag, i) => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--keep') out.keep = true;
    else if (arg === '--ref') { out.ref = need(arg, i); i += 1; }
    else if (arg === '--source') { out.source = need(arg, i); i += 1; }
    else if (arg === '--frontend-port') {
      const value = need(arg, i); i += 1;
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--frontend-port must be a port number, got "${value}"`);
      out.port = port;
    } else if (arg === '--lock') { out.lock = need(arg, i); i += 1; }
    else throw new Error(`unknown argument "${arg}" (see --help)`);
  }
  return out;
}

/**
 * The `.env` a first-time admin writes from `.env.example`: verbatim except the
 * values that must not stay as the template's placeholders. Secrets are written
 * once and never returned — a check that prints what it generated has published
 * the password of the stack it just built.
 *
 * @param {string} template the `.env.example` text
 * @param {{dbPassword: string, adminToken: string, frontendPort: number, backupDir: string}} values
 * @returns {{text: string, changed: string[]}} the file's content and which keys were replaced
 */
export function buildEnv(template, values) {
  const replacements = new Map([
    ['DB_PASSWORD', values.dbPassword],
    ['ADMIN_TOKEN', values.adminToken],
    ['FRONTEND_PORT', String(values.frontendPort)],
    ['BACKUP_DIR', values.backupDir],
  ]);
  const changed = [];
  const lines = template.split(/\r?\n/).map(line => {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) return line;
    const [, key] = match;
    if (!replacements.has(key)) return line;
    if (!changed.includes(key)) changed.push(key);
    return `${key}=${replacements.get(key)}`;
  });
  // A key the template does not carry (BACKUP_DIR is compose's `${BACKUP_DIR:-./backup/out}`,
  // not a template line) is appended: the check must still own where its backup lands.
  for (const [key, value] of replacements) {
    if (!changed.includes(key)) { changed.push(key); lines.splice(lines.length - 1, 0, `${key}=${value}`); }
  }
  return { text: `${lines.join('\n')}`, changed };
}

/** @returns {{dbPassword: string, adminToken: string}} 32 random bytes each, hex — what `.env.example` asks for. */
export function generateSecrets() {
  return { dbPassword: randomBytes(32).toString('hex'), adminToken: randomBytes(32).toString('hex') };
}

/**
 * True when nothing is listening on that port. Binds and immediately releases:
 * the check only needs to know the port is free *now*, before it hands it to
 * Docker.
 *
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export function portFree(port) {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Every variable the compose files interpolate (`${…}` in docker-compose.yml
 * and docker-compose.selfcheck.yml). Compose gives the caller's shell env
 * precedence over `.env`, so an exported FRONTEND_PORT=8044 or DB_PASSWORD
 * would beat the generated `.env` — the port check would probe one port while
 * Docker binds another. Scrubbing these from every docker child makes the
 * generated `.env` the single source. Keep in sync with the compose files.
 */
export const COMPOSE_INTERPOLATED = [
  'ADMIN_TOKEN', 'API_PORT', 'AUTHOR_PREVIEWS_PER_HOUR', 'AUTHOR_UPLOADS_PER_HOUR',
  'AUTH_FAILURES_PER_WINDOW', 'BACKUP_DIR', 'BACKUP_KEEP_DAYS', 'BACKUP_SCHEDULE_HOURS',
  'DB_HOST', 'DB_NAME', 'DB_PASSWORD', 'DB_PORT', 'DB_USER', 'FRONTEND_PORT',
  'LTI_FRAME_ANCESTORS', 'LTI_PUBLIC_URL', 'LTI_REGISTRATION_SECRET',
  'MAX_ARCHIVE_ENTRIES', 'MAX_ENTRY_BYTES', 'REQUIRE_HTTPS', 'TRUST_PROXY',
];

/**
 * A copy of `env` with every compose-interpolated name removed (values are
 * dropped, never printed). Everything else — PATH, SystemRoot, … — survives,
 * and the driver's explicit `-e` flags on a compose run are unaffected.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {Record<string, string|undefined>}
 */
export function scrubComposeEnv(env) {
  const out = { ...env };
  for (const name of COMPOSE_INTERPOLATED) delete out[name];
  return out;
}

/**
 * The compose invocation, one place: the base file plus the override that
 * renames volumes and containers. `-p` alone is not enough (both are pinned in
 * the base file), so the override is not optional.
 *
 * @param {string[]} args the compose subcommand and its arguments
 * @returns {string[]}
 */
export function composeArgs(args) {
  const files = COMPOSE_FILES.flatMap(file => ['-f', file]);
  return ['compose', '-p', PROJECT, ...files, ...args];
}

/**
 * Teardown, in order: the restart policy first, then removal. `restart:
 * unless-stopped` brought a torn-down project back after a Docker restart
 * (the 2026-11-16 lesson), and a resurrected stack then held the volumes the
 * next run needs.
 *
 * @returns {string[][]} commands, each ready for `spawnSync(cmd[0], cmd.slice(1))`
 */
export function teardownCommands() {
  const containers = ['VLCheckDatabase', 'VLCheckBackend', 'VLCheckFrontend', 'VLCheckBackup'];
  return [
    ['docker', 'update', '--restart=no', ...containers],
    ['docker', ...composeArgs(['down', '-v', '--remove-orphans'])],
  ];
}

/**
 * One `/api/health` answer, judged. `db: connected` is the half that matters: a
 * backend with no database answers 200 to nothing useful.
 *
 * @param {{status?: number, body?: any}} probe
 * @returns {{ok: boolean, reason: string}}
 */
export function judgeHealth(probe) {
  const body = probe?.body;
  if (probe?.status !== 200) return { ok: false, reason: `http ${probe?.status ?? 'no answer'}` };
  if (!body || typeof body !== 'object') return { ok: false, reason: 'body is not JSON' };
  if (body.status !== 'ok') return { ok: false, reason: `status=${body.status}` };
  if (body.db !== 'connected') return { ok: false, reason: `db=${body.db}` };
  if (!body.build || typeof body.build.version !== 'string') return { ok: false, reason: 'no build.version' };
  return { ok: true, reason: `api ${body.build.version}` };
}

/**
 * Waits for the platform to answer, one printed attempt per second.
 *
 * @param {(url: string) => Promise<{status: number, body: any}>} probe injected, so this is testable without a server
 * @param {{baseUrl: string, timeoutMs?: number, sleep?: (ms: number) => Promise<void>, log?: (line: string) => void}} opts
 * @returns {Promise<{ok: boolean, reason: string, waitedMs: number}>}
 */
export async function waitHealthy(probe, { baseUrl, timeoutMs = 300_000, sleep = ms => new Promise(r => setTimeout(r, ms)), log = () => {} }) {
  const started = Date.now();
  let last = { ok: false, reason: 'not tried' };
  let attempt = 0;
  while (Date.now() - started <= timeoutMs) {
    attempt += 1;
    try {
      last = judgeHealth(await probe(`${baseUrl}/api/health`));
    } catch (err) {
      last = { ok: false, reason: err.message };
    }
    log(`  healthy wait ${attempt}: ${last.ok ? 'ok' : 'no'} (${last.reason})`);
    if (last.ok) break;
    if (Date.now() - started + 1000 > timeoutMs) break;
    await sleep(1000);
  }
  return { ...last, waitedMs: Date.now() - started };
}

/** Runs a command, returning `{status, stdout, stderr}`; never throws on a non-zero exit. */
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', error: res.error };
}

/** A plain HTTP probe with a short timeout; the stack answers JSON on a local port. */
async function httpProbe(url, timeoutMs = 5000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = undefined; }
  return { status: res.status, body };
}

/**
 * The whole check. Injectable so tests drive it without Docker, git or a network:
 * `exec` runs commands, `probe` answers health, `now`/`sleep` control time.
 *
 * @param {object} opts
 * @returns {Promise<{ok: boolean, steps: Array<{name: string, ok: boolean, detail: string}>, failed?: string}>}
 */
export async function runCheck({
  ref = 'main',
  source = REPO_ROOT,
  port = DEFAULT_PORT,
  lock = null,
  keep = false,
  exec = run,
  probe = httpProbe,
  log = line => console.log(line),
  sleep = ms => new Promise(r => setTimeout(r, ms)),
  tmpRoot = os.tmpdir(),
  healthTimeoutMs = 300_000,
  git = run,
} = {}) {
  const steps = [];
  const step = (name, ok, detail = '') => {
    steps.push({ name, ok, detail });
    log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
    return ok;
  };

  let workdir = null;
  let upAttempted = false;

  try {
    // 1. The lock the caller holds (D8). A directory that exists is the contract
    //    `wk.sh lock vl-db` provides; its content is not this script's business.
    //    A regular file is not a lock: `wk.sh lock` creates a directory.
    if (!lock) return { ok: false, steps, failed: 'lock' };
    let lockIsDir = false;
    try { lockIsDir = statSync(lock).isDirectory(); } catch { lockIsDir = false; }
    if (!lockIsDir) { step('lock', false, `not a lock directory: ${lock}`); return { ok: false, steps, failed: 'lock' }; }
    step('lock', true, lock);

    // 2. The port has to be free before Docker takes it: a busy one produces a
    //    bind error deep inside a container start, minutes later.
    if (!await portFree(port)) { step('port', false, `${port} is in use`); return { ok: false, steps, failed: 'port' }; }
    step('port', true, String(port));

    // 3. The clone: the default branch as this checkout has it (D5), so the check
    //    proves committed state and never depends on the network being up.
    workdir = mkdtempSync(path.join(tmpRoot, 'vl-selfcheck-'));
    const cloneDir = path.join(workdir, 'app');
    const clone = git('git', ['clone', '--quiet', '--depth', '1', '--branch', ref, source, cloneDir]);
    if (clone.status !== 0) {
      step('clone', false, (clone.stderr || clone.error?.message || '').trim().slice(0, 200));
      return { ok: false, steps, failed: 'clone' };
    }
    const sha = git('git', ['-C', cloneDir, 'rev-parse', '--short', 'HEAD']);
    step('clone', true, `${ref}@${(sha.stdout || '').trim()}`);

    // 4. The `.env` an admin writes by hand, written here with generated secrets.
    const { text, changed } = buildEnv(readFileSync(path.join(cloneDir, '.env.example'), 'utf8'), {
      ...generateSecrets(), frontendPort: port, backupDir: path.join(workdir, 'backups'),
    });
    writeFileSync(path.join(cloneDir, '.env'), text);
    step('env', changed.length === 4, `replaced ${changed.join(', ')}`);

    // The caller's shell env must not override the generated .env: compose
    // gives exported vars precedence, so every docker child runs with them
    // scrubbed (the explicit `-e` flags on `run` still apply).
    const dockerEnv = scrubComposeEnv(process.env);

    // 5. Up. `--build` is the point: a clean clone has no images. `upAttempted`
    //    is set BEFORE the call: even a failed or timed-out `up` can leave
    //    containers behind, and the finally block must tear them down.
    upAttempted = true;
    const up = exec('docker', composeArgs(['up', '-d', '--build']), { cwd: cloneDir, timeout: 30 * 60_000, env: dockerEnv });
    if (!step('up', up.status === 0, up.status === 0 ? '' : (up.stderr || '').trim().split('\n').slice(-3).join(' | ').slice(0, 300))) {
      return { ok: false, steps, failed: 'up' };
    }

    // 6. Healthy.
    const baseUrl = `http://127.0.0.1:${port}`;
    const health = await waitHealthy(probe, { baseUrl, timeoutMs: healthTimeoutMs, sleep, log });
    if (!step('healthy', health.ok, `${health.reason} after ${Math.round(health.waitedMs / 1000)}s`)) {
      exec('docker', composeArgs(['logs', '--tail', '40', 'backend']), { cwd: cloneDir, env: dockerEnv });
      return { ok: false, steps, failed: 'healthy' };
    }

    // 7. One backup, then the read-back that makes it a backup (D7, D-9).
    const backupDir = path.join(workdir, 'backups');
    const once = exec('docker', composeArgs(['run', '--rm', '-e', 'BACKUP_RUN_ONCE=1', '-e', 'BACKUP_DIR=/backups', '-v', `${backupDir}:/backups`, 'backup']), { cwd: cloneDir, timeout: 10 * 60_000, env: dockerEnv });
    if (once.status !== 0) {
      step('backup', false, (once.stderr || '').trim().slice(-200));
      return { ok: false, steps, failed: 'backup' };
    }
    const produced = newestBackup(backupDir);
    if (!produced) {
      step('backup', false, `nothing written under ${backupDir}`);
      return { ok: false, steps, failed: 'backup' };
    }
    const verified = verifyBackup(produced);
    if (!step('backup', verified.ok, verified.ok ? `${verified.checks.length} checks, ${path.basename(produced)}` : String(verified.error))) {
      return { ok: false, steps, failed: 'backup' };
    }
    if (!existsSync(path.join(produced, VERIFIED_MARKER))) {
      step('backup marker', false, 'missing');
      return { ok: false, steps, failed: 'backup marker' };
    }
    step('backup marker', true);

    // 8. The smoke (D4): the layer that can prove a fresh, empty install.
    const env = { ...process.env, E2E_BASE_URL: baseUrl, ADMIN_TOKEN: text.match(/^ADMIN_TOKEN=(.*)$/m)?.[1] ?? '' };
    const install = exec('npm', ['ci', '--silent'], { cwd: path.join(cloneDir, 'e2e'), env, timeout: 20 * 60_000 });
    if (!step('e2e deps', install.status === 0, install.status === 0 ? '' : (install.stderr || '').trim().slice(-200))) {
      return { ok: false, steps, failed: 'e2e deps' };
    }
    const browsers = exec('npx', ['playwright', 'install', 'chromium'], { cwd: path.join(cloneDir, 'e2e'), env, timeout: 20 * 60_000 });
    if (!step('e2e browser', browsers.status === 0, browsers.status === 0 ? '' : (browsers.stderr || '').trim().slice(-200))) {
      return { ok: false, steps, failed: 'e2e browser' };
    }
    const smoke = exec('npm', ['run', '--silent', 'smoke'], { cwd: path.join(cloneDir, 'e2e'), env, timeout: 20 * 60_000 });
    const tail = (smoke.stdout || '').trim().split('\n').slice(-1)[0] ?? '';
    if (!step('smoke', smoke.status === 0, smoke.status === 0 ? tail.slice(0, 120) : tail.slice(-200))) {
      return { ok: false, steps, failed: 'smoke' };
    }

    return { ok: true, steps };
  } catch (err) {
    return { ok: false, steps, failed: `exception: ${err.message}` };
  } finally {
    // Teardown whenever `up` was attempted — including a failed or timed-out
    // `up`, which can leave containers with restart:unless-stopped and a
    // vlcheck_pgdata that poisons the next run. It runs BEFORE the clone is
    // removed: `down` needs the compose files inside it. `--keep` skips both.
    if (workdir && !keep) {
      const cloneDir = path.join(workdir, 'app');
      if (upAttempted && existsSync(cloneDir)) {
        for (const cmd of teardownCommands()) exec(cmd[0], cmd.slice(1), { cwd: cloneDir, timeout: 10 * 60_000, env: scrubComposeEnv(process.env) });
      }
      try {
        rmSync(workdir, { recursive: true, force: true });
        log('  ok   teardown');
      } catch (err) {
        // A locked file on Windows (EBUSY) must not mask the named failure:
        // record it and let the real result stand.
        steps.push({ name: 'cleanup', ok: false, detail: `could not remove ${workdir}: ${err.message}` });
        log(`  FAIL cleanup — could not remove ${workdir}: ${err.message}`);
      }
    } else if (workdir) {
      log(`  --   kept ${workdir}`);
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`selfhost-check: ${err.message}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(USAGE);
    process.exit(0);
  }
  console.log(`selfhost-check: ref=${opts.ref} port=${opts.port} source=${opts.source ?? REPO_ROOT}`);
  const result = await runCheck({
    ref: opts.ref, source: opts.source ?? REPO_ROOT, port: opts.port, lock: opts.lock, keep: opts.keep,
  });
  const ok = result.steps.filter(s => s.ok).length;
  console.log(`selfhost-check: steps=${result.steps.length} ok=${ok} ${result.ok ? 'GREEN' : `RED at ${result.failed}`}`);
  process.exit(result.ok ? 0 : 1);
}
