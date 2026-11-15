// ops/deploy/lib/transport.mjs
//
// Two ways to run the same remote script (decision D-14): `ssh` against a real
// host, `local` with `bash -s` on this machine — and a `dryRun` that prints what
// it would run and touches nothing. The pipeline never knows which one it has,
// which is what makes the rehearsal a proof of the production procedure rather
// than a rehearsal of a rehearsal.
//
// Every value a script needs is an argument, quoted by the one tested `shq()`:
// nothing is interpolated into a script body, so a path cannot become a command.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { basename } from 'node:path';
import { shq, shqArgs } from './shq.mjs';

/**
 * Runs a child and resolves with its exit status and output.
 *
 * @param {string} command the executable.
 * @param {string[]} argv
 * @param {import('node:stream').Readable} [stdin]
 * @param {NodeJS.ProcessEnv} [env] — extra environment for the child.
 */
function runChild(command, argv, stdin, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { stdio: ['pipe', 'pipe', 'pipe'], env: env ? { ...process.env, ...env } : undefined });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', code => resolve({
      code: code ?? -1,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
    if (stdin) stdin.pipe(child.stdin);
    else child.stdin.end();
  });
}

/**
 * On Windows the local transport runs the same scripts through Git Bash, whose
 * MSYS layer rewrites any argument that *looks* like a path before it reaches a
 * Windows binary — `/c/Users/...` became `C:/Program Files/Git/...`, and a mount
 * source pointed at the Git installation instead of the host's disk. Setting this
 * once here fixes every `docker` call the scripts make (Docker Desktop accepts
 * the MSYS form itself).
 *
 * It is deliberately an empty object on every other platform: nothing changes
 * where the problem does not exist.
 */
const MSYS_GUARD = process.platform === 'win32' ? { MSYS_NO_PATHCONV: '1' } : {};

