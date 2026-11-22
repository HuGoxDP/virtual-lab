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
// `--from-moodle <origin>` fills the three platform endpoints from Moodle's own `/mod/lti/…`
// paths and takes the issuer to be that origin (Moodle's issuer IS its wwwroot); `--issuer`
// overrides it for a Moodle behind a different public host.
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
  node scripts/lti-add-registration.js --from-moodle <moodle-origin> --client-id <id>
      --deployment-id <id[,id]> [--issuer <url>] [--dry-run]

  --from-moodle <origin>  take the endpoints from Moodle's own /mod/lti/… paths
  --dry-run               validate and print the row, write nothing

Moodle side: Site administration → Plugins → Activity modules → External tool → Manage tools →
«View configuration details» gives Client ID, Deployment ID and the issuer (its wwwroot).`;

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

/** `--from-moodle <origin>` → the three Moodle endpoints on that origin. */
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
      issuer: args.issuer || args.fromMoodle,
      clientId: args.clientId,
      deploymentIds: args.deploymentIds,
      ...fromMoodle(args.fromMoodle),
    });
  }
  return normaliseRegistration(args);
}

/**
 * Runs the command. `io` exists for the test: the real call takes process.
 * @param {string[]} argv
 * @param {{store?: object, out?: (line: string) => void, err?: (line: string) => void}} [io]
 * @returns {Promise<number>} the exit code
 */
async function main(argv, io = {}) {
  const out = io.out || (line => console.log(line));
  const err = io.err || (line => console.error(line));

  let args;
  try {
    args = parseArgs(argv);
  } catch (parseError) {
    err(`${parseError.message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) { out(USAGE); return 0; }

  let registration;
  try {
    registration = registrationFromArgs(args);
  } catch (ruleError) {
    err(`refused: ${ruleError.message}\n\n${USAGE}`);
    return 2;
  }

  if (args.dryRun) {
    out(JSON.stringify({ dryRun: true, registration }, null, 2));
    out('Нічого не записано. Приберіть --dry-run, щоб зберегти реєстрацію.');
    return 0;
  }

  const store = io.store || createStore(pool);
  await store.saveRegistration(registration);
  const saved = await store.getRegistration(registration.issuer, registration.clientId);
  out(`Реєстрацію збережено: issuer ${registration.issuer}, client_id ${registration.clientId}`);
  out(`deployment_id: ${(saved && saved.deploymentIds ? saved.deploymentIds : registration.deploymentIds).join(', ')}`);
  out('Перевірте запуск із Moodle («Select content»). Деталі — docs/self-host.md.');
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then(code => { process.exitCode = code; })
    .catch(failure => { console.error(`failed: ${failure.message}`); process.exitCode = 1; })
    .finally(() => { pool.end().catch(() => {}); });
}

module.exports = { parseArgs, registrationFromArgs, fromMoodle, main, USAGE };