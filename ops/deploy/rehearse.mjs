// ops/deploy/rehearse.mjs
//
// The rehearsal (OPS1 phase 5, decision D-14): the deploy pipeline run for real
// against Docker on this machine, through the local transport — the same scripts,
// the same steps, the same gates as a production run, with different names.
//
// It proves the *paths*, not the images: what is under test is that a fresh
// install comes up; that a release is recorded and rolled back to; that a
// migration the smoke refuses is rolled back and the schema comes back with it;
// that a backend which cannot start is rolled back without a database restore;
// that a hand-made deployment is adopted byte for byte; and that every one of
// those paths answers the exit code the plan says it does.
//
//   node ops/deploy/rehearse.mjs [--lock <dir>] [--only R-4] [--notes <file>] [--keep]
//
// The teardown is the only `down -v` in the whole task, and it refuses unless
// every volume of the project starts with `rehearsal_` — a rehearsal must never
// be able to name a volume it did not create.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VL_REPO = path.resolve(HERE, '../..');
const DEPLOY = path.join(HERE, 'deploy.mjs');
/** The project root `R`, where `.workers/locks/` and `wk.sh` live. */
const ROOT = path.resolve(HERE, '../../../../..');

/** The project names a rehearsal owns: its volumes and containers, renamed by
 * `ops/deploy/compose.rehearsal.yml` to `rehearsal_*` and `Rehearsal*`. */
export const PROJECT = 'vlrehearsal';
export const HAND_PROJECT = 'vlhand';
/** The rehearsal's port. The live local stack keeps 8044 and the engine's player
 * host keeps its own, so nothing here collides with a stack that is running. */
export const PORT = '8047';
export const HAND_PORT = '8049';
/** The compose file that renames every volume, container and published port. */
export const REHEARSAL_COMPOSE = 'ops/deploy/compose.rehearsal.yml';
/** The branch the four rehearsal commits live on: local-only, never pushed. */
export const SCRATCH_BRANCH = 'OPS1-rehearsal-scratch';

/** A short sha, for the table. */
const SHORT_ = sha => String(sha).slice(0, 7);

/** The clock every rehearsal deploy runs against: a Saturday, inside the window. */
export const REHEARSAL_NOW = '2026-11-14T10:00:00Z';

/** A row the rehearsal can tell apart from a published one: the NOT NULL columns
 * `scenarios` carries get real values, or the insert fails on them and the
 * rehearsal cannot tell what survived (OPS1 phase 5). */
const MARKER = "insert into scenarios (id, title, description, category, category_label, version, created_at, updated_at) "
  + "values ('rehearsal-marker', 'Rehearsal marker', 'a row a rollback must not lose', 'test', 'Rehearsal', '1.0', now(), now()) "
  + 'on conflict (id) do update set title = excluded.title';
const MARKER_COUNT = "select count(*) from scenarios where id = 'rehearsal-marker'";

/**
 * A path in the form the scripts get: POSIX (`/c/…`). This machine's `tar` reads
 * a drive letter as a remote host and exits 128, Docker Desktop resolves the
 * POSIX form, and bash is happier with it — so every path the rehearsal hands to
 * a script is in this shape (the plan's phase-5 edge case, recorded here).
 */
export const posix = file => file
  .replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
  .split(path.sep).join('/');

/** The SHA-256 of a file as hex — the only form the rehearsal ever prints. */
export const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * A temporary directory, in the form *this process* can use: a Windows path with
 * forward slashes.
 *
 * Node cannot touch a POSIX (`/c/…`) path on this machine — `ENOENT`, whatever the
 * file — so the roots the rehearsal works with are Windows paths, and only the
 * values handed to the scripts are converted (by `posix`). Joining a POSIX prefix
 * produced `\c\Users\…`, which nothing resolves at all; that is the other half of
 * why this is a named helper and not a bare call.
 */
export const mkdtemp = prefix => mkdtempSync(path.join(tmpdir(), prefix)).split(path.sep).join('/');

/** A child process's output, collected instead of streamed, so a step's own
 * failure is part of what the rehearsal records. */
function run(command, args, options = {}) {
  const answer = spawnSync(command, args, {
    encoding: 'utf8', maxBuffer: 1 << 26, ...options,
  });
  return {
    status: answer.status ?? 1,
    stdout: answer.stdout ?? '',
    stderr: answer.stderr ?? '',
  };
}

const sh = (command, args, options = {}) => execFileSync(command, args, {
  encoding: 'utf8', maxBuffer: 1 << 26, ...options,
});

/** The compose files a rehearsal runs with, in `-f` order, for `COMPOSE_FILE`. */
export const COMPOSE_FILES = [
  'docker-compose.yml', 'docker-compose.restore.yml', 'ops/deploy/compose.release.yml', REHEARSAL_COMPOSE,
].join(';');

/**
 * The whole run: every row's expectation and answer, whether any row failed, and
 * the log every command produced.
 *
 * `row()` is the table: what was expected, what answered, how long it took. A
 * row that does not answer its expectation marks the run red, which is the only
 * verdict the plan's DW-5.1 asks for.
 */
