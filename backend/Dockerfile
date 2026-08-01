# backend/Dockerfile
FROM node:20-alpine

ENV NODE_ENV=production

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# All backend modules, not a hand-maintained list — node_modules is excluded
# by backend/.dockerignore, so this stays small.
COPY *.js ./
COPY migrations ./migrations

# Archive volume mountpoint. Creating it here with the right owner means the
# named volume inherits that ownership on first use, so the unprivileged
# process can write uploads.
RUN mkdir -p /srv/archives/objects /srv/archives/tmp \
 && chown -R node:node /srv/archives

# Drop root: the process reads its own files and writes only to /srv/archives.
USER node

EXPOSE 3000
CMD ["node", "server.js"]
