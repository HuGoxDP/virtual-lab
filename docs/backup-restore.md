# Backups and the restore

What the `backup` service keeps, and how one backup is proven restorable. This
document is the procedure P5a asks for: it is written here **because it is run
here**, once, on a scratch stack, with its output recorded in
`​.claude-shared/code-foundations/P5a/notes.md` (the run of 2026-11-10).

## What a backup is

One directory under the backup root (`./backup/out` locally, an off-host mount
on the host that runs the stack):

```
<UTC timestamp>/
  db.sql.gz          pg_dump: plain SQL, --clean --if-exists, gzipped
  volumes/
    archives.tar.gz  a copy of the content-addressed archive store
    assets.tar.gz    a copy of the per-asset (streamed scenario) store
    previews.tar.gz  a copy of the cover images
    lti.tar.gz       a copy of the LTI tool key (private: keep backups like secrets)
  manifest.json      what is inside, with sizes and the database coordinates
```

- The database is **dumped, not copied**: a tar of a live `pgdata` is not
  crash-consistent, a dump is, and it restores into a newer server.
- The content volumes are **copied**: the platform stores objects
  content-addressed and never rewrites one (`/scenarios/<sha256>.zip`,
  `/a/objects/<aa>/<sha256>`), so a read-only copy taken while the stack runs is
  consistent. The LTI key volume is copied too — it is generated once and would
  otherwise have to be re-issued.
- The backup service keeps `BACKUP_KEEP_DAYS` (14 by default) days of these,
  and never deletes the newest one, even past the window (a schedule that never
  ran again must not leave an empty backup root).

## The procedure (run it on a scratch stack, never the live one)

A scratch stack is the same images and configs with its own volumes, so
`down -v` cannot touch real data:

```bash
VL=./virtual-lab   # wherever the checkout is
cd $VL

# 1. A scratch stack: its own volumes (docker-compose.scratch.yml) and its own
#    frontend port (3998, so the live stack keeps 8044).
docker compose -p vlabscratch \
  -f docker-compose.yml -f docker-compose.scratch.yml up -d --build

# 2. Seed something worth restoring. Content the platform cannot rewrite: one
#    row in the database, one object in the archive store. (A real rehearsal
#    would publish a release through the API instead — both paths end in a
#    database row and stored bytes.)
SC=vlabscratch
docker compose -p $SC exec -T database \
  psql -U "$(grep -m1 '^DB_USER=' .env | cut -d= -f2)" \
       -d "$(grep -m1 '^DB_NAME=' .env | cut -d= -f2)" \
  -c "insert into scenarios (id, title, category, category_label) values ('backup-proof','Backup proof','demo','Demo')"
docker compose -p $SC run --rm -v virtual_lab_archives:/v alpine \
  sh -c 'printf "restore-me" > /v/objects/backup-proof.txt'

# 3. Back it up, once, on demand (the service's own script).
docker compose -p $SC run --rm \
  -e BACKUP_DIR=/backups -e BACKUP_RUN_ONCE=1 \
  -v "$PWD/backup/out-scratch:/backups" backup
NAME=$(ls -1 backup/out-scratch | head -1)     # the timestamped directory

# 4. Destroy the scratch stack and its volumes. This is the disaster.
docker compose -p $SC down -v

# 5. Bring it back — empty, exactly like a recovered host.
docker compose -p vlabscratch \
  -f docker-compose.yml -f docker-compose.scratch.yml up -d

# 6. Restore. The script dry-runs without --yes and says what it will do.
docker compose -p vlabscratch run --rm \
  -e BACKUP_DIR=/backups -v "$PWD/backup/out-scratch:/backups" \
  backup node restore.mjs "$NAME" --yes

# 7. Verify, and only then trust it: the row is back, the bytes are back, and
#    nginx serves the restored object again.
docker compose -p vlabscratch exec -T database \
  psql -U "$(grep -m1 '^DB_USER=' .env | cut -d= -f2)" \
       -d "$(grep -m1 '^DB_NAME=' .env | cut -d= -f2)" \
  -tAc "select count(*) from scenarios where id = 'backup-proof'"     # 1
curl -fsS http://127.0.0.1:3998/scenarios/backup-proof.txt            # restore-me

docker compose -p vlabscratch down -v          # done: the scratch is thrown away
```

Every step either verifies or destroys, and nothing above touches the live
stack's volumes or ports (they are renamed by `docker-compose.scratch.yml`).

## What the run of 2026-11-10 proved

See `​.claude-shared/code-foundations/P5a/notes.md`: the seeded row and the
seeded object both survived `down -v` and came back through `restore.mjs
--yes`, with `psql count = 1` and nginx serving the restored bytes.

## Not in this repo (P5b, the owner)

- the off-host backup target (a mounted volume on the host, or a push to
  object storage) on production;
- the production TLS certificate, mounted at `/etc/nginx/tls/`, and the HTTPS
  ports published there;
- a restore actually run **on production** — the scratch exercise proves the
  procedure, not the host.
