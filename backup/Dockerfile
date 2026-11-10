# backup/Dockerfile
#
# The backup service: Node (the scripts), the Postgres client (the dump), tar
# and gzip (the volume copies). Alpine's Node is enough — the scripts have no
# dependencies. The image is small on purpose: it runs nightly on the host the
# stack runs on.
FROM alpine:3.20

RUN apk add --no-cache nodejs postgresql16-client tar gzip

WORKDIR /app
COPY retention.mjs backup.mjs restore.mjs ./

# One backup, then every BACKUP_SCHEDULE_HOURS (24 by default). A manual run:
#   docker compose run --rm -e BACKUP_RUN_ONCE=1 backup
ENTRYPOINT ["node", "backup.mjs"]
