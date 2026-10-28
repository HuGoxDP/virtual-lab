// backend/lti/grade-cache.js
//
// Two short-lived, in-process caches that keep a page's worth of `GET /api/lti/session` calls from becoming a
// page's worth of Moodle requests:
//   tokens   the AGS access token per (registration, scopes), until shortly before its `expires_in`
//   results  "has this learner already submitted?" per (learner, line item), for RESULT_TTL_MS
// Both are bounded (oldest entry out first) and per process: a restart or a second replica only costs a
// request. `POST /submit` never reads `results`: the LMS stays the authority on what is already graded.
// Created once per router (index.js), so nothing leaks between routers or tests.

const RESULT_TTL_MS = 30_000;
const MAX_ENTRIES = 1000;
/** A token is dropped this long before the platform says it expires, so a request never carries a dying one. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

/** Map with a per-entry deadline and a size cap. */
function createTtlMap({ now, max }) {
  const entries = new Map();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      return entry;
    },
    set(key, value, ttlMs) {
      entries.delete(key); // re-insert: Map iterates in insertion order, so the first key is the oldest
      if (entries.size >= max) {
        const current = now();
        for (const [k, e] of entries) if (e.expiresAt <= current) entries.delete(k);
        if (entries.size >= max) entries.delete(entries.keys().next().value);
      }
      entries.set(key, { value, expiresAt: now() + ttlMs });
    },
    delete: key => entries.delete(key),
    get size() { return entries.size; },
  };
}

/**
 * @param {{ now?: () => number, maxEntries?: number }} [options] `now` is for tests
 */
function createGradeCache({ now = Date.now, maxEntries = MAX_ENTRIES } = {}) {
  const tokenMap = createTtlMap({ now, max: maxEntries });
  const resultMap = createTtlMap({ now, max: maxEntries });
  // Bumped by every invalidation. A lookup that started before one must not store its (now stale) answer.
  let generation = 0;

  return {
    tokens: {
      /** @returns {string|undefined} */
      get: key => tokenMap.get(key)?.value,
      /** Caches `token` for `expiresInSeconds` minus the safety margin; a too-short lifetime is not cached. */
      set(key, token, expiresInSeconds) {
        const ttlMs = expiresInSeconds * 1000 - TOKEN_EXPIRY_MARGIN_MS;
        if (Number.isFinite(ttlMs) && ttlMs > 0) tokenMap.set(key, token, ttlMs);
      },
      delete: key => { tokenMap.delete(key); },
    },
    results: {
      /** @returns {{ value: number|null }|undefined} the remembered answer, `value` null = not submitted */
      get(key) {
        const entry = resultMap.get(key);
        return entry && { value: entry.value };
      },
      /** Call before asking the LMS; pass the ticket to `set` with the answer. */
      begin: () => generation,
      set(key, value, ticket) {
        if (ticket === generation) resultMap.set(key, value, RESULT_TTL_MS);
      },
      delete(key) {
        generation++;
        resultMap.delete(key);
      },
    },
    size: () => ({ tokens: tokenMap.size, results: resultMap.size }),
  };
}

module.exports = { createGradeCache, RESULT_TTL_MS, TOKEN_EXPIRY_MARGIN_MS, MAX_ENTRIES };
