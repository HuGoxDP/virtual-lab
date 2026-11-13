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
import { shqArgs } from './shq.mjs';

/**
 * Runs a child and resolves with its exit status and output.
 *
 * @param {string} command the executable.
 * @param {string[]} argv
 * @param {import('node:stream').Readable} [stdin]
 */
function runChild(command, argv, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
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
    /** Runs `scriptFile` on the host with `args` as `$1…$n`. */
    async run(scriptFile, args = []) {
      const script = await readFile(scriptFile, 'utf8');
      return runChild('ssh', [...base, 'bash -s --', ...shqArgs(args)], Readable.from([script]));
    },
    /**
     * Streams a tarball into the host's `gunzip | docker load` (decision D-2).
     * `fixedCommand` is the only string ever sent as a command.
     */
    async pipeIn(readable, fixedCommand = 'gunzip | docker load') {
      return runChild('ssh', [...base, fixedCommand], readable);
    },
    describe: () => `ssh ${target}`,
  };
}

/** The local transport: the same scripts, `bash -s` on this machine. */
export function localTransport() {
  return {
    kind: 'local',
    async run(scriptFile, args = []) {
      const script = await readFile(scriptFile, 'utf8');
      return runChild('bash', ['-s', '--', ...shqArgs(args)], Readable.from([script]));
    },
    async pipeIn(readable, fixedCommand = 'gunzip | docker load') {
      return runChild('bash', ['-c', fixedCommand], readable);
    },
    describe: () => 'local (this machine)',
  };
}

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
  'state.sh': 'state_ok=1\n',
  'prune.sh': 'prune_ok=1\n',
  'stop.sh': 'stopped=1\nstop_ok=1\n',
  'restore-db.sh': 'restored=<stub>\nrestore_ok=1\n',
};

/** A dry run that prints and succeeds — the operator's proof of what would run. */
export function dryRunTransport(print) {
  return {
    kind: 'dry-run',
    async run(scriptFile, args = []) {
      print(`would run ${scriptFile} :: ${args.map(a => JSON.stringify(a)).join(' ')}`);
      const name = basename(scriptFile);
      return { code: 0, stdout: DRY_RUN_ANSWERS[name] ?? 'ok=1\n', stderr: '' };
    },
    async pipeIn(readable, fixedCommand) {
      print(`would stream images through :: ${fixedCommand}`);
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
    async run(scriptFile, args = []) {
      calls.push({ script: scriptFile, args });
      const answer = typeof answers === 'function'
        ? answers(scriptFile, args, calls.length)
        : (answers[calls.length - 1] ?? {});
      return { code: answer.code ?? 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' };
    },
    async pipeIn(readable, fixedCommand) {
      calls.push({ script: 'pipeIn', fixedCommand });
      return { code: 0, stdout: '', stderr: '' };
    },
    describe: () => 'recording',
  };
}
