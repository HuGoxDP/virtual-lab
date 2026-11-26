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
//   … --deployment-id <second id>   repeat the flag: every deployment id is stored
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
  --deployment-id <id>      repeatable: give the flag again for every deployment id and
                            all of them are stored, in the order given
  --dry-run                 validate and print the row, write nothing

Moodle side: Site administration → Plugins → Activity modules → External tool → Manage tools →
«View configuration details» gives Client ID, Deployment ID and the issuer (its wwwroot,
sub-path included). The issuer is stored exactly as given — it must equal Moodle's Platform ID.`;

/**
 * `--flag value` / `--flag=value` / boolean `--dry-run` / `--help`.
 *
 * P1f / MS-2 AC-19: the parsed row is a TRUST ANCHOR written verbatim into
 * `lti_registrations`, so the parser refuses rather than guesses:
 *
 *   * `--deployment-id` is the one flag that may repeat — every value is kept,
 *     in the order given (a Moodle with several deployment ids used to have all
 *     but the last silently dropped by `args[key] = value`);
 *   * a second occurrence of ANY other value flag is an error naming that flag
 *     (the old code silently overwrote the first value, so a typo'd issuer was
 *     stored as if it had been the only one);
 *   * `--dry-run=<anything>` (or `--help=<anything>`) is an error — these flags
 *     take no value, and `--dry-run=false` used to turn dry-run ON;
 *   * a value is still required after every flag that takes one.
 *
 * @param {string[]} argv
 * @returns {{dryRun: boolean, help?: boolean, issuer?: string, clientId?: string,
 *            deploymentIds?: string | string[], authLoginUrl?: string,
 *            authTokenUrl?: string, jwksUri?: string, fromMoodle?: string}}
 * @throws {Error} naming the offending flag (main maps it to exit 2)
 */
function parseArgs(argv) {
  const args = { dryRun: false };
  const takesValue = {
    '--issuer': 'issuer',
    '--client-id': 'clientId',
    '--auth-login-url': 'authLoginUrl',
    '--auth-token-url': 'authTokenUrl',
    '--jwks-uri': 'jwksUri',
    '--from-moodle': 'fromMoodle',
  };
  // Every other value flag holds at most one value; a repeat names itself.
  const seen = new Set();
  const deploymentIds = [];

  for (let i = 0; i < argv.length; i++) {
    const eq = argv[i].indexOf('=');
    const flag = eq === -1 ? argv[i] : argv[i].slice(0, eq);
    const inline = eq === -1 ? undefined : argv[i].slice(eq + 1);
    if (flag === '--dry-run' || flag === '--help' || flag === '-h') {
      if (inline !== undefined) throw new Error(`${flag} does not take a value`);
      if (flag === '--dry-run') args.dryRun = true; else args.help = true;
      continue;
    }
    if (flag === '--deployment-id') {
      const value = inline !== undefined ? inline : argv[++i];
      if (value === undefined || (inline === undefined && value.startsWith('--'))) {
        throw new Error(`${flag} needs a value`);
      }
      // The one flag that may repeat — and each occurrence may itself carry a comma list
      // (USAGE: `--deployment-id <id[,id]>`). Every id is kept, in the order given; an empty
      // piece (`,` or `a,`) is dropped later by normaliseDeployments.
      deploymentIds.push(...value.split(/[,\s]+/).filter(Boolean));
      continue;
    }
    const key = takesValue[flag];
    if (!key) throw new Error(`unknown flag: ${flag}`);
    if (seen.has(flag)) throw new Error(`repeated flag: ${flag}`);
    const value = inline !== undefined ? inline : argv[++i];
    if (value === undefined || (inline === undefined && value.startsWith('--'))) {
      throw new Error(`${flag} needs a value`);
    }
    seen.add(flag);
    args[key] = value;
  }

  // normaliseDeployments accepts either shape; a single id stays a string so the
  // printed row and the P1c fixtures keep their shape.
  if (deploymentIds.length === 1) args.deploymentIds = deploymentIds[0];
  else if (deploymentIds.length > 1) args.deploymentIds = deploymentIds;
  return args;
}

/**
 * `--from-moodle <base-url>` → the three Moodle endpoints under that base.
 *
 * P1f / MS-2 AC-19: a base carrying `?` or `#` used to build the endpoints INSIDE the
 * query string (`https://h/moodle?x=1/mod/lti/auth.php`) and exit 0, storing a trust
 * anchor that can never match. It is a typo, not an input we can reinterpret, so it is
 * refused.
 */
function fromMoodle(origin) {
  const base = String(origin).replace(/\/+$/, '');
  if (/[?#]/.test(base)) {
    throw new Error('--from-moodle base URL must not contain query or fragment');
  }
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
    out.write('dry-run: would save registration\n');
    out.write('Нічого не записано. Приберіть --dry-run, щоб зберегти реєстрацію.\n');
    return 0;
  }

  const store = io.store || createStore(pool);
  await store.saveRegistration(registration);
  // The read-back is optional: an injected store may only record the write. Either way the
  // printed list is every deployment id, in the order given (AC-19).
  const saved = store.getRegistration
    ? await store.getRegistration(registration.issuer, registration.clientId)
    : null;
  const deploymentIds = saved && saved.deploymentIds ? saved.deploymentIds : registration.deploymentIds;
  out.write(`Реєстрацію збережено: issuer ${registration.issuer}, client_id ${registration.clientId}\n`);
  out.write(`deployment_id: ${deploymentIds.join(', ')}\n`);
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