export function createRecorder() {
  const rows = [];
  let failed = false;
  return {
    rows,
    get failed() { return failed; },
    async row(step, expected, run_) {
      const started = Date.now();
      const code = await run_();
      const seconds = (Date.now() - started) / 1000;
      const ok = code === expected;
      rows.push({ step, expected, actual: code, seconds, ok });
      if (!ok) failed = true;
      process.stdout.write(`${String(step).padEnd(48)}${ok ? 'ok  ' : 'FAIL'} exit `
        + `${String(code).padEnd(4)} ${seconds.toFixed(1)}s\n`);
      return code;
    },
  };
}

/** A log of every command the rehearsal ran, so the notes can carry the output. */
export function createLog() {
  const lines = [];
  return {
    lines,
    push(command, answer) {
      lines.push(`\n$ ${command}\n${answer.stdout ?? ''}${answer.stderr ?? ''}`);
    },
    text() { return lines.join('\n') + '\n'; },
  };
}

/**
 * The deploy command, exactly as the production pipeline runs it — the local
 * transport, the rehearsal's own root and project, the rehearsal's compose file
 * added to the release's list.
 *
 * @param {object} env — the rehearsal's `deploy.env` path and DEPLOY_PATH.
 * @param {string} command — `deploy` or `rollback`.
 * @param {string[]} extra — further flags.
 */
/**
 * The deploy command's argv, as three forms of path with one reason each (the
 * plan's phase-5 edge case, recorded here so a test can pin them):
 *
 *   `--env-file`   is read by Node — the host's own form (the Windows one here);
 *   `--repo`       is where `git` runs — the host's own form;
 *   `--local-root` becomes DEPLOY_PATH for the scripts — the host's own form too:
 *                  docker's `--env-file` resolves a POSIX (`/c/…`) path through the
 *                  current directory and answers `C:\c\…`, which does not exist.
 *
 * The one place a POSIX path is required is `tar` reading a *path*, and that is a
 * conversion inside `remote/verify-backup.sh`, not a different flag here.
 */
export function deployArgv({ envFile, localRoot, repo = VL_REPO, now = REHEARSAL_NOW }, command, extra = []) {
  return [
    DEPLOY, command, 'platform',
    '--env-file', envFile,
    '--transport', 'local',
    '--local-root', localRoot,
    '--project', PROJECT,
    '--compose-file', REHEARSAL_COMPOSE,
    '--repo', repo,
    // A moment inside the deploy window: the window exists to protect production
    // traffic, and a rehearsal on port 8047 has none. The gate is still evaluated —
    // a wrong hour still refuses, which is what its own unit test proves.
    '--now', now,
    '--rehearsal',
    ...extra,
  ];
}

