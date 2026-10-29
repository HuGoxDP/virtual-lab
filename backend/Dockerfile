# backend/Dockerfile
FROM node:20-alpine

ENV NODE_ENV=production

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# All backend modules, not a hand-maintained list — node_modules is excluded
# by backend/.dockerignore, so this stays small.
COPY *.js ./
COPY routes ./routes
COPY migrations ./migrations
COPY lti ./lti

# Volume mountpoints (archives, cover images, the LTI tool key). Creating them here with the right owner means
# the named volumes inherit that ownership on first use, so the unprivileged process can write.
RUN mkdir -p /srv/archives/objects /srv/archives/tmp /srv/previews/objects /srv/previews/tmp /srv/lti \
 && chown -R node:node /srv/archives /srv/previews /srv/lti

# Drop root: the process reads its own files and writes only to /srv/archives, /srv/previews and /srv/lti.
USER node

EXPOSE 3000
CMD ["node", "server.js"]
