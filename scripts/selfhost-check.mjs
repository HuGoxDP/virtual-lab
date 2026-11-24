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
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
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
  --https                also publish the TLS listener (docker-compose.https.yml,
                         host port 8443), prove the redirect + HSTS, smoke over TLS
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
 * @returns {{ref: string, source: string|null, port: number, https: boolean, lock: string|null, keep: boolean, help: boolean}}
 */
export function parseArgs(argv) {
  const out = { ref: 'main', source: null, port: DEFAULT_PORT, https: false, lock: null, keep: false, help: false };
  const need = (flag, i) => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--keep') out.keep = true;
    else if (arg === '--https') out.https = true;
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
 * @param {{dbPassword: string, adminToken: string, frontendPort: number, backupDir: string, httpsPort?: number}} values
 * @returns {{text: string, changed: string[]}} the file's content and which keys were replaced
 */
export function buildEnv(template, values) {
  const replacements = new Map([
    ['DB_PASSWORD', values.dbPassword],
    ['ADMIN_TOKEN', values.adminToken],
    ['FRONTEND_PORT', String(values.frontendPort)],
    ['BACKUP_DIR', values.backupDir],
  ]);
  // P5b: https mode owns the TLS host port too. Appended LAST (after BACKUP_DIR,
  // before the final newline); HTTPS_REDIRECT_PORT is deliberately not written —
  // the overlay defaults it from HTTPS_PORT, one value to own.
  if (values.httpsPort !== undefined) replacements.set('HTTPS_PORT', String(values.httpsPort));
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
  'COMPOSE_FILE',
  'DB_HOST', 'DB_NAME', 'DB_PASSWORD', 'DB_PORT', 'DB_USER', 'FRONTEND_PORT',
  'HTTPS_PORT', 'HTTPS_REDIRECT_PORT',
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
 * @param {{https?: boolean}} [opts] https mode appends docker-compose.https.yml AFTER base + selfcheck
 * @returns {string[]}
 */
export function composeArgs(args, { https = false } = {}) {
  const files = [...COMPOSE_FILES, ...(https ? ['docker-compose.https.yml'] : [])];
  return ['compose', '-p', PROJECT, ...files.flatMap(file => ['-f', file]), ...args];
}

/**
 * Teardown, in order: the restart policy first, then removal. `restart:
 * unless-stopped` brought a torn-down project back after a Docker restart
 * (the 2026-11-16 lesson), and a resurrected stack then held the volumes the
 * next run needs.
 *
 * @param {{https?: boolean}} [opts] the down must carry the same overlays as the up, or the TLS listener survives
 * @returns {string[][]} commands, each ready for `spawnSync(cmd[0], cmd.slice(1))`
 */
export function teardownCommands({ https = false } = {}) {
  const containers = ['VLCheckDatabase', 'VLCheckBackend', 'VLCheckFrontend', 'VLCheckBackup'];
  return [
    ['docker', 'update', '--restart=no', ...containers],
    ['docker', ...composeArgs(['down', '-v', '--remove-orphans'], { https })],
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
 * P5b D1: the pure judge of the `https` step. The plain listener must answer
 * 301 (not 302) to a Location that is exactly the https base plus the request's
 * own path+query; the TLS listener must answer 200 with a non-empty HSTS; and
 * the plain answer must NOT carry HSTS — it is a TLS-only promise.
 *
 * @param {{http?: {url?: string, status?: number, headers?: Record<string,string>}, https?: {status?: number, headers?: Record<string,string>}}} probes
 * @param {{httpsBaseUrl: string}} opts
 * @returns {{ok: boolean, reason: string}}
 */
export function judgeHttps(probes, { httpsBaseUrl }) {
  const header = (headers, name) => {
    const key = Object.keys(headers ?? {}).find(k => k.toLowerCase() === name);
    return key === undefined ? undefined : headers[key];
  };
  const http = probes?.http;
  const https = probes?.https;
  if (!http || typeof http.status !== 'number') return { ok: false, reason: 'no answer from the plain listener' };
  if (!https || typeof https.status !== 'number') return { ok: false, reason: 'no answer from the https listener' };
  if (http.status !== 301) return { ok: false, reason: `plain listener answered ${http.status}, expected a 301 redirect` };
  let expected;
  try {
    const u = new URL(http.url);
    expected = `${httpsBaseUrl}${u.pathname}${u.search}`;
  } catch {
    return { ok: false, reason: 'the plain probe has no request URL to derive the Location from' };
  }
  const location = header(http.headers, 'location');
  if (!location) return { ok: false, reason: 'the 301 carries no Location header' };
  if (location !== expected) return { ok: false, reason: `Location ${location} is not ${expected} — scheme, host, port, path and query must all be preserved` };
  if (https.status !== 200) return { ok: false, reason: `https listener answered ${https.status}, expected 200` };
  const hsts = header(https.headers, 'strict-transport-security');
  if (!hsts || !String(hsts).trim()) return { ok: false, reason: 'the https answer carries no Strict-Transport-Security (HSTS)' };
  if (header(http.headers, 'strict-transport-security')) return { ok: false, reason: 'HSTS on the plain answer — it is a TLS-only promise' };
  return { ok: true, reason: `301 → ${httpsBaseUrl}, HSTS ${String(hsts).split(';')[0].trim()}` };
}

/**
 * HO1d D3: an abortable inter-attempt sleep. The injected `sleep` still runs
 * (tests count it), but an abort resolves the wait at once instead of holding
 * it for the rest of the second — or, in the runner, the whole health timeout.
 * The listener is removed on BOTH exits: the per-second loop must not
 * accumulate listeners on the signal.
 *
 * @param {(ms: number) => Promise<void>} sleep the injected sleep
 * @param {number} ms
 * @param {AbortSignal|null} signal
 * @returns {Promise<void>}
 */
function sleepInterruptible(sleep, ms, signal) {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { signal.removeEventListener('abort', finish); resolve(); };
    signal.addEventListener('abort', finish, { once: true });
    Promise.resolve(sleep(ms)).then(finish, finish);
  });
}

/**
 * Waits for the platform to answer, one printed attempt per second.
 * HO1d D3: an optional `signal` — an abort stops the wait at once (before the
 * next probe, and mid-sleep), reported as `{ok: false, reason: 'interrupted'}`.
 *
 * @param {(url: string) => Promise<{status: number, body: any}>} probe injected, so this is testable without a server
 * @param {{baseUrl: string, timeoutMs?: number, sleep?: (ms: number) => Promise<void>, log?: (line: string) => void, signal?: AbortSignal}} opts
 * @returns {Promise<{ok: boolean, reason: string, waitedMs: number}>}
 */
export async function waitHealthy(probe, { baseUrl, timeoutMs = 300_000, sleep = ms => new Promise(r => setTimeout(r, ms)), log = () => {}, signal = null }) {
  const started = Date.now();
  let last = { ok: false, reason: 'not tried' };
  let attempt = 0;
  while (!signal?.aborted && Date.now() - started <= timeoutMs) {
    attempt += 1;
    try {
      last = judgeHealth(await probe(`${baseUrl}/api/health`));
    } catch (err) {
      last = { ok: false, reason: err.message };
    }
    log(`  healthy wait ${attempt}: ${last.ok ? 'ok' : 'no'} (${last.reason})`);
    if (last.ok) break;
    if (signal?.aborted) break;
    if (Date.now() - started + 1000 > timeoutMs) break;
    await sleepInterruptible(sleep, 1000, signal);
  }
  // An abort wins over a probe that happened to answer healthy in the same
  // attempt: the run is interrupted, not green.
  if (signal?.aborted) last = { ok: false, reason: 'interrupted' };
  return { ...last, waitedMs: Date.now() - started };
}

/**
 * HO1d D5: the one command that cleans up a kept or abandoned check stack by
 * hand — the same project name and the same `-f` files as the `up` (https
 * overlay last when https), so `down -v` covers exactly what was started.
 * Pure: printed on `--keep` (with the kept dir) and on the second Ctrl+C.
 *
 * @param {{https?: boolean, cloneDir: string}} opts
 * @returns {string} `cd <cloneDir> && docker compose -p vl-selfcheck -f … down -v --remove-orphans`
 */
export function manualTeardownCommand({ https = false, cloneDir }) {
  return `cd ${cloneDir} && docker ${composeArgs(['down', '-v', '--remove-orphans'], { https }).join(' ')}`;
}

/**
 * HO1d D4: the CLI's Ctrl+C wiring, testable with a fake process
 * (EventEmitter). First signal: abort the controller and print one line — the
 * check then takes its normal teardown path. Second signal: print the manual
 * teardown command (when there is something to tear down) and exit 130 at
 * once, even mid-teardown. SIGINT/SIGTERM always; SIGBREAK exists only on
 * Windows and is registered only there. Importing the module registers
 * nothing — only the isMain block calls this.
 *
 * @param {{on: (event: string, handler: () => void) => void, platform?: string}} proc
 * @param {AbortController} controller
 * @param {{print?: (line: string) => void, exit?: (code: number) => void, command: () => string|null}} handlers
 * @returns {void}
 */
export function installSignalHandlers(proc, controller, { print = line => console.log(line), exit = code => process.exit(code), command }) {
  let interrupted = false;
  const onSignal = () => {
    if (!interrupted) {
      interrupted = true;
      controller.abort();
      print('selfhost-check: interrupted — tearing down (press Ctrl+C again to stop now)');
      return;
    }
    const manual = command();
    if (manual) print(`selfhost-check: stopped — clean up by hand: ${manual}`);
    exit(130);
  };
  proc.on('SIGINT', onSignal);
  proc.on('SIGTERM', onSignal);
  if ((proc.platform ?? process.platform) === 'win32') proc.on('SIGBREAK', onSignal);
}

/**
 * HO1c D1: where the npm-cli.js that belongs to this node lives. The npm
 * bundled next to the node binary comes first; `npm_execpath` is only trusted
 * when its basename is `npm-cli.js` (pnpm and yarn set it to their own CLIs).
 * `npx-cli.js` is the sibling of the chosen `npm-cli.js` (npm ≥ 7).
 * @returns {string|null} the bin directory, or null when neither candidate exists
 */
function npmBinDir() {
  const bundled = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin');
  if (existsSync(path.join(bundled, 'npm-cli.js'))) return bundled;
  const execpath = process.env.npm_execpath;
  if (execpath && path.basename(execpath) === 'npm-cli.js' && existsSync(execpath)) return path.dirname(execpath);
  return null;
}

/**
 * HO1c D1: the default runner (`exec` and `git`). On Windows npm/npx are .cmd
 * shims that spawnSync refuses to run without a shell — so they run through
 * this node itself (`<execPath> npm-cli.js …`), which works even when PATH
 * holds only node's own directory. No npm-cli found → the plain command is
 * spawned and its failure becomes a named ENOENT via why(), never a crash.
 * Never `shell: true`; synchronous; never throws — a spawn failure is the
 * returned `{status: null, error}`. Non-win32: the command is spawned unchanged.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {import('node:child_process').SpawnSyncOptions} [opts]
 * @returns {{status: number|null, stdout: string, stderr: string, error?: Error}}
 */
export function runCommand(cmd, args, opts = {}) {
  let command = cmd;
  let argv = args;
  if (process.platform === 'win32' && (cmd === 'npm' || cmd === 'npx')) {
    const bin = npmBinDir();
    const cli = bin && path.join(bin, cmd === 'npx' ? 'npx-cli.js' : 'npm-cli.js');
    if (cli && existsSync(cli)) { command = process.execPath; argv = [cli, ...args]; }
  }
  try {
    const res = spawnSync(command, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts, shell: false });
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', error: res.error };
  } catch (err) {
    // spawnSync reports spawn failures on res.error; a throw here (bad opts)
    // must still surface as the same shape, not kill the check mid-step.
    return { status: null, stdout: '', stderr: '', error: err };
  }
}

/**
 * HO1c D2: why a command step failed — the spawn error's message (ENOENT,
 * ETIMEDOUT, …) plus the trimmed tail of stderr, or of stdout when stderr is
 * empty. A superset of the old stderr-only detail: a `{status: null, error}`
 * spawn failure used to print an empty line.
 *
 * @param {{status?: number|null, stdout?: string, stderr?: string, error?: Error}} res
 * @returns {string}
 */
export function why(res) {
  const tail = ((res.stderr ?? '').trim() || (res.stdout ?? '').trim()).slice(-200);
  return [res.error?.message, tail].filter(Boolean).join(' | ');
}

/**
 * One probe answer with status, headers and parsed body. Redirects are never
 * followed (the redirect itself is what the https step judges) and the stack's
 * self-signed certificate is accepted — this probes a throwaway local stack,
 * not a trust decision. node:http/https rather than fetch: undici ignores
 * NODE_TLS_REJECT_UNAUTHORIZED and would reject the self-signed cert.
 */
export async function httpProbe(url, timeoutMs = 5000) {
  const target = new URL(url);
  const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(target, { timeout: timeoutMs, rejectUnauthorized: false }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let body;
        try { body = JSON.parse(text); } catch { body = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`probe timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end();
  });
}

/**
 * The whole check. Injectable so tests drive it without Docker, git or a network:
 * `exec` runs commands, `probe` answers health, `now`/`sleep` control time.
 * HO1d D3: an optional `signal` (AbortSignal) — checked after a yield between
 * steps; an abort ends the run `{ok:false, failed:'interrupted'}` and the
 * normal teardown runs (except `--keep`, which still wins).
 *
 * @param {object} opts
 * @returns {Promise<{ok: boolean, steps: Array<{name: string, ok: boolean, detail: string}>, failed?: string}>}
 */
export async function runCheck({
  ref = 'main',
  source = REPO_ROOT,
  port = DEFAULT_PORT,
  https = false,
  httpsPort = 8443,
  lock = null,
  keep = false,
  exec = runCommand,
  probe = httpProbe,
  log = line => console.log(line),
  sleep = ms => new Promise(r => setTimeout(r, ms)),
  tmpRoot = os.tmpdir(),
  healthTimeoutMs = 300_000,
  git = runCommand,
  signal = null,
} = {}) {
  const steps = [];
  const step = (name, ok, detail = '') => {
    steps.push({ name, ok, detail });
    log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
    return ok;
  };

  let workdir = null;
  let upAttempted = false;

  // HO1d D3: yield to the event loop, then check the abort. The runner stays
  // synchronous (spawnSync); this yield is what lets a Ctrl+C — which reaches
  // the running child too, so it returns — be observed between steps, without
  // an async rewrite. Called between every step; the health wait checks the
  // signal itself. An abort is a named return, not a throw: the finally block
  // tears down exactly as after any other failure.
  const checkpoint = async () => {
    await new Promise(resolve => setImmediate(resolve));
    return signal?.aborted === true;
  };
  const interrupted = () => ({ ok: false, steps, failed: 'interrupted' });

  try {
    // 1. The lock the caller holds (D8). A directory that exists is the contract
    //    `wk.sh lock vl-db` provides; its content is not this script's business.
    //    A regular file is not a lock: `wk.sh lock` creates a directory.
    if (!lock) return { ok: false, steps, failed: 'lock' };
    let lockIsDir = false;
    try { lockIsDir = statSync(lock).isDirectory(); } catch { lockIsDir = false; }
    if (!lockIsDir) { step('lock', false, `not a lock directory: ${lock}`); return { ok: false, steps, failed: 'lock' }; }
    step('lock', true, lock);

    // 2. The ports have to be free before Docker takes them: a busy one produces
    //    a bind error deep inside a container start, minutes later. In https
    //    mode the TLS listener's port (the overlay's own default 8443) is
    //    checked too, before anything is cloned.
    const ports = [port, ...(https ? [httpsPort] : [])];
    const busy = [];
    for (const p of ports) if (!await portFree(p)) busy.push(p);
    if (busy.length) { step('port', false, `${busy.join(', ')} in use`); return { ok: false, steps, failed: 'port' }; }
    step('port', true, https ? `${port}, ${httpsPort} (https)` : String(port));

    // 3. The clone: the default branch as this checkout has it (D5), so the check
    //    proves committed state and never depends on the network being up.
    workdir = mkdtempSync(path.join(tmpRoot, 'vl-selfcheck-'));
    const cloneDir = path.join(workdir, 'app');
    const clone = git('git', ['clone', '--quiet', '--depth', '1', '--branch', ref, source, cloneDir]);
    if (clone.status !== 0) {
      step('clone', false, (clone.stderr || clone.error?.message || '').trim().slice(0, 200));
      // AC-12: an interrupted clone is the interruption, not a clone failure.
      if (await checkpoint()) return interrupted();
      return { ok: false, steps, failed: 'clone' };
    }
    const sha = git('git', ['-C', cloneDir, 'rev-parse', '--short', 'HEAD']);
    step('clone', true, `${ref}@${(sha.stdout || '').trim()}`);
    if (await checkpoint()) return interrupted();

    // 4. The `.env` an admin writes by hand, written here with generated secrets.
    const { text, changed } = buildEnv(readFileSync(path.join(cloneDir, '.env.example'), 'utf8'), {
      ...generateSecrets(), frontendPort: port, backupDir: path.join(workdir, 'backups'),
      ...(https ? { httpsPort } : {}),
    });
    writeFileSync(path.join(cloneDir, '.env'), text);
    const dbUser = text.match(/^DB_USER=(.*)$/m)?.[1] ?? 'lab_user';
    const dbName = text.match(/^DB_NAME=(.*)$/m)?.[1] ?? 'virtual_lab';
    step('env', changed.length === (https ? 5 : 4), `replaced ${changed.join(', ')}`);
    if (await checkpoint()) return interrupted();

    // The caller's shell env must not override the generated .env: compose
    // gives exported vars precedence, so every docker child runs with them
    // scrubbed (the explicit `-e` flags on `run` still apply).
    const dockerEnv = scrubComposeEnv(process.env);

    // 5. Up. `--build` is the point: a clean clone has no images. `upAttempted`
    //    is set BEFORE the call: even a failed or timed-out `up` can leave
    //    containers behind, and the finally block must tear them down.
    upAttempted = true;
    const up = exec('docker', composeArgs(['up', '-d', '--build'], { https }), { cwd: cloneDir, timeout: 30 * 60_000, env: dockerEnv });
    const upFailed = !step('up', up.status === 0, up.status === 0 ? '' : why(up).slice(0, 300));
    // AC-12: the abort is judged BEFORE the child's status. A terminal Ctrl+C
    // reaches the docker child too, so `up` returns non-zero on an interrupt;
    // judging the status first named 'up' instead of 'interrupted'.
    if (await checkpoint()) return interrupted();
    if (upFailed) return { ok: false, steps, failed: 'up' };

    // 6. Healthy. In https mode the redirect include makes EVERY plain request
    //    answer 301 — /api/health included — so the health wait moves to the
    //    TLS base (the self-signed cert is accepted by the probe).
    const baseUrl = `http://127.0.0.1:${port}`;
    const httpsBaseUrl = `https://127.0.0.1:${httpsPort}`;
    const healthBase = https ? httpsBaseUrl : baseUrl;
    const health = await waitHealthy(probe, { baseUrl: healthBase, timeoutMs: healthTimeoutMs, sleep, log, signal });
    // An aborted health wait is the interruption itself, not a failed healthy
    // step: no logs dump, the named 'interrupted' result and normal teardown.
    if (signal?.aborted) return interrupted();
    if (!step('healthy', health.ok, `${health.reason} after ${Math.round(health.waitedMs / 1000)}s`)) {
      exec('docker', composeArgs(['logs', '--tail', '40', 'backend'], { https }), { cwd: cloneDir, env: dockerEnv });
      return { ok: false, steps, failed: 'healthy' };
    }
    if (await checkpoint()) return interrupted();

    // 6b. https mode: prove the redirect on the plain listener and HSTS on the
    //     TLS one (judgeHttps). A stack that serves plain 200s with the overlay
    //     on is misconfigured, and the check names it instead of smokes over it.
    if (https) {
      const [httpAnswer, httpsAnswer] = await Promise.all([probe(`${baseUrl}/`), probe(`${httpsBaseUrl}/api/health`)]);
      const judged = judgeHttps({ http: { url: `${baseUrl}/`, ...httpAnswer }, https: httpsAnswer }, { httpsBaseUrl });
      if (!step('https', judged.ok, judged.reason)) {
        exec('docker', composeArgs(['logs', '--tail', '40', 'frontend'], { https }), { cwd: cloneDir, env: dockerEnv });
        return { ok: false, steps, failed: 'https' };
      }
      if (await checkpoint()) return interrupted();
    }

    // 7. One backup, then the read-back that makes it a backup (D7, D-9).
    //    First the restore proof (P5b D6): seed one draft scenario row inside
    //    the stack's database. A draft is invisible to the public catalog, so
    //    the smoke never sees it; the backup snapshots it, the restore step
    //    deletes it and must bring it back.
    const backupDir = path.join(workdir, 'backups');
    const psql = sql => exec('docker', composeArgs(['exec', '-T', 'database', 'psql', '-U', dbUser, '-d', dbName, '-tAc', sql], { https }), { cwd: cloneDir, timeout: 60_000, env: dockerEnv });
    const seed = psql(`INSERT INTO scenarios (id, title, category, category_label, status) VALUES ('vl-selfcheck-restore-proof', 'restore proof', 'physics', 'Фізика', 'draft')`);
    if (seed.status !== 0) {
      step('restore', false, `seed failed: ${why(seed)}`);
      return { ok: false, steps, failed: 'restore' };
    }
    // P5c: compose now pins the container env to /backups itself, but the
    // explicit -e stays (pinned by compose-backup-dir.test.mjs and, for the
    // restore child, selfhost-restore.test.mjs): the check clones any --ref,
    // including pre-P5c code where the env still interpolated BACKUP_DIR.
    const once = exec('docker', composeArgs(['run', '--rm', '-e', 'BACKUP_RUN_ONCE=1', '-e', 'BACKUP_DIR=/backups', '-v', `${backupDir}:/backups`, 'backup'], { https }), { cwd: cloneDir, timeout: 10 * 60_000, env: dockerEnv });
    if (once.status !== 0) {
      step('backup', false, why(once));
      if (await checkpoint()) return interrupted(); // AC-12: the same rule as `up`
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
    if (await checkpoint()) return interrupted();
    if (!existsSync(path.join(produced, VERIFIED_MARKER))) {
      step('backup marker', false, 'missing');
      return { ok: false, steps, failed: 'backup marker' };
    }
    step('backup marker', true);
    if (await checkpoint()) return interrupted();

    // 7b. The restore (P5b D6): count what the backup held, delete the proof
    //     row, restore the verified backup inside the backup container with
    //     docker-compose.restore.yml's rw mounts (--entrypoint node: the image
    //     entrypoint is backup.mjs), and prove the count is back and the stack
    //     still answers. A restore that cannot bring one row back is not a
    //     restore, and the check fails here rather than at an outage.
    const proofId = 'vl-selfcheck-restore-proof';
    const countSql = `SELECT count(*) FROM scenarios WHERE id = '${proofId}'`;
    const before = psql(countSql);
    const heldCount = Number((before.stdout || '').trim());
    const removed = psql(`DELETE FROM scenarios WHERE id = '${proofId}'`);
    const restore = exec('docker', composeArgs(['-f', 'docker-compose.restore.yml', 'run', '--rm', '--entrypoint', 'node', '-e', 'BACKUP_DIR=/backups', '-v', `${backupDir}:/backups`, 'backup', 'restore.mjs', path.basename(produced), '--yes'], { https }), { cwd: cloneDir, timeout: 10 * 60_000, env: dockerEnv });

    // AC-12: an interrupt during the restore child is the interruption, not a
    // restore failure - the numbers below would only describe a broken child.
    if (await checkpoint()) return interrupted();
    const after = restore.status === 0 ? psql(countSql) : { status: 1, stdout: '', stderr: '' };
    const restoredCount = Number((after.stdout || '').trim());
    const postHealth = restore.status === 0 ? judgeHealth(await probe(`${healthBase}/api/health`)) : { ok: false, reason: 'restore failed' };
    const restoreOk = before.status === 0 && removed.status === 0 && restore.status === 0
      && after.status === 0 && Number.isInteger(heldCount) && restoredCount === heldCount && postHealth.ok;
    const restoreDetail = restore.status !== 0 ? why(restore)
      : !restoreOk ? `count ${restoredCount} ≠ ${heldCount} or health: ${postHealth.reason}`
      : `${path.basename(produced)} restored, proof row back (${restoredCount}), ${postHealth.reason}`;
    if (!step('restore', restoreOk, restoreDetail)) {
      return { ok: false, steps, failed: 'restore' };
    }
    if (await checkpoint()) return interrupted();

    // 8. The smoke (D4): the layer that can prove a fresh, empty install. In
    //    https mode it runs against the TLS base; the self-signed cert of this
    //    throwaway stack is opted into with NODE_TLS_REJECT_UNAUTHORIZED=0 and
    //    E2E_INSECURE_TLS=1 (the smoke config's ignoreHTTPSErrors switch). A
    //    plain run never sets either — full verification stays on.
    const env = {
      ...process.env,
      E2E_BASE_URL: https ? httpsBaseUrl : baseUrl,
      ADMIN_TOKEN: text.match(/^ADMIN_TOKEN=(.*)$/m)?.[1] ?? '',
      ...(https ? { NODE_TLS_REJECT_UNAUTHORIZED: '0', E2E_INSECURE_TLS: '1' } : {}),
    };
    const install = exec('npm', ['ci', '--silent'], { cwd: path.join(cloneDir, 'e2e'), env, timeout: 20 * 60_000 });
    const depsFailed = !step('e2e deps', install.status === 0, install.status === 0 ? '' : why(install));
    if (await checkpoint()) return interrupted(); // AC-12: an interrupted install is not a failed one
    if (depsFailed) return { ok: false, steps, failed: 'e2e deps' };
    const browsers = exec('npx', ['playwright', 'install', 'chromium'], { cwd: path.join(cloneDir, 'e2e'), env, timeout: 20 * 60_000 });
    const browsersFailed = !step('e2e browser', browsers.status === 0, browsers.status === 0 ? '' : why(browsers));
    if (await checkpoint()) return interrupted(); // AC-12: an interrupted browser install is not a failed one
    if (browsersFailed) return { ok: false, steps, failed: 'e2e browser' };
    const smoke = exec('npm', ['run', '--silent', 'smoke'], { cwd: path.join(cloneDir, 'e2e'), env, timeout: 20 * 60_000 });
    const smokeTail = (smoke.stdout || '').trim().split('\n').slice(-1)[0] ?? '';
    const smokeFailed = !step('smoke', smoke.status === 0, smoke.status === 0 ? smokeTail.slice(0, 120) : why(smoke));
    if (await checkpoint()) return interrupted(); // AC-12: an interrupted smoke is not a failed one
    if (smokeFailed) return { ok: false, steps, failed: 'smoke' };

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
        for (const cmd of teardownCommands({ https })) exec(cmd[0], cmd.slice(1), { cwd: cloneDir, timeout: 10 * 60_000, env: scrubComposeEnv(process.env) });
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
      // HO1d D5: --keep wins even on an abort — nothing is torn down, so the
      // admin gets the exact command to clean the kept stack up by hand.
      // Only when `up` was attempted: before that there is no stack.
      if (upAttempted && signal?.aborted) log(`  --   clean up by hand: ${manualTeardownCommand({ https, cloneDir: path.join(workdir, 'app') })}`);
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
  console.log(`selfhost-check: ref=${opts.ref} port=${opts.port}${opts.https ? ' https=8443' : ''} source=${opts.source ?? REPO_ROOT}`);
  // HO1d D4: Ctrl+C wiring — first signal aborts and the check tears down
  // normally; the second prints the manual command and exits 130 at once.
  // `command()` answers null until the clone exists (nothing to tear down).
  const controller = new AbortController();
  let teardownTarget = null;
  installSignalHandlers(process, controller, {
    command: () => (teardownTarget ? manualTeardownCommand({ https: opts.https, cloneDir: teardownTarget.cloneDir }) : null),
  });
  const result = await runCheck({
    ref: opts.ref, source: opts.source ?? REPO_ROOT, port: opts.port, https: opts.https, lock: opts.lock, keep: opts.keep,
    signal: controller.signal,
    // The clone dir becomes known before `up` runs (the first child that can
    // leave containers behind), so a second Ctrl+C from then on can name the
    // exact cleanup command even mid-teardown.
    exec: (cmd, args, childOpts) => {
      if (cmd === 'docker' && args.includes('up') && childOpts?.cwd) teardownTarget = { cloneDir: childOpts.cwd };
      return runCommand(cmd, args, childOpts);
    },
  });
  const ok = result.steps.filter(s => s.ok).length;
  console.log(`selfhost-check: steps=${result.steps.length} ok=${ok} ${result.ok ? 'GREEN' : `RED at ${result.failed}`}`);
  process.exit(result.ok ? 0 : 1);
}
