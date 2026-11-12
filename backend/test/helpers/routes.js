// backend/test/helpers/routes.js
//
// Every route the server mounts, as a list. Express keeps them in
// `app._router.stack` (Express 4), including ones a router mounts, so this
// enumerates what a client can actually call rather than what a grep finds.
//
// B6 (DW-6.2) uses it for the BOLA sweep: an author B calls each `:id` route
// against author A's scenario and must never get a 2xx. A route added later is
// enumerated here automatically, so the sweep cannot silently forget it — the
// allow-list for public reads below is the only place a 2xx may appear.

/** Flattens `router.stack` into `[{ method, path }]`, prefixing mounted routers. */
function walk(stack, prefix, out) {
  for (const layer of stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).map(m => m.toUpperCase());
      out.push({ methods, path: prefix + layer.route.path });
      continue;
    }
    // A mounted router: `layer.handle.stack` holds its layers, `layer.regexp`
    // where it sits. Its own `name` is 'router' only when mounted with use().
    if (layer.handle && layer.handle.stack && layer.regexp) {
      // The readable prefix is what precedes the first '(' or '\\' — the
      // Express-internal tail and capture groups are dropped, and so is the
      // leading ^ the router was compiled with, so paths read as they are called.
      const clean = String(layer.regexp).split('(')[0].split('\\')[0].replace(/^\^\/?/, '');
      walk(layer.handle.stack, prefix + clean, out);
    }
  }
  return out;
}

/** Every `{ method, path }` the app serves, in registration order. */
function allRoutes(app) {
  return walk(app._router.stack, '', []);
}

/** The routes whose path carries an `:id` (or any `:param`) segment. */
function idRoutes(app) {
  return allRoutes(app).filter(r => /:\w+/.test(r.path));
}

/** Flattens to `METHOD path` strings, one per method. */
function methodPathList(app) {
  const out = [];
  for (const route of allRoutes(app)) for (const m of route.methods) out.push(`${m} ${route.path}`);
  return out;
}

/**
 * Routes an anonymous caller may read. Everything else with an `:id` must refuse author B
 * with 403 or 404.
 *
 * The sweep asserts every entry here is actually served (B6r3): the list is the contract
 * for "a 2xx is allowed here", so a name the app no longer answers — or a public route that
 * was later guarded — has to be noticed rather than sit there and skip a future route.
 * `/play/:id` is deliberately not in this list: it is an Angular client route
 * (`frontend/src/app/app.routes.ts`), not a server route, so the server never sees it.
 */
const PUBLIC_READ_ALLOWLIST = [
  'GET /api/catalog',
  'GET /api/catalog/:id',
  'GET /api/health',
];

/**
 * Routes as `{ methods, path }` with the Express-internal mount prefix
 * (`/^` for the app's own router) removed, so a path reads as it is called.
 */
function cleanRoutes(app) {
  return allRoutes(app).map(({ methods, path }) => ({ methods, path: path.replace(/^\/\^/, "") }));
}

/** Every `{ methods, path }` the app serves, mount prefixes removed. */
function routes(app) { return cleanRoutes(app); }

module.exports = { allRoutes, cleanRoutes, routes, idRoutes, methodPathList, PUBLIC_READ_ALLOWLIST };
