// backend/server.js
//
// Entry point: wires the middleware and the route modules, owns startup and
// shutdown. Routes live in `routes/`, one module per concern.

const express = require('express');
const cors = require('cors');

const { runMigrations } = require('./migrations');
const storage = require('./storage');
const { pool } = require('./db');
const { bootstrapToken, tokensMatch } = require('./auth');
const { parseMaxArchiveBytes } = require('./config');
const catalogPublic = require('./routes/catalog-public');
const { parseLimit, parseOffset, escapeLikePattern, parseSort } = catalogPublic;

const app = express();

// Everything reaches the API same-origin through nginx, so CORS stays off
// unless an origin is named explicitly. A wildcard would expose the admin
// write endpoints to any page on the internet.
if (process.env.CORS_ORIGIN) {
  app.use(cors({ origin: process.env.CORS_ORIGIN }));
}

app.use(express.json());

// nginx sits in front and sets X-Forwarded-For; without this the rate limiter
// would bucket every client under the proxy's address.
app.set('trust proxy', 1);

if (!bootstrapToken() && require.main === module) {
  console.warn('[AUTH] ADMIN_TOKEN is not set — bootstrap moderator is off (personal keys still work)');
}

app.use(catalogPublic.router);
app.use(require('./routes/catalog-admin').router);
app.use(require('./routes/archives').router);
app.use(require('./routes/storage-admin').router);
app.use(require('./routes/telemetry').router);
app.use(require('./routes/keys').router);
app.use(require('./routes/health').router);

// ── Start ────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// Migrations and storage directories must exist before the first request:
// a half-migrated schema serving traffic is worse than a restart loop.
async function bootstrap() {
  await pool.query('SELECT NOW()')
    .then(() => console.log('[DB] Connected to PostgreSQL'))
    .catch(err => console.error('[DB] Connection failed:', err.message));

  await storage.ensureStorageDirs();
  await runMigrations(pool);
  await storage.cleanStaleTemp();

  return app.listen(PORT, () => {
    console.log(`[API] Server running on port ${PORT}`);
  });
}

let server;

// Only bind a port when run as the entry point. Under test, `app` and `pool`
// are imported directly so supertest can drive the routes without a listener.
if (require.main === module) {
  bootstrap()
    .then(instance => { server = instance; })
    .catch(err => {
      console.error('[API] Startup failed:', err.message);
      process.exit(1);
    });

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// ── Graceful shutdown ────────────────────────────────
// `docker compose down` sends SIGTERM; without this the process is killed
// outright and in-flight archive streams are cut mid-transfer.
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[API] ${signal} received, shutting down`);

  const force = setTimeout(() => {
    console.error('[API] Forced exit after timeout');
    process.exit(1);
  }, 10_000);
  force.unref();

  if (!server) {
    // Signalled while still bootstrapping.
    pool.end().catch(() => {}).finally(() => process.exit(0));
    return;
  }

  server.close(async () => {
    try {
      await pool.end();
    } catch (err) {
      console.error('[DB] Pool shutdown error:', err.message);
    }
    clearTimeout(force);
    process.exit(0);
  });
}

module.exports = {
  app,
  pool,
  bootstrap,
  // Exported for unit tests — pure helpers with no HTTP surface of their own.
  escapeLikePattern,
  tokensMatch,
  parseLimit,
  parseOffset,
  parseSort,
  parseMaxArchiveBytes,
};
