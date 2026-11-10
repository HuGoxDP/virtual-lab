#!/usr/bin/env node
// backup/backup.mjs
//
// One backup: a logical dump of Postgres, copies of the content volumes, a
// manifest, and a prune. Runs once by default, and loops every
// BACKUP_SCHEDULE_HOURS when it is left running (the container's command).
//
// Why a dump and not a copy of pgdata: a tar of a live data directory is not
// crash-consistent, `pg_dump` is, and it can be restored into a newer server.
// Why the content volumes are safe to copy: the platform stores objects
// content-addressed and never rewrites one, so an append-only copy taken while
// the stack runs is consistent (see docs/backup-restore.md).
//
// Everything this prints is meant to be read in `docker compose logs backup`.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatBackupName, selectForDeletion } from "./retention.mjs";

const env = (name, fallback) => {
    const value = process.env[name];
    return value === undefined || value === "" ? fallback : value;
};
const int = (name, fallback) => {
    const value = Number(env(name, fallback));
    if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${name} must be a non-negative number, got "${process.env[name]}"`);
    }
    return value;
};

const BACKUP_DIR = env("BACKUP_DIR", "/backups");
const KEEP_DAYS = int("BACKUP_KEEP_DAYS", 14);
const SCHEDULE_HOURS = int("BACKUP_SCHEDULE_HOURS", 24);
// name:mountpoint pairs, comma-separated. The pgdata volume is NOT here: it is
// dumped, not copied (see the header).
const VOLUMES = env("BACKUP_VOLUMES", "archives:/volumes/archives,assets:/volumes/assets,previews:/volumes/previews,lti:/volumes/lti")
    .split(",").map((s) => s.trim()).filter(Boolean)
    .map((pair) => {
        const [name, mount] = pair.split(":");
        if (!name || !mount) throw new Error(`BACKUP_VOLUMES entries are "name:mountpoint", got "${pair}"`);
        return { name, mount };
    });

const DB = {
    host: env("DB_HOST", "database"),
    port: env("DB_PORT", "5432"),
    name: env("DB_NAME", "virtual_lab"),
    user: env("DB_USER", "lab_user"),
};

/** A unique directory for this run; a same-second collision gets `-2`, `-3`, … */
function targetDir(now) {
    const base = formatBackupName(now);
    let candidate = join(BACKUP_DIR, base);
    for (let n = 2; existsSync(candidate); n += 1) candidate = join(BACKUP_DIR, `${base}-${n}`);
    return candidate;
}

/** The dump, gzipped: `--clean --if-exists` so a restore drops before it recreates. */
function dumpTo(outFile) {
    const dump = spawnSync("pg_dump", [
        "--host", DB.host, "--port", DB.port, "--username", DB.user,
        "--dbname", DB.name, "--clean", "--if-exists", "--format", "plain",
        "--no-owner", "--no-privileges",
    ], { env: { ...process.env, PGPASSWORD: env("DB_PASSWORD", "") }, maxBuffer: 512 * 1024 * 1024 });
    if (dump.status !== 0) throw new Error(`pg_dump exited ${dump.status}: ${String(dump.stderr).slice(0, 400)}`);
    const gz = spawnSync("gzip", ["-c"], { input: dump.stdout, maxBuffer: 512 * 1024 * 1024 });
    if (gz.status !== 0) throw new Error(`gzip exited ${gz.status}`);
    writeFileSync(outFile, gz.stdout);
    return statSync(outFile).size;
}

function copyVolume(name, mount, volumesDir) {
    if (!existsSync(mount)) throw new Error(`volume mount ${mount} does not exist (is the service attached to it?)`);
    const out = join(volumesDir, `${name}.tar.gz`);
    const tar = spawnSync("tar", ["czf", out, "-C", mount, "."], { stdio: ["ignore", "ignore", "inherit"] });
    if (tar.status !== 0) throw new Error(`tar of ${name} exited ${tar.status}`);
    return { name, mount, bytes: statSync(out).size };
}

function prune(now) {
    const doomed = selectForDeletion(readdirSync(BACKUP_DIR), { keepDays: KEEP_DAYS, now });
    for (const name of doomed) {
        rmSync(join(BACKUP_DIR, name), { recursive: true, force: true });
        console.log(`pruned ${name} (keep ${KEEP_DAYS} days)`);
    }
    return doomed;
}

function runOnce() {
    const started = new Date();
    const dir = targetDir(started);
    mkdirSync(join(dir, "volumes"), { recursive: true });
    try {
        console.log(`backup -> ${dir}`);
        const bytes = dumpTo(join(dir, "db.sql.gz"));
        console.log(`db.sql.gz ${bytes} bytes (${DB.name}@${DB.host}:${DB.port})`);
        const volumes = VOLUMES.map(({ name, mount }) => copyVolume(name, mount, join(dir, "volumes")));
        for (const v of volumes) console.log(`volumes/${v.name}.tar.gz ${v.bytes} bytes`);
        writeFileSync(join(dir, "manifest.json"), JSON.stringify({
            createdAt: started.toISOString(),
            format: "pg_dump plain SQL, gzip; volumes as gzipped tar",
            database: { host: DB.host, port: DB.port, name: DB.name, user: DB.user },
            volumes,
            retentionDays: KEEP_DAYS,
        }, null, 1) + "\n");
    } catch (err) {
        // A half-written directory has no manifest, so it is not a backup — and
        // a restore of it would fail halfway. Leave no partial evidence.
        rmSync(dir, { recursive: true, force: true });
        throw err;
    }
    prune(started);
    console.log(`backup done in ${((Date.now() - started.getTime()) / 1000).toFixed(1)}s`);
}

const main = async () => {
    mkdirSync(BACKUP_DIR, { recursive: true });
    if (env("BACKUP_RUN_ONCE", "") === "1") { runOnce(); return; }
    console.log(`backup service: every ${SCHEDULE_HOURS}h, keeping ${KEEP_DAYS} days in ${BACKUP_DIR}`);
    for (;;) {
        const at = Date.now();
        try { runOnce(); }
        catch (err) { console.error(`backup FAILED (retrying in ${SCHEDULE_HOURS}h): ${err.message}`); }
        const ms = SCHEDULE_HOURS * 3600000 - (Date.now() - at);
        await new Promise((resolve) => setTimeout(resolve, Math.max(ms, 1000)));
    }
};

main().catch((err) => { console.error(err); process.exit(1); });
