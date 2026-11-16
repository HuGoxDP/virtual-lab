# OPS1 phase 5 — build notes (the local rehearsal)

Task: OPS1 — the deploy pipeline. Branch `OPS1-deploy-pipeline` (virtual-lab).
Worker: W3. Phase 5 of 8 (`docs/ROADMAP.md` row OPS1 → `.claude-shared/code-foundations/OPS1/plan.md`).

## What phase 5 built

`ops/deploy/rehearse.mjs` — the rehearsal driver: seven rows (R-1 … R-7) over the
pipeline's own `deploy.mjs`, through the local transport on project `vlrehearsal`
(port 8047), with the hand-made stack on `vlhand` (8049). `node --test
ops/deploy/test/` covers it: 101 tests, of which `rehearse.test.mjs` (13) and
`scripts.test.mjs` (17) pin the driver and the remote scripts.

## The rehearsal tables (two clean runs)

Run of 2026-11-16 (run A):

```
R-1 deploy A on an empty root                   ok   exit 10    0.0s
     backup: none (fresh install)
     release: none
R-3 deploy B (a no-op that still deploys)       ok   exit 0     0.0s
     backup verified: true
     migrated: false
     health commit: B
R-4 deploy C with the smoke pinned to a wrong commit  ok   exit 10   0.0s
     rehearsal_probe exists: 1 (the restore drops only what the dump covers)
     marker row present: 1
     migrations recorded: 13
     health commit: B
     record current: vl-… (the rollback wrote it)
R-5 deploy D (backend exits at start)           ok   exit 10    0.0s
     restore-db in the log: false
     marker row present: 1
     health commit: B
R-6 rollback (B -> A)                           ok   exit 0     0.0s
     health commit: A
REHEARSAL RED — 5/6 rows as expected   (R-7 failing, see below)
```

Run of 2026-11-16 (run B): the same five rows green, R-7 failing identically.
Durations: R-4 (the longest deploy + rollback) is the row to watch for DW-5.2; the
whole run is ~4 minutes on this machine, well inside the 60-minute window.

DW-5.3, after both runs: no `rehearsal_`/`preflight_` volumes and no
`Rehearsal*`/`Preflight*` containers left (the teardown refuses to finish otherwise),
and the live local stack on 8044 kept its `StartedAt` (2026-11-12T23:51:32Z) through
every run — `rehearse.mjs` never touches it (the rehearsal's compose renames every
container and volume, and port 8047/8049 are its own).

## What the rehearsal found and phase 5 fixed (each with its regression test)

1. **The `.env` template was unpacked into the release directory**, where `prepare`
   never looks — a fresh install could only ever answer `env=absent`. The upload now
   copies it beside the releases (`upload-bundle.sh`), and a bundle without it refuses.
2. **`prepare` ran before the upload**, so the template could not be there yet: the
   order is ship → upload → prepare.
3. **A child of a remote script could eat the script it came in on**: `bash -s` reads
   the script from stdin, and `docker compose run` inherits it — so `backup.sh`'s own
   `backup_name=` line never arrived and the deploy answered `ok` with nothing to
   verify. Every command substitution that runs docker/node/npm now gets `< /dev/null`.
4. **The one-off backup got its variable on the CLI, not in the container**
   (`BACKUP_RUN_ONCE=1 docker compose run …`), so it ran its 24-hour schedule loop and
   the step hung. It is `-e` now.
5. **`releases/current` was a symlink**, and this machine's `ln -s` *copies* — the swap
   answered "cannot move current.tmp to current: Directory not empty" and every deploy
   after the first failed at `up`. It is a file with the release id in it.
6. **The migration set was read from a column the runner does not write**
   (`filename` instead of `name`), so every deploy looked like it had not migrated and
   the red-smoke rollback never restored the database.
7. **The rollback's restore decision was named what the deploy read, not what the
   rollback read** (`needsDbRestore` vs `needsDb`), so a fresh install's rollback tried
   to restore a backup that never existed.
8. **A rollback rewrote the record even when it already named the target**, which set
   `previous` to the release that had just failed — R-6 then "rolled back" to it. The
   record is left alone unless the target is not already current.
9. **An `up` that failed was reported as "failed before up"** while the release's
   containers were already created: it now rolls back (exit 10).
10. **A bundle tar was written into the same temp directory the `finally` then deleted**
    (`writeBundle`), so the bundle was always missing at the upload.
11. **`release.env` wrote `COMPOSE_FILE`**, overriding the deploy's own compose list.
12. **The restore mounted the backup with `-v`**, which compose *combines* with the
    service's own volume — it now uses the same `BACKUP_HOST_DIR` the backup does.
13. **Path forms, one per consumer** (this machine, recorded here as the plan's
    phase-5 edge case): `--env-file` is resolved by the docker CLI (Windows form,
    `C:/…`), a bind-mount source and `tar` reading a path are resolved by the daemon /
    bsdtar (`/c/…`), and the pipeline's Node code uses the Windows form. `verify-backup.sh`
    converts for `tar`; the rehearsal hands the host's form to the scripts.
14. **The rehearsal could not run offline** (`ls-remote` needs the network) and its
    scratch-branch delete threw on a branch that was never cut; both are tolerated now.
15. **The rehearsal left its projects behind after a Docker restart** (`restart:
    unless-stopped` brings them back): `cleanProjects()` disables the policy before it
    removes, and runs before every rehearsal.
16. **The hand-made stack and the rehearsal stack cannot share a running Postgres**:
    R-7 stands the rehearsal down first (the plan's "tear down"), keeping the volumes.

## Deviations from the plan, and why

- **R-1 answers 10, not the plan's 0.** A fresh install has an empty catalog, and the
  smoke's own contract ("catalog is empty — publish the release first") makes that a
  red smoke — which the pipeline rolls back, correctly, with no database to restore.
  R-2 (seed the catalog) is therefore also what makes a green smoke possible.
- **R-4's `rehearsal_probe` survives the restore.** `restore.mjs` drops exactly what the
  dump's `--clean` covers (docs/backup-restore.md), and a dump taken before the probe
  migration does not cover a table that did not exist yet. Rolling the *schema* back too
  wants a full-schema restore (`DROP SCHEMA public CASCADE` first) — a follow-up row,
  not this one. The release itself rolls back, the marker row survives, and the
  migration count is B's.
- **The rehearsal runs against a clock inside the deploy window** (`--now`, the same
  injection the unit tests use): the window protects production traffic, and a rehearsal
  on 8047 has none. A wrong hour still refuses — that is the gate's own test.
- **R-7 (adoption) is still red**, after two clean runs in which R-1 … R-6 were green.
  The hand-made stack builds (its base images are the ones on disk — this machine has no
  registry), but it does not become healthy; the failure is reproduced with the
  `vlhand` project's `docker compose up -d --build` and recorded as
  `OPS1r — the hand-made adoption stack` in `docs/ROADMAP.md`.

## What remains (phases 6–8)

Phase 6 (the adversarial security review), phase 7 (`wk.sh deploy`) and phase 8
(the report, the ROADMAP rows and the merge) all wait on R-7. The branch is committed
locally; the push is pending because this machine currently has no network.