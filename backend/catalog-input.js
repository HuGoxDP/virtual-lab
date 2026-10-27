// backend/catalog-input.js
//
// Validation of admin-supplied catalog JSON. Kept apart from the routes so the
// rules ("Що всередині" limits) live in one place and can be tested without HTTP.

const { PREVIEW_URL } = require('./storage');

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

const CATEGORY_SLUG_PATTERN = /^[a-z0-9-]{2,50}$/;
const MAX_CATEGORY_LABEL = 100;

/**
 * Checks a category body. `create` requires `slug` and `label` (icon defaults to `folder`);
 * an update takes any of `label`, `icon`, `isVisible` (the slug never changes) and needs at
 * least one. Unknown keys are dropped.
 *
 * Result is `{ value }` (only the fields present, cleaned) or `{ error }` (Ukrainian).
 */
function validateCategory(body, { create }) {
  const input = isPlainObject(body) ? body : {};
  const value = {};

  if (create) {
    if (typeof input.slug !== 'string' || !CATEGORY_SLUG_PATTERN.test(input.slug)) {
      return { error: 'slug: 2–50 символів a-z, 0-9 та "-"' };
    }
    value.slug = input.slug;
  }

  if (input.label !== undefined || create) {
    const label = typeof input.label === 'string' ? input.label.trim() : '';
    if (label.length < 1 || label.length > MAX_CATEGORY_LABEL) {
      return { error: `label: від 1 до ${MAX_CATEGORY_LABEL} символів` };
    }
    value.label = label;
  }

  if (input.icon !== undefined) {
    if (typeof input.icon !== 'string' || !FEATURE_ICON_PATTERN.test(input.icon)) {
      return { error: 'icon: 1–40 символів a-z, 0-9 та "-"' };
    }
    value.icon = input.icon;
  } else if (create) {
    value.icon = 'folder';
  }

  if (input.isVisible !== undefined) {
    if (typeof input.isVisible !== 'boolean') return { error: 'isVisible має бути булевим' };
    value.isVisible = input.isVisible;
  }

  if (!create && Object.keys(value).length === 0) return { error: 'Не вказано жодного поля для оновлення' };
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

/**
 * Why a moderator may not set a row's `imageUrl` to `value` (`current` is what it holds now), or null.
 *
 * A cover changes through the preview upload and remove routes; a PUT/POST may only clear it,
 * restate it (the old admin form sends it on every save) or point at a stored preview. Anything
 * else is a way to reintroduce an off-origin image the CSP no longer allows.
 */
function imageUrlProblem(value, current) {
  if (typeof value !== 'string') return 'imageUrl має бути рядком';
  if (value === '' || value === current || PREVIEW_URL.test(value)) return null;
  return 'imageUrl змінюється завантаженням зображення; дозволено лише порожнє значення, поточне або шлях /previews/…';
}

/** The catalog id a `from-archive` scenario takes from its manifest: a slug of 2-100 characters. */
const SCENARIO_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,99}$/;

module.exports = { SCENARIO_ID_PATTERN, CATEGORY_SLUG_PATTERN, validateCategory, imageUrlProblem, validateFeatures, forbiddenAuthorFields, AUTHOR_FORBIDDEN_FIELDS, MAX_FEATURES, MAX_FEATURE_TITLE, MAX_FEATURE_SUBTITLE };
