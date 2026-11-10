#!/usr/bin/env node
// nginx/make-cert.mjs
//
// A self-signed certificate for the stack's own HTTPS, for the local proof and
// for a host that will mount a real one later (P5b does the production
// certificate). Written by the image build, so no certificate is committed and
// every local stack gets a fresh one.
//
//   node nginx/make-cert.mjs <dir> [--force]
//
// SANs cover what the local stack answers on: localhost and 127.0.0.1, which
// is what `curl -k https://127.0.0.1:<port>/api/health` uses in the check.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) { console.error("usage: node make-cert.mjs <dir> [--force]"); process.exit(2); }
const force = process.argv.includes("--force");
if (existsSync(join(dir, "cert.pem")) && !force) {
    console.log(`${dir}/cert.pem exists (--force to replace)`);
    process.exit(0);
}

mkdirSync(dir, { recursive: true });
const run = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", join(dir, "key.pem"),
    "-out", join(dir, "cert.pem"),
    "-days", "825",
    "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,DNS:*.localhost,IP:127.0.0.1,IP:0:0:0:0:0:0:0:1",
], { stdio: ["ignore", "inherit", "inherit"] });
if (run.status !== 0) { console.error("openssl failed (is it installed?)"); process.exit(1); }
console.log(`self-signed certificate written to ${dir}/cert.pem (local only — mount a real one for production)`);
