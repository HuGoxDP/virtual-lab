#!/usr/bin/env node
// backup/restore.mjs
//
// Restores one backup directory: the database dump and the content volumes.
//
//   node restore.mjs <backup-name>            dry run: what is in it, what would happen
//   node restore.mjs <backup-name> --yes      do it
//
// The dry run is the default because a restore is destructive: it drops every
// table the dump's `--clean` statements cover (`--clean --if-exists` at dump
// time makes the restore idempotent — running it twice leaves one copy, not two).
// The procedure the platform documents (docs/backup-restore.md) restores onto a
// scratch stack, never onto the live one, and that is the order the flags above
// assume: think, then `--yes`.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const env = (name, fallback) => {
    const value = process.env[name];
    return value === undefined || value === "" ? fallback : value;
};

const BACKUP_DIR = env("BACKUP_DIR", "/backups");
const DB = {
    host: env("DB_HOST", "database"),
    port: env("DB_PORT", "5432"),
    name: env("DB_NAME", "virtual_lab"),
    user: env("DB_USER", "lab_user"),
};

const args = process.argv.slice(2);
const yes = args.includes("--yes");
const name = args.find((a) => !a.startsWith("--"));
if (!name || name.includes("/") || name.includes("\\")) {
    console.error("usage: node restore.mjs <backup-name> [--yes]   (a directory name under the backup root)");
    process.exit(2);
}

const dir = join(BACKUP_DIR, name);
if (!existsSync(dir)) {
    console.error(`no such backup: ${dir}`);
    process.exit(2);
}

const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const dumpFile = join(dir, "db.sql.gz");
const volumes = (manifest.volumes ?? []).map((v) => ({ ...v, file: join(dir, "volumes", `${v.name}.tar.gz`) }));

console.log(`backup ${name}: taken ${manifest.createdAt}`);
console.log(`  database ${manifest.database.name}@${manifest.database.host}:${manifest.database.port} (${statSync(dumpFile).size} bytes)`);
for (const v of volumes) {
    if (!existsSync(v.file)) {
        console.error(`  ${v.name}: MISSING ${v.file}`);
        process.exit(1);
    }
    console.log(`  volume ${v.name} -> ${v.mount} (${statSync(v.file).size} bytes)`);
}

if (!yes) {
    console.log("\ndry run. Re-run with --yes to restore. A restore drops and recreates");
    console.log("the tables of this database — the documented procedure runs it on a scratch stack.");
    process.exit(0);
}

for (const v of volumes) {
    if (!existsSync(v.mount)) {
        console.error(`restore: ${v.mount} is not mounted here (run the restore inside the stack that owns the volume)`);
        process.exit(1);
    }
}

const gunzip = spawnSync("gzip", ["-dc", dumpFile], { maxBuffer: 512 * 1024 * 1024 });
if (gunzip.status !== 0) { console.error(`gunzip failed: ${String(gunzip.stderr).slice(0, 300)}`); process.exit(1); }
const psql = spawnSync("psql", [
    "--host", DB.host, "--port", DB.port, "--username", DB.user, "--dbname", DB.name,
    "--set", "ON_ERROR_STOP=1", "--quiet",
], { input: gunzip.stdout, env: { ...process.env, PGPASSWORD: env("DB_PASSWORD", "") }, maxBuffer: 512 * 1024 * 1024 });
if (psql.status !== 0) {
    console.error(`psql failed (exit ${psql.status}); the database may be partially restored — check before retrying:`);
    console.error(String(psql.stderr).slice(0, 600));
    process.exit(1);
}
console.log(`database restored into ${DB.name}@${DB.host}`);

for (const v of volumes) {
    const tar = spawnSync("tar", ["xzf", v.file, "-C", v.mount], { stdio: ["ignore", "ignore", "inherit"] });
    if (tar.status !== 0) { console.error(`restoring ${v.name} failed (exit ${tar.status})`); process.exit(1); }
    console.log(`volume ${v.name} restored into ${v.mount}`);
}
console.log("restore done. Verify against the checklist in docs/backup-restore.md before trusting it.");
