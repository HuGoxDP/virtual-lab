// ops/deploy/lib/log.mjs
//
// One logger for the whole pipeline (decision D-13): every line goes through the
// redactor before it can reach stdout or a file, and child process output is
// streamed through it line by line rather than buffered, so a long deploy shows
// its progress and a redacted value never lands in a log file.
//
// Logs live under `--log-dir` (the worker's own `.workers/W<n>/deploy-logs/`),
// which is not a repo and never pushed.

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { makeRedactor } from './redact.mjs';

/** UTC, sortable, safe in a filename. */
export function stamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-').replace(/z$/, 'Z');
}

/**
 * A logger that redacts everything it writes.
 *
 * @param {object} options
 * @param {(text: string) => string} options.redact — from `lib/redact.mjs`
 * @param {string} [options.dir] — where the log file lives; none means stdout only
 * @param {string} [options.command] — the command, for the file name
 * @param {() => Date} [options.now] — injectable clock (tests)
 */
export function createLogger({ redact, dir = null, command = 'deploy', now = () => new Date() }) {
  let file = null;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    file = path.join(dir, `${stamp(now())}-${command}.log`);
  }

  const write = text => {
    const safe = redact(text);
    if (file) appendFileSync(file, `${safe}\n`);
    process.stdout.write(`${safe}\n`);
  };

  return {
    /** The log file, or null when the logger only writes to stdout. */
    get file() { return file; },
    write,
    info: text => write(`[deploy] ${text}`),
    step: name => write(`── ${name}`),
    warn: text => write(`[deploy][warn] ${text}`),
    /** A child process's stdout/stderr, streamed in as it arrives. */
    child(name, stream) {
      let buffer = '';
      stream.on('data', chunk => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) write(`[${name}] ${line}`);
      });
      stream.on('end', () => { if (buffer.trim() !== '') write(`[${name}] ${buffer}`); });
    },
  };
}