/** The ssh options that make a deploy unattendable and host-key-strict (D-13). */
function sshOptions(cfg, knownHostsPath) {
  return [
    '-p', String(cfg.DEPLOY_PORT),
    '-i', cfg.DEPLOY_KEY,
    // Never interactive: a deploy that stops to ask a question hangs until the
    // window closes.
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    // A host key we have not seen is a host key we do not talk to. The one the
    // operator pinned is written to the known-hosts file by the wrapper before
    // any call; without it the connection fails. (TOFU is `inspect
    // --trust-new-host`, once, and the fingerprint goes to ATTENTION.)
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${knownHostsPath}`,
  ];
}

/**
 * The ssh transport: the script travels on stdin to `bash -s --` on the host,
 * with its arguments as positioned parameters.
 *
 * @param {object} cfg — a parsed `deploy.env`.
 * @param {string} knownHostsPath — where the pinned host key lives.
 */
export function sshTransport(cfg, knownHostsPath) {
  const target = `${cfg.DEPLOY_USER}@${cfg.DEPLOY_HOST}`;
  const base = [...sshOptions(cfg, knownHostsPath), target];

  return {
    kind: 'ssh',
    /**
     * The path list separator of the machine the scripts run on: a Linux host
     * joins `COMPOSE_FILE` entries with `:`, a Windows one with `;` (compose-go
     * splits on the OS separator). The pipeline asks the transport, because only
     * the transport knows where the script runs.
     */
    listSeparator: ':',
    /** Runs `scriptFile` on the host with `args` as `$1…$n`. */
    async run(scriptFile, args = []) {
      const script = await readFile(scriptFile, 'utf8');
      return runChild('ssh', [...base, 'bash -s --', ...shqArgs(args)], Readable.from([script]));
    },
    /**
     * Streams a tarball into the host's `gunzip | docker load` (decision D-2).
     * `fixedCommand` is the only string ever sent as a command; the values it
     * needs travel as quoted positional arguments after `_`.
     */
    async pipeIn(readable, fixedCommand = 'gunzip | docker load', args = []) {
      const command = ['bash', '-c', fixedCommand, '_', ...shqArgs(args)].join(' ');
      return runChild('ssh', [...base, command], readable);
    },
    describe: () => `ssh ${target}`,
  };
}

/** The local transport: the same scripts, `bash -s` on this machine. */
export function localTransport() {
  return {
    kind: 'local',
    // `;` on this machine (see MSYS_GUARD): compose splits `COMPOSE_FILE` on the
    // OS separator, and a colon-joined list is one long invalid path here.
    listSeparator: process.platform === 'win32' ? ';' : ':',
    async run(scriptFile, args = []) {
      const script = await readFile(scriptFile, 'utf8');
      return runChild('bash', ['-s', '--', ...shqArgs(args)], Readable.from([script]), MSYS_GUARD);
    },
    async pipeIn(readable, fixedCommand = 'gunzip | docker load', args = []) {
      // Raw arguments, never `shq`-quoted: `spawn` hands argv to the child as it
      // is, so a quoted word arrives with its quotes *in* the value — and
      // `$1` would be `'/srv/…'`, which is not a path (OPS1 phase 5). The ssh
      // transport quotes because its command string *is* parsed by the remote
      // shell; here nothing parses it.
      return runChild('bash', ['-c', fixedCommand, '_', ...args], readable, MSYS_GUARD);
    },
    describe: () => 'local (this machine)',
  };
}

/**
 * The fixed command that unpacks a streamed release bundle into `$1/$2.tmp` and
 * renames it when complete. It is `remote/upload-bundle.sh` as one line, so both
 * transports run *the same procedure* rather than a local shortcut — which is
 * what makes a rehearsal a proof of the production upload (D-14).
 *
 * `$1` and `$2` are inside single quotes on the way through the shell, so they
 * reach `bash -c` as positional parameters and never as a substituted command
 * (D-13).
 */
export const UPLOAD_BUNDLE_COMMAND = 'set -euo pipefail; D="$1"; I="$2"; T="$D/$I.tmp"; ' +
  'rm -rf "$T"; mkdir -p "$T"; tar -xzf - -C "$T"; mv "$T" "$D/$I"; ' +
  'echo "release_dir=$D/$I"; echo "upload_ok=1"';

/**
 * What each script would answer on a real run, so a dry run walks the whole
 * sequence instead of stopping at the first script whose fields it reads. The
 * values are placeholders — a dry run contacts nothing, so nothing is real.
 */
const DRY_RUN_ANSWERS = {
  'inspect.sh': 'os=linux\narch=x86_64\ndocker=present\nuser_docker=true\n',
  'backup.sh': 'backup_name=<stub>\nbackup_path=<stub>\nbackup_ok=1\n',
  'verify-backup.sh': 'verified=1\ntables=0\nverify_ok=1\n',
  'migrations.sh': 'migrations=<stub>\nmigrations_ok=1\n',
  'upload-bundle.sh': 'release_dir=<stub>\nupload_ok=1\n',
  'wait-healthy.sh': 'healthy=1\nchecks=0\nwait_ok=1\n',
  // A dry run describes the *general* case — a host that already runs a release,
  // which is every deploy except the first. It cannot ask, so it says so in the
  // plan: the fresh-install path skips backup, verify and the before-migrations.
  'state.sh': '{"current":{"id":"vl-dryrun1","commit":"' + '0'.repeat(40) + '","migrated":false},"previous":null,"history":[]}\n',
  'prune.sh': 'prune_ok=1\n',
  'stop.sh': 'stopped=1\nstop_ok=1\n',
  'restore-db.sh': 'restored=<stub>\nrestore_ok=1\n',
};

/** A dry run that prints and succeeds — the operator's proof of what would run. */
export function dryRunTransport(print) {
  return {
    kind: 'dry-run',
    // A dry run describes a host, and the host is Linux.
    listSeparator: ':',
    async run(scriptFile, args = []) {
      print(`would run ${scriptFile} :: ${args.map(a => JSON.stringify(a)).join(' ')}`);
      const name = basename(scriptFile);
      return { code: 0, stdout: DRY_RUN_ANSWERS[name] ?? 'ok=1\n', stderr: '' };
    },
    async pipeIn(readable, fixedCommand, args = []) {
      print(`would stream images through :: ${fixedCommand} :: ${shqArgs(args).join(' ')}`);
      return { code: 0, stdout: '', stderr: '' };
    },
    describe: () => 'dry-run (nothing contacted)',
  };
}

/**
 * A transport that records what it was asked to run, for the tests.
 * `answers` is optional, either a list of `{code, stdout}` in call order or a
 * function of `(script, args, callNumber)`.
 */
export function recordingTransport(answers = []) {
  const calls = [];
  return {
    kind: 'recording',
    calls,
    // The tests describe a Linux host.
    listSeparator: ':',
    async run(scriptFile, args = []) {
      calls.push({ script: scriptFile, args });
      const answer = typeof answers === 'function'
        ? answers(scriptFile, args, calls.length)
        : (answers[calls.length - 1] ?? {});
      return { code: answer.code ?? 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' };
    },
    async pipeIn(readable, fixedCommand, args = []) {
      calls.push({ script: 'pipeIn', fixedCommand, args });
      return { code: 0, stdout: '', stderr: '' };
    },
    describe: () => 'recording',
  };
}
