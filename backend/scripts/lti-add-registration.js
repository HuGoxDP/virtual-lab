#!/usr/bin/env node
// backend/scripts/lti-add-registration.js
//
// P1c: writes the `lti_registrations` row for a MANUAL platform registration.
//
// Why this exists: the tool learns a platform only through Dynamic Registration
// (`lti/registration.js` is the only caller of `store.saveRegistration`), and `lti/launch.js`
// answers 403 «Платформа не зареєстрована» for any other issuer. An admin whose Moodle blocks
// dynamic registration can fill Moodle's tool form all day — that form configures Moodle, not
// this tool. This script is the tool's half. Run once from the checkout:
//
//   docker compose exec backend node scripts/lti-add-registration.js \
//     --from-moodle https://moodle.example.edu --client-id <id> --deployment-id <id>
//   docker compose exec backend node scripts/lti-add-registration.js --issuer https://… \
//     --client-id … --deployment-id … --auth-login-url … --auth-token-url … --jwks-uri …
//   … --dry-run          validate and print the row, write nothing
//
// `--from-moodle <base-url>` fills the three platform endpoints from Moodle's own `/mod/lti/…`
// paths under that base and takes the issuer to be that base without trailing slashes (Moodle's
// issuer IS its wwwroot, sub-path included); `--issuer` overrides it for a Moodle behind a
// different public host, and explicit endpoint flags override individual Moodle defaults
// (each is validated: https, on the issuer's origin). The issuer is stored exactly as given.
//
// It talks to the database directly (unlike `publish-release.mjs`, which goes through the API):
// registrations have no write endpoint by design, and adding one would be a remote-write surface
// for no benefit — an admin with shell access already has the database.
//
// Every rule lives in `lti/manual-registration.js`, so it is testable without a database.

'use strict';

const { pool } = require('../db');
const { createStore } = require('../lti/store');
const { normaliseRegistration, MOODLE_ENDPOINTS } = require('../lti/manual-registration');

const USAGE = `Usage:
  node scripts/lti-add-registration.js --issuer <url> --client-id <id> --deployment-id <id[,id]>
      --auth-login-url <url> --auth-token-url <url> --jwks-uri <url> [--dry-run]
  node scripts/lti-add-registration.js --from-moodle <moodle-base-url> --client-id <id>
      --deployment-id <id[,id]> [--issuer <url>] [--dry-run]

  --from-moodle <base-url>  take the endpoints from Moodle's own /mod/lti/… paths under it;
                            an explicit --auth-login-url/--auth-token-url/--jwks-uri overrides
                            one default (validated: https, on the issuer's origin)
  --dry-run                 validate and print the row, write nothing

Moodle side: Site administration → Plugins → Activity modules → External tool → Manage tools →
«View configuration details» gives Client ID, Deployment ID and the issuer (its wwwroot,
sub-path included). The issuer is stored exactly as given — it must equal Moodle's Platform ID.`;

/** `--flag value` / `--flag=value` / boolean `--dry-run`. */
function parseArgs(argv) {
  const args = { dryRun: false };
  const takesValue = {
    '--issuer': 'issuer',
    '--client-id': 'clientId',
    '--deployment-id': 'deploymentIds',
    '--auth-login-url': 'authLoginUrl',
    '--auth-token-url': 'authTokenUrl',
    '--jwks-uri': 'jwksUri',
    '--from-moodle': 'fromMoodle',
  };
  for (let i = 0; i < argv.length; i++) {
    const eq = argv[i].indexOf('=');
    const flag = eq === -1 ? argv[i] : argv[i].slice(0, eq);
    const inline = eq === -1 ? undefined : argv[i].slice(eq + 1);
    if (flag === '--dry-run') { args.dryRun = true; continue; }
    if (flag === '--help' || flag === '-h') { args.help = true; continue; }
    const key = takesValue[flag];
    if (!key) throw new Error(`unknown flag: ${flag}`);
    const value = inline !== undefined ? inline : argv[++i];
    if (value === undefined || (inline === undefined && value.startsWith('--'))) {
      throw new Error(`${flag} needs a value`);
    }
    args[key] = value;
  }
  return args;
}

/** `--from-moodle <base-url>` → the three Moodle endpoints under that base. */
function fromMoodle(origin) {
  const base = String(origin).replace(/\/+$/, '');
  return {
    authLoginUrl: `${base}${MOODLE_ENDPOINTS.authLoginUrl}`,
    authTokenUrl: `${base}${MOODLE_ENDPOINTS.authTokenUrl}`,
    jwksUri: `${base}${MOODLE_ENDPOINTS.jwksUri}`,
  };
}

/**
 * The row this script writes, from parsed flags.
 * @throws {Error} when a required field is missing or a rule fails
 */
function registrationFromArgs(args) {
  if (args.fromMoodle) {
    return normaliseRegistration({
      // Moodle defaults first; an explicit endpoint flag wins and is validated like any other.
      ...fromMoodle(args.fromMoodle),
      issuer: args.issuer || args.fromMoodle.trim().replace(/\/+$/, ''),
      clientId: args.clientId,
      deploymentIds: args.deploymentIds,
      ...(args.authLoginUrl !== undefined ? { authLoginUrl: args.authLoginUrl } : {}),
      ...(args.authTokenUrl !== undefined ? { authTokenUrl: args.authTokenUrl } : {}),
      ...(args.jwksUri !== undefined ? { jwksUri: args.jwksUri } : {}),
    });
  }
  return normaliseRegistration(args);
}

/**
 * Runs the command. `io` exists for the test: the real call takes the process streams.
 * `out`/`err` are WRITABLE STREAMS (`{write(string)}`); written text carries its own newlines.
 * @param {string[]} argv
 * @param {{store?: object, out?: {write: (text: string) => unknown}, err?: {write: (text: string) => unknown}}} [io]
 * @returns {Promise<number>} the exit code
 */
async function main(argv, io = {}) {
  const out = io.out || process.stdout;
  const err = io.err || process.stderr;

  let args;
  try {
    args = parseArgs(argv);
  } catch (parseError) {
    err.write(`${parseError.message}\n\n${USAGE}\n`);
    return 2;
  }
  if (args.help) { out.write(`${USAGE}\n`); return 0; }

  let registration;
  try {
    registration = registrationFromArgs(args);
  } catch (ruleError) {
    err.write(`refused: ${ruleError.message}\n\n${USAGE}\n`);
    return 2;
  }

  if (args.dryRun) {
    out.write(`${JSON.stringify({ dryRun: true, registration }, null, 2)}\n`);
    out.write('Нічого не записано. Приберіть --dry-run, щоб зберегти реєстрацію.\n');
    return 0;
  }

  const store = io.store || createStore(pool);
  await store.saveRegistration(registration);
  const saved = await store.getRegistration(registration.issuer, registration.clientId);
  out.write(`Реєстрацію збережено: issuer ${registration.issuer}, client_id ${registration.clientId}\n`);
  out.write(`deployment_id: ${(saved && saved.deploymentIds ? saved.deploymentIds : registration.deploymentIds).join(', ')}\n`);
  out.write('Перевірте запуск із Moodle («Select content»). Деталі — docs/self-host.md.\n');
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then(code => { process.exitCode = code; })
    .catch(failure => { console.error(`failed: ${failure.message}`); process.exitCode = 1; })
    .finally(() => { pool.end().catch(() => {}); });
}

module.exports = { parseArgs, registrationFromArgs, fromMoodle, main, USAGE };