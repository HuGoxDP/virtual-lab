// backend/catalog-input.js
//
// Validation of admin-supplied catalog JSON. Kept apart from the routes so the
// rules ("Що всередині" limits) live in one place and can be tested without HTTP.

const MAX_FEATURES = 6;
const MAX_FEATURE_TITLE = 60;
const MAX_FEATURE_SUBTITLE = 90;
const FEATURE_ICON_PATTERN = /^[a-z0-9-]{1,40}$/;

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Checks the "Що всередині" list and returns a clean copy.
 *
 * Result is `{ value }` or `{ error }` (a Ukrainian message for the client).
 * Unknown keys on an item are dropped, so only the contract shape is stored.
 */
function validateFeatures(input) {
  if (!Array.isArray(input)) return { error: 'features має бути масивом' };
  if (input.length > MAX_FEATURES) return { error: `features: не більше ${MAX_FEATURES} елементів` };

  const value = [];
  for (const [index, item] of input.entries()) {
    const at = `features[${index}]`;
    if (!isPlainObject(item)) return { error: `${at}: очікується об'єкт` };

    if (typeof item.icon !== 'string' || !FEATURE_ICON_PATTERN.test(item.icon)) {
      return { error: `${at}.icon: 1–40 символів a-z, 0-9 та "-"` };
    }

    const title = typeof item.title === 'string' ? item.title.trim() : '';
    if (title.length < 1 || title.length > MAX_FEATURE_TITLE) {
      return { error: `${at}.title: від 1 до ${MAX_FEATURE_TITLE} символів` };
    }

    const clean = { icon: item.icon, title };
    if (item.subtitle !== undefined && item.subtitle !== null) {
      if (typeof item.subtitle !== 'string' || item.subtitle.length > MAX_FEATURE_SUBTITLE) {
        return { error: `${at}.subtitle: не більше ${MAX_FEATURE_SUBTITLE} символів` };
      }
      clean.subtitle = item.subtitle;
    }
    value.push(clean);
  }
  return { value };
}

/**
 * Fields an author key may never send. Everything that points at storage or
 * decides visibility or attribution is a moderator's: `scenarioUrl`,
 * `manifestUrl`, `imageUrl`, any `archive*`, `author`, `isPublished`.
 * (`categoryLabel` is not here: it is ignored, not refused.)
 */
const AUTHOR_FORBIDDEN_FIELDS = ['scenarioUrl', 'manifestUrl', 'imageUrl', 'author', 'isPublished'];

/** The names in `body` an author may not send, in the order found; empty when the body is clean. */
function forbiddenAuthorFields(body) {
  return Object.keys(body ?? {}).filter(
    key => AUTHOR_FORBIDDEN_FIELDS.includes(key) || key.startsWith('archive')
  );
}

module.exports = { validateFeatures, forbiddenAuthorFields, AUTHOR_FORBIDDEN_FIELDS, MAX_FEATURES, MAX_FEATURE_TITLE, MAX_FEATURE_SUBTITLE };
