// backup/test/unit/retention.test.js
//
// The pruning rules of the backup retention, pinned with the repo's own runner
// (`node --test`, no framework). A rule that deletes a wrong directory is a
// data-loss bug, so these are the tests that matter most here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatBackupName, parseBackupName, selectForDeletion } from "../../retention.mjs";

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0); // 2026-11-10T12:00:00Z
const day = 86400000;

test("a name round-trips to its instant", () => {
    const name = formatBackupName(new Date(NOW));
    assert.equal(name, "2026-11-10T12-00-00Z");
    assert.deepEqual(parseBackupName(name), new Date(NOW));
});

test("names that are not ours are never parsed, so never deleted", () => {
    for (const junk of ["", "latest", "db.sql.gz", "not-a-date", "2026-11-10T12:00-00", "2026-13-99T99-99-99Z", "2026-11-10T12-00-00Z.txt"]) {
        assert.equal(parseBackupName(junk), null, junk);
    }
});

test("nothing to delete inside the window", () => {
    const names = [
        formatBackupName(NOW - 1 * day),
        formatBackupName(NOW - 13 * day),
        formatBackupName(NOW - 14 * day), // exactly on the boundary is kept
    ];
    assert.deepEqual(selectForDeletion(names, { keepDays: 14, now: NOW }), []);
});

test("strictly older than the window goes, oldest first", () => {
    const old = formatBackupName(NOW - 40 * day);
    const older = formatBackupName(NOW - 41 * day);
    const names = [formatBackupName(NOW - 1 * day), old, older, formatBackupName(NOW - 20 * day)];
    assert.deepEqual(selectForDeletion(names, { keepDays: 14, now: NOW }), [older, old, formatBackupName(NOW - 20 * day)]);
});

test("the newest backup survives even past the window", () => {
    const stale = formatBackupName(NOW - 90 * day);
    assert.deepEqual(selectForDeletion([stale], { keepDays: 14, now: NOW }), []);
    const second = formatBackupName(NOW - 91 * day);
    assert.deepEqual(selectForDeletion([stale, second], { keepDays: 14, now: NOW }), [second]);
});

test("foreign entries are left alone", () => {
    const stale = formatBackupName(NOW - 40 * day);
    const names = ["latest", formatBackupName(NOW - 1 * day), stale, "README.txt"];
    assert.deepEqual(selectForDeletion(names, { keepDays: 14, now: NOW }), [stale]);
});

test("an empty (or foreign-only) list deletes nothing", () => {
    assert.deepEqual(selectForDeletion([], { keepDays: 14, now: NOW }), []);
    assert.deepEqual(selectForDeletion(["only-foreign"], { keepDays: 0, now: NOW }), []);
});

test("keepDays must be a number", () => {
    assert.throws(() => selectForDeletion(["2026-11-10T12-00-00Z"], { keepDays: "14" }), /keepDays/);
    assert.throws(() => selectForDeletion(["2026-11-10T12-00-00Z"], { keepDays: -1 }), /keepDays/);
});