/** The deploy command, run. */
export function deployCommand(options, command, extra = []) {
  const { envFile, localRoot, repo = VL_REPO, now = REHEARSAL_NOW } = options;
  return run('node', deployArgv({ envFile, localRoot, repo, now }, command, extra),
    { cwd: repo, env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
}

/**
 * A compose command against a stack the rehearsal owns.
 *
 * `cwd` is where compose reads its files from: the release directory the pipeline
 * deployed (`<root>/releases/current`) for the rehearsal stack, and the extracted
 * tree itself for the hand-made one — a hand-made stack has no release directory,
 * which is precisely what makes it a different case (R-7).
 */
export function composeCommand(root, composeFiles, args, { envFile, cwd, project = PROJECT } = {}) {
  // `releases/current` is a FILE naming the running release (see `remote/up.sh`),
  // not a directory to cd into.
  const from = cwd ?? path.posix.join(root, 'releases', currentRelease(root) ?? 'current');
  return run('bash', ['-c',
    `cd "${from}" && COMPOSE_FILE="${composeFiles}" `
    + `docker compose --project-name ${project} --env-file "${envFile}" "$@"`,
    '_', ...args,
  ], { env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
}

/** The release id `up` recorded as running, or null before the first deploy. */
export function currentRelease(root) {
  const file = path.join(root, 'releases', 'current');
  if (!existsSync(file)) return null;
  try {
    const id = readFileSync(file, 'utf8').trim();
    return id === '' ? null : id;
  } catch {
    return null;
  }
}

/** A read-only SQL query against the rehearsal database. */
export function query(root, composeFiles, envFile, sql_, { cwd } = {}) {
  const answer = composeCommand(root, composeFiles,
    ['exec', '-T', 'database', 'psql', '-U', envValue(envFile, 'DB_USER'), '-d',
      envValue(envFile, 'DB_NAME'), '-tAc', sql_], { envFile, cwd });
  return answer.stdout.trim();
}

/** A value from the generated `.env`: read where the stack reads it, and never
 * printed by the rehearsal (D-13). */
export function envValue(envFile, key) {
  const text = readFileSync(envFile, 'utf8');
  const match = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
  if (!match) throw new Error(`${key} is not in ${envFile}`);
  return match[1].trim();
}

/** The commit `/api/health` reports, which is what a smoke pins. */
export function healthCommit(port = PORT, { attempts = 60, delayMs = 1000 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const answer = run('curl', ['-s', `http://127.0.0.1:${port}/api/health`]);
    try {
      const body = JSON.parse(answer.stdout);
      if (body?.build?.commit) return body.build.commit;
    } catch { /* the stack is still coming up */ }
    if (attempt < attempts - 1) {
      // A step that waits is a slow step, and the table says how slow: the wait is
      // real, not a skipped poll.
      const stop = Date.now() + delayMs;
      while (Date.now() < stop) { /* wait */ }
    }
  }
  return null;
}

/** The release record a rehearsal root holds. */
export function readRecord(localRoot) {
  try {
    return JSON.parse(readFileSync(path.join(localRoot, 'releases', 'state.json'), 'utf8'));
  } catch {
    return { current: null, previous: null, history: [] };
  }
}

/**
 * The four commits the rehearsal deploys, on a local-only branch:
 *   A = the base commit — deployed first, and the release the last rollback goes to;
 *   B = a visible no-op (a comment), so a second release can be told apart;
 *   C = a migration file, which the red smoke refuses;
 *   D = a backend that exits at start, which the health timeout refuses.
 *
 * The base is the branch the pipeline itself is on, *not* `origin/main`: a
 * rehearsal run from `origin/main` would remove `ops/deploy/` from the worktree
 * it is running from — the pipeline is not merged yet, and the run would delete
 * the very files it is proving. A is therefore the release the task branch
 * carries, which is the same thing the plan asks for ("what is deployed first")
 * with the one fact of this checkout recorded in the notes.
 *
 * The branch is deleted by the run, and it is refused if a remote branch of the
 * same name exists — a rehearsal must never push a ref another worker could read
 * as a task.
 *
 * @param {string} [base] — the branch to cut the four commits from.
 * @param {string} [repo] — the repository to cut the commits in.
 * @returns {{A: string, B: string, C: string, D: string, branch: string}}
 */
export function scratchCommits(base = 'OPS1-deploy-pipeline', repo = VL_REPO) {
  const inRepo = (...args) => sh('git', ['-C', repo, ...args]);
  const remote = inRepo('ls-remote', '--heads', 'origin', SCRATCH_BRANCH).trim();
  if (remote !== '') throw new Error(`${SCRATCH_BRANCH} exists on origin — the rehearsal never pushes`);
  // The scratch branch is local-only and cut again on every run, so a leftover
  // from an interrupted one is deleted first — and a branch that is not there is
  // not an error, which is the case on the first run.
  try { inRepo('branch', '-qD', SCRATCH_BRANCH); } catch { /* no leftover */ }
  inRepo('switch', '-q', '-c', SCRATCH_BRANCH, base);
  const head = () => inRepo('rev-parse', 'HEAD').trim();
  const A = head();

  // B: a comment in the line that answers `/api/health`.
  const server = path.join(repo, 'backend', 'server.js');
  const original = readFileSync(server, 'utf8');
  writeFileSync(server, '// OPS1 rehearsal B: a visible no-op that changes no behaviour.\n' + original);
  inRepo('commit', '-qam', 'rehearsal B: a comment that changes nothing');
  const B = head();

  // C: a migration the smoke refuses, which is what proves that a red smoke rolls
  // the schema back and not only the containers.
  const migrations = path.join(repo, 'backend', 'migrations');
  mkdirSync(migrations, { recursive: true });
  const probe = path.join(migrations, '999_rehearsal_probe.sql');
  writeFileSync(probe, 'CREATE TABLE IF NOT EXISTS rehearsal_probe (id int);\n');
  inRepo('add', 'backend/migrations/999_rehearsal_probe.sql');
  inRepo('commit', '-qm', 'rehearsal C: a probe migration the smoke refuses');
  const C = head();

  // D: the backend exits at start, so the stack comes up and never answers. The
  // exit is the whole point of the row (R-5), so it is a real `process.exit` and not
  // a comment (OPS1 phase 5 — a no-op here made D deploy and smoke green).
  writeFileSync(server, '// OPS1 rehearsal D: the backend exits at start, on purpose.\n'
    + 'process.exit(1);\n');
  inRepo('commit', '-qam', 'rehearsal D: a backend that exits at start');
  const D = head();

  // Back to B for the runs: A and B are the releases the rollback moves between,
  // C proves the red smoke, D proves the health timeout.
  inRepo('switch', '-q', '--detach', B);
  return { A, B, C, D, branch: SCRATCH_BRANCH };
}

/** The rehearsal's `deploy.env`: no secret, and none of it reaches a server.
 * The path the scripts see is the POSIX form, because that is what they need. */
export function writeEnv(localRoot, port = PORT) {
  // `localRoot` is the host's own form (see `deployCommand`): docker's `--env-file`
  // accepts it, and a POSIX (`/c/…`) path would be resolved through the current
  // directory into a `C:\c\…` that does not exist.
  const dir = mkdtemp('vl-env-');
  const file = path.join(dir, 'deploy.env');
  writeFileSync(file, [
    '# The rehearsal\'s deploy.env (OPS1 phase 5). Nothing here is a secret, and',
    '# nothing here reaches a server: the local transport runs the same scripts',
    '# on this machine with DEPLOY_PATH as its root.',
    'DEPLOY_HOST=127.0.0.1',
    // Not the word the temp root uses: the pipeline's redactor replaces every
    // configured value, so a user named `rehearsal` would rewrite the rehearsal's
    // own paths out of its logs (OPS1 phase 5).
    'DEPLOY_USER=localuser',
    'DEPLOY_KEY=/dev/null',
    'DEPLOY_DOMAIN=rehearsal.invalid',
    `DEPLOY_PATH=${localRoot}`,
    'DEPLOY_PORT=22',
    `FRONTEND_PORT=${port}`,
  ].join('\n') + '\n');
  // The Windows form: the pipeline is a Node program, and it reads this file.
  return file.split(path.sep).join('/');
}

/** The stack's own `.env` in the rehearsal root, as a Windows path for Node. */
const stackEnv = localRoot => path.join(localRoot, 'shared', '.env');

/**
 * The one `down -v` in the task. It refuses unless every volume of the project
 * starts with `rehearsal_`: a rehearsal must never be able to name a volume it
 * did not create, and this is the check that keeps that true even if a compose
 * file later names something else.
 *
 * @param {string} project
 * @param {string[]} volumes — every volume name on this machine.
 * @returns {{allowed: boolean, foreign: string[]}}
 */
export function teardownGuard(project, volumes) {
  const foreign = (volumes ?? [])
    .map(name => name.trim())
    .filter(name => name.startsWith(`${project}_`) && !name.startsWith('rehearsal_'));
  return { allowed: foreign.length === 0, foreign };
}

/** The leftovers the plan's DW-5.3 asks about, printed for the notes. */
export function leftovers() {
  const volumes = sh('docker', ['volume', 'ls', '--format', '{{.Name}}']).split('\n')
    .map(name => name.trim()).filter(name => /^(rehearsal_|preflight_)/.test(name));
  const containers = sh('docker', ['ps', '-a', '--format', '{{.Names}}']).split('\n')
    .map(name => name.trim()).filter(name => /^(Rehearsal|Preflight)/.test(name));
  return { volumes, containers };
}

/** The live local stack's `StartedAt`, before and after (DW-5.3). */
export function liveStartedAt(container = 'VirtualLabFrontend') {
  try {
    return sh('docker', ['inspect', '--format', '{{.State.StartedAt}}', container]).trim();
  } catch {
    return 'not running';
  }
}

/**
 * The base images the hand-made stack builds from, present locally.
 *
 * This machine has no registry access, so a `FROM` that names a tag which is not on
 * disk fails the build: `backup/Dockerfile` says `alpine:3.20` and only `alpine:latest`
 * is present. The rehearsal tags what it has (a local alias, recorded in the notes)
 * rather than pulling — the hand-made stack's purpose is to prove adoption, not to
 * exercise a registry (OPS1 phase 5).
 */
function ensureBaseImages(aliases = [['alpine:3.20', 'alpine:latest']]) {
  const have = name => run('docker', ['image', 'inspect', name]).status === 0;
  for (const [wanted, local] of aliases) {
    if (!have(wanted) && have(local)) {
      const tag = run('docker', ['tag', local, wanted]);
      if (tag.status === 0) return [...aliases.map(([from]) => from), `${wanted} (from ${local})`];
    }
  }
  return aliases.map(([from]) => from);
}

/** A Docker answer that is only yes when the daemon is up. */
export function dockerUp() {
  try {
    sh('docker', ['version', '--format', '{{.Server.Version}}']);
    return true;
  } catch {
    return false;
  }
}

/**
 * The rehearsal's own projects, removed before the run.
 *
 * The stack's services restart (`unless-stopped`), so a Docker restart — or an
 * interrupted rehearsal — brings the previous run's containers back. They then
 * collide with the new run's names and its network: the backend answers
 * `getaddrinfo ENOTFOUND database` because its container was resurrected into a
 * network that no longer exists, and every deploy after the first fails at `up`
 * (OPS1 phase 5 — the plan's phase-5 edge case, "rehearse.mjs cleans its own
 * projects first").
 *
 * @returns {{removed: string[]}} what was removed, for the run's own record.
 */
export function cleanProjects(projects = [PROJECT, HAND_PROJECT], { ask = sh, do_ = run } = {}) {
  const removed = [];
  for (const project of projects) {
    const label = `label=com.docker.compose.project=${project}`;
    const containers = ask('docker', ['ps', '-aq', '--filter', label])
      .split('\n').map(name => name.trim()).filter(Boolean);
    if (containers.length > 0) {
      // The restart policy first: `unless-stopped` brings a container back moments
      // after `rm -f`, so a cleanup that does not disable it removes nothing and the
      // next run collides with it (OPS1 phase 5).
      do_('docker', ['update', '--restart=no', ...containers]);
      do_('docker', ['rm', '-f', '-v', ...containers]);
      removed.push(...containers);
    }
    // The network the project created: a container that restarts has nothing to
    // join without it, which is the ENOTFOUND above. Only its own default — a
    // network somebody else named the same way is not the rehearsal's — and only
    // once its containers are gone, or it still has active endpoints.
    const networks = ask('docker', ['network', 'ls', '--format', '{{.Name}}'])
      .split('\n').map(name => name.trim())
      .filter(name => name === `${project}_default`);
    for (const network of networks) {
      const answer = do_('docker', ['network', 'rm', network]);
      if (answer.status === 0) removed.push(network);
    }
  }
  return { removed };
}

/** The scratch tree a hand-made stack is built from: `git archive`, not a clone. */
function handTree(destination) {
  const archive = spawnSync('git', ['-C', VL_REPO, 'archive', 'HEAD'], {
    encoding: 'buffer', maxBuffer: 1 << 26,
  });
  if (archive.status !== 0) throw new Error('git archive of the rehearsal tree failed');
  mkdirSync(destination, { recursive: true });
  // No `-C <drive path>` (this `tar` reads a drive letter as a remote host), no `-z`
  // (`git archive` writes an uncompressed tar) and no `.` operand (the archive lists
  // its own files, so `tar: .: Not found in archive`) — three separate failures the
  // first R-7 runs hit (OPS1 phase 5).
  const unpack = run('tar', ['-xf', '-'], {
    cwd: destination, input: archive.stdout, maxBuffer: 1 << 26,
  });
  if (unpack.status !== 0) throw new Error(unpack.stderr || `tar exited ${unpack.status}`);
}

/**
 * The images a rehearsal run needs, built from the commits it deploys — with the
 * pipeline's own `buildCommands`, so the rehearsal proves the build description
 * too.
 *
 * The frontend and backup images are identical across the four commits, so they
 * are built once and tagged; the *backend* differs in C (a migration file the
 * database applies at start) and in D (a process that exits), so it is built per
 * commit — which is what makes R-4 and R-5 real rather than simulated. A release
 * is identified by its tag, and `/api/health` reports the commit `release.env`
 * pins, so re-tagging the unchanged images is honest: the release id, the commit
 * and the behaviour all stay what the deploy says they are.
 *
 * @param {{A: string, B: string, C: string, D: string}} commits
 */
async function buildImages(commits) {
  const { buildCommands } = await import('./lib/build.mjs');
  const started = Date.now();
  const build = (service, sha) => {
    // The image is built from the tree of that commit, so the worktree is moved
    // there first: a build from the branch's HEAD would build B four times and
    // call it A, C and D.
    sh('git', ['-C', VL_REPO, 'switch', '-q', '--detach', sha]);
    const command = buildCommands({ vlRepo: VL_REPO, edRepo: '', vl: sha, ed: null, editor: false })
      .find(c => c.service === service);
    const answer = run('docker', command.argv, { cwd: VL_REPO, env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    if (answer.status !== 0) {
      throw new Error(`building ${service} at ${SHORT_(sha)} failed: ${answer.stderr.slice(-400)}`);
    }
  };
  const tag = (service, from, to) => {
    const answer = run('docker', ['tag', `virtual-lab/${service}:${from}`, `virtual-lab/${service}:${to}`]);
    if (answer.status !== 0) throw new Error(`tagging ${service} ${SHORT_(from)} → ${SHORT_(to)} failed`);
  };
  for (const commit of [commits.A, commits.B, commits.C, commits.D]) build('backend', commit);
  // The frontend and backup images are the same in all four, so one build of each
  // (at A) is tagged for the rest.
  build('frontend', commits.A);
  build('backup', commits.A);
  for (const commit of [commits.B, commits.C, commits.D]) {
    tag('frontend', commits.A, commit);
    tag('backup', commits.A, commit);
  }
  sh('git', ['-C', VL_REPO, 'switch', '-q', SCRATCH_BRANCH]);
  process.stdout.write(`images: backend x4, frontend and backup tagged from ${SHORT_(commits.A)} `
    + `(${((Date.now() - started) / 1000).toFixed(0)}s)\n`);
}

// ── the run ───────────────────────────────────────────────────────────────────

async function main(argv = process.argv.slice(2)) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      flags[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    }
  }

  // The vl-db lock: a rehearsal runs the whole Docker stack, and the rule is that
  // a fixed-port resource is touched inside its lock.
  const lock = flags.lock ? path.resolve(String(flags.lock)) : path.join(ROOT, '.workers', 'locks', 'vl-db.lock');
  if (existsSync(lock)) {
    try { writeFileSync(path.join(lock, 'heartbeat'), `rehearsal ${new Date().toISOString()}\n`); } catch { /* a lock that vanished is not the rehearsal's problem */ }
  } else {
    process.stderr.write(`rehearse: ${lock} is not held — run wk.sh lock vl-db first\n`);
    return 3;
  }

  if (!dockerUp()) {
    process.stderr.write('rehearse: the Docker daemon is not running\n');
    return 3;
  }
  if (sh('git', ['-C', VL_REPO, 'status', '--porcelain']).trim() !== '') {
    process.stderr.write('rehearse: the worktree is not clean — commit or stash, then rehearse\n');
    return 3;
  }

  // The rehearsal's own projects from an interrupted run: their services restart,
  // so a Docker restart brings them back and they collide with this one (see
  // `cleanProjects`).
  const cleaned = cleanProjects();
  if (cleaned.removed.length > 0) {
    process.stdout.write(`cleaned from an interrupted run: ${cleaned.removed.join(', ')}\n`);
  }

  const only = flags.only ? String(flags.only).split(',') : null;
  const want = step => !only || only.includes(step);
  const recorder = createRecorder();
  const log = createLog();
  const started = liveStartedAt();
  // The branch the pipeline is on: the rehearsal cuts its commits from it, because
  // a run from `origin/main` would remove the pipeline from the worktree it runs in.
  const base = flags.base ? String(flags.base) : 'OPS1-deploy-pipeline';

  let localRoot = mkdtemp('vl-rehearsal-');
  let envFile = writeEnv(localRoot);
  let handRepo = null;
  let handEnv = null;

  /**
   * One deploy step: run it, log its whole output, put it in the table — and say
   * *why* it is red when it is, because a row that says "FAIL exit 10" without the
   * line that explains it is a table nobody can act on.
   */
  const step = async (label, expected, command, extra = []) => {
    const answer = deployCommand({ envFile, localRoot }, command, extra);
    log.push(`node ops/deploy/deploy.mjs ${command} platform ${extra.join(' ')}`, answer);
    const code = await recorder.row(label, expected, () => answer.status);
    if (code !== expected) {
      process.stdout.write('     --- why:\n');
      for (const line of `${answer.stdout}${answer.stderr}`.trim().split('\n').slice(-12)) {
        if (line !== '') process.stdout.write(`     ${line}\n`);
      }
    }
    return answer;
  };

  /** Bring the branch the task was on back, and delete the scratch branch. */
  const finish = () => {
    sh('git', ['-C', VL_REPO, 'switch', '-q', base]);
    if (!flags.keep) sh('git', ['-C', VL_REPO, 'branch', '-qD', SCRATCH_BRANCH]);
    const left = leftovers();
    process.stdout.write(`     volumes left: ${left.volumes.length === 0 ? 'none' : left.volumes.join(', ')}\n`);
    process.stdout.write(`     containers left: ${left.containers.length === 0 ? 'none' : left.containers.join(', ')}\n`);
    process.stdout.write(`     live stack StartedAt: ${liveStartedAt()} (was ${started})\n`);
    return left;
  };

  /** Remove the rehearsal's own projects and its temp directories. */
  const teardown = () => {
    for (const project of [PROJECT, HAND_PROJECT]) {
      const guard = teardownGuard(project, sh('docker', ['volume', 'ls', '--format', '{{.Name}}']).split('\n'));
      if (!guard.allowed) {
        process.stdout.write(`teardown refused: ${project} owns volumes that are not rehearsal ones: ${guard.foreign.join(', ')}\n`);
        continue;
      }
      const root = project === PROJECT ? localRoot : handRepo;
      if (!root) continue;
      // The compose list is what names the volumes; the project name is what owns
      // them. Both come from this run.
      composeCommand(root, COMPOSE_FILES, ['down', '-v', '--remove-orphans'],
        { envFile: project === PROJECT ? envFile : handEnv, cwd: project === PROJECT ? undefined : handRepo });
    }
    // Only the directories this run actually created: a step that threw before a root
    // exists must not turn into a second failure during the teardown.
    for (const dir of [localRoot, handRepo, path.dirname(envFile)].filter(Boolean)) {
      // `--keep` leaves the roots behind for inspection: a rehearsal that failed
      // at the backup is a failure whose evidence is on the host, not in the log
      // (OPS1 phase 5).
      if (flags.keep) {
        process.stdout.write(`kept: ${dir}\n`);
        continue;
      }
      rmSync(dir, { recursive: true, force: true });
    }
    return true;
  };

  try {
    const commits = scratchCommits(base);
    process.stdout.write(`rehearsal: A=${SHORT_(commits.A)} B=${SHORT_(commits.B)} `
      + `C=${SHORT_(commits.C)} D=${SHORT_(commits.D)}\n`);
    // The images the deploys run: built from the very commits they deploy, with
    // the pipeline's own build description.
    await buildImages(commits);

    // R-1 — a fresh install on an empty root. The backup is `none`, and the record
    // says so, which is what the rollback's restore decision reads.
    if (want('R-1')) {
      // The release is cut from A, so the worktree is at A: the bundle the deploy
      // uploads is read from there.
      sh('git', ['-C', VL_REPO, 'switch', '-q', '--detach', commits.A]);
      // Exit 10, not the plan's 0: a fresh install has an empty catalog, and the
      // smoke's own contract ("catalog is empty — publish the release first")
      // makes that a red smoke — so the deploy rolls back, and a rollback of a
      // fresh install has no database to restore (DW-5.1's expectation, recorded
      // as a deviation in the notes). R-2 is what makes a green smoke possible.
      await step('R-1 deploy A on an empty root', 10, 'deploy');
      const record = readRecord(localRoot);
      process.stdout.write(`     backup: ${record.current?.backup ?? 'none (fresh install)'}`
        + `\n     release: ${record.current?.id ?? 'none'}\n`);
    }

    // R-2 — the catalog the smoke reads, and the marker row a rollback must not
    // lose. The stack is brought back up first, because R-1's red smoke took it
    // down: a fresh host has nothing published, and publishing needs the stack.
    if (want('R-2')) {
      const releaseA = `vl-${SHORT_(commits.A)}`;
      const up = run('bash', [path.join(HERE, 'remote', 'up.sh'),
        localRoot, releaseA, PROJECT, COMPOSE_FILES, // the release R-1 uploaded
      ], { env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
      log.push('node ops/deploy/remote/up.sh (bring A back)', up);
      const healthy = up.status === 0 ? healthCommit() : null;
      process.stdout.write(`     A up again: ${up.status === 0 ? 'ok' : `exit ${up.status}`}`
        + `${up.status === 0 ? '' : ` ${up.stderr.trim().split('\n').slice(-2).join(' | ')}`}`
        + `\n     health: ${healthy === commits.A ? 'A' : healthy}\n`);
      if (up.status === 0) {
        // A is now running on this host, so the record says so: the rollback chain
        // R-6 walks (B → A) is only as long as the record, and a release brought up
        // by hand is exactly what a record is for (OPS1 phase 5).
        const recorded = run('bash', [path.join(HERE, 'remote', 'state.sh'),
          localRoot, 'write', releaseA, commits.A, commits.A, 'false', '',
        ], { env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
        log.push('node ops/deploy/remote/state.sh write (A is running)', recorded);
        const record = readRecord(localRoot);
        process.stdout.write(`     record current: ${record.current?.id ?? 'none'}\n`);
      }
      if (up.status === 0) {
        const publish = run('npm', ['run', 'publish:release', '--', '--base-url', `http://127.0.0.1:${PORT}`], {
          cwd: path.join(VL_REPO, 'backend'),
          env: {
            ...process.env, ADMIN_TOKEN: envValue(stackEnv(localRoot), 'ADMIN_TOKEN'),
            PUBLISH_BASE_URL: `http://127.0.0.1:${PORT}`, MSYS_NO_PATHCONV: '1',
          },
        });
        log.push('npm run publish:release', publish);
        // The publish reports every archive it could not classify and then exits
        // non-zero, while still publishing the ones it could: `created` (or
        // `approved`) rows are what a seeded catalog means (OPS1 phase 5).
        const created = (publish.stdout.match(/^\s+(created|updated)\s*$/gm) ?? []).length;
        const marker = query(localRoot, COMPOSE_FILES, stackEnv(localRoot), MARKER);
        process.stdout.write(`     catalog: ${created > 0 ? `${created} archived(s) published` : 'publish FAILED'}`
          + `\n     marker row: ${marker === 'INSERT 0 1' ? 'inserted' : marker}\n`);
      }
    }

    // R-3 — a second release: the backup is verified, nothing migrated, and the
    // health commit is B. The pin is what makes the second release real.
    if (want('R-3')) {
      sh('git', ['-C', VL_REPO, 'switch', '-q', '--detach', commits.B]);
      await step('R-3 deploy B (a no-op that still deploys)', 0, 'deploy');
      const record = readRecord(localRoot);
      const health = healthCommit();
      process.stdout.write(`     backup verified: ${Boolean(record.current?.backup)}`
        + `\n     migrated: ${record.current?.migrated === true}`
        + `\n     health commit: ${health === commits.B ? 'B' : health}\n`);
    }

    // R-4 — a migration the smoke refuses. The rollout goes back, the marker row
    // survives: that is the whole of D-10 in one row. The probe migration's table
    // *survives* the restore, because `restore.mjs` drops exactly what the dump's
    // `--clean` covers (docs/backup-restore.md) and a dump taken before that
    // migration does not cover a table that did not exist yet. Rolling that back too
    // wants a full-schema restore (`DROP SCHEMA public CASCADE` first), which is a
    // follow-up row rather than this one (OPS1 phase 5 — recorded in the notes).
    if (want('R-4')) {
      sh('git', ['-C', VL_REPO, 'switch', '-q', '--detach', commits.C]);
      await step('R-4 deploy C with the smoke pinned to a wrong commit', 10, 'deploy',
        ['--smoke-expect-commit', '0'.repeat(40)]);
      const probe = query(localRoot, COMPOSE_FILES, stackEnv(localRoot),
        "select count(*) from information_schema.tables where table_schema = 'public' and table_name = 'rehearsal_probe'");
      const marker = query(localRoot, COMPOSE_FILES, stackEnv(localRoot),
        MARKER_COUNT);
      const health = healthCommit();
      const record = readRecord(localRoot);
      process.stdout.write(`     rehearsal_probe exists: ${probe}`
        + `\n     marker row present: ${marker}`
        + `\n     migrations recorded: ${query(localRoot, COMPOSE_FILES, stackEnv(localRoot), 'select count(*) from schema_migrations')}`
        + `\n     health commit: ${health === commits.B ? 'B' : health}`
        + `\n     record current: ${record.current?.id ?? 'none'} (the rollback wrote it)\n`);
    }

    // R-5 — a backend that never becomes healthy: the stack is rolled back and the
    // database is not, because this deploy added no migration and there is no
    // "after" to compare against — "it may have migrated" is the safe answer.
    if (want('R-5')) {
      sh('git', ['-C', VL_REPO, 'switch', '-q', '--detach', commits.D]);
      const answer = await step('R-5 deploy D (backend exits at start)', 10, 'deploy');
      const restored = answer.stdout.includes('restore-db.sh');
      const marker = query(localRoot, COMPOSE_FILES, stackEnv(localRoot),
        MARKER_COUNT);
      const health = healthCommit();
      process.stdout.write(`     restore-db in the log: ${restored}`
        + `\n     marker row present: ${marker}`
        + `\n     health commit: ${health === commits.B ? 'B' : health}\n`);
    }

    // R-6 — the rollback command, from B back to A.
    if (want('R-6')) {
      sh('git', ['-C', VL_REPO, 'switch', '-q', '--detach', commits.B]);
      await step('R-6 rollback (B -> A)', 0, 'rollback');
      const health = healthCommit();
      process.stdout.write(`     health commit: ${health === commits.A ? 'A' : health}\n`);
    }

    // R-7 — adoption: a hand-made stack with its own secrets, which the pipeline
    // keeps byte for byte, and a database it already owns.
    if (want('R-7')) {
      handRepo = mkdtemp('vl-hand-');
      handTree(handRepo);
      // The base images it builds from, on disk: this machine has no registry.
      const bases = ensureBaseImages();
      const shared = path.join(handRepo, 'root', 'shared');
      mkdirSync(shared, { recursive: true });
      // The operator's own secrets, written before the pipeline ever sees the host.
      handEnv = path.join(shared, '.env');
      writeFileSync(handEnv, [
        'DB_HOST=database', 'DB_PORT=5432', 'DB_NAME=virtual_lab', 'DB_USER=lab_user',
        'DB_PASSWORD=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        'API_PORT=3000', 'ADMIN_TOKEN=0123456789abcdef0123456789abcdef0123456789abcdef',
        `FRONTEND_PORT=${HAND_PORT}`, 'TRUST_PROXY=1', 'BACKUP_KEEP_DAYS=14', 'BACKUP_SCHEDULE_HOURS=24',
      ].join('\n') + '\n');
      const adoption = await recorder.row('R-7 adopt a hand-made stack', 0, async () => {
        const up = run('docker', ['compose', '-p', HAND_PROJECT,
          // The rehearsal's own compose file, so the hand-made stack's containers and
          // volumes are renamed (`Rehearsal*`, `rehearsal_*`): the base compose pins
          // `VirtualLab*`, which the live local stack on 8044 is already using — and a
          // rehearsal must never collide with it (OPS1 phase 5; the plan's R-7 says
          // "docker compose -p vlhand with compose.rehearsal.yml").
          '--file', 'docker-compose.yml', '--file', 'ops/deploy/compose.rehearsal.yml',
          // The docker CLI resolves `--env-file` itself, so it gets the host's own
          // form; a POSIX path here becomes `C:\c\…`, which does not exist
          // (OPS1 phase 5).
          '--env-file', handEnv, 'up', '-d', '--build'], {
          cwd: handRepo,
          // And the base compose reads its `env_file` from this variable, exactly as
          // `remote/up.sh` sets it: the tree has no `.env` of its own, because the
          // operator's secrets are in `root/shared/.env` (OPS1 phase 5).
          env: { ...process.env, MSYS_NO_PATHCONV: '1', VL_SHARED_ENV: handEnv },
        });
        log.push('docker compose -p vlhand up -d --build', up);
        if (up.status !== 0) return up.status;
        process.stdout.write(`     hand stack built on: ${bases.join(', ')}\n`);
        const marker = query(handRepo, COMPOSE_FILES, handEnv, MARKER.replace('a rollback must not lose', 'adoption must not lose'), { cwd: handRepo });
        process.stdout.write(`     marker row in the hand stack: ${marker === 'INSERT 0 1' ? 'inserted' : marker}\n`);
        return 0;
      });

      if (adoption === 0) {
        // A *new* root, seeded with the operator's own `.env`: `prepare` must keep
        // it byte for byte, which is the one thing that makes a hand-made
        // deployment safe to hand over (D-12).
        const adoptedRoot = mkdtemp('vl-adopt-');
        mkdirSync(path.join(adoptedRoot, 'shared'), { recursive: true });
        writeFileSync(path.join(adoptedRoot, 'shared', '.env'), readFileSync(handEnv));
        const before = sha256(handEnv);
        localRoot = adoptedRoot;
        envFile = writeEnv(localRoot);
        await step('R-7 adopt and deploy', 0, 'deploy');
        const marker = query(localRoot, COMPOSE_FILES, stackEnv(localRoot),
          MARKER_COUNT);
        process.stdout.write(`     .env byte-identical: ${sha256(handEnv) === before}`
          + `\n     marker row present: ${marker}\n`);
      }
    }
  } finally {
    // Whatever happened, the rehearsal leaves nothing running and no branch
    // behind — including when a step threw, which is the case the finally is for.
    try { teardown(); } catch (err) { process.stderr.write(`rehearse: teardown: ${err.message}\n`); }
    const left = finish();
    // The log goes outside every worktree: an untracked file inside one would fail
    // the fresh-source gate the deploy itself refuses to run without (which is how
    // the first run's notes file blocked the second).
    const notes = flags.notes
      ? path.resolve(String(flags.notes))
      : path.join(ROOT, '.workers', 'logs', `rehearsal-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
    mkdirSync(path.dirname(notes), { recursive: true });
    writeFileSync(notes, log.text());
    process.stdout.write(`log: ${notes}\n`);
    rmSync(path.dirname(envFile), { recursive: true, force: true });
    if (left.volumes.length > 0 || left.containers.length > 0) {
      process.stderr.write('rehearse: the rehearsal left containers or volumes behind\n');
      return 3;
    }
  }

  process.stdout.write(`\n${recorder.failed ? 'REHEARSAL RED' : 'rehearsal green'} — `
    + `${recorder.rows.filter(r => r.ok).length}/${recorder.rows.length} rows as expected\n`);
  return recorder.failed ? 1 : 0;
}

// Run as a command when this file is the entry point — importing it (the test)
// must not start a rehearsal.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(code => process.exit(code)).catch(err => {
    process.stderr.write(`rehearse: ${err.message}\n`);
    process.exit(1);
  });
}