// backend/preview-image.js
//
// Inspects a cover image before it may enter the preview store, from its bytes alone.
//
// The type comes from the magic bytes - never from the file name or the declared content type,
// both of which the uploader controls - and only PNG and JPEG are accepted (SVG can carry script,
// GIF is not worth the exception). Dimensions are read from the headers, no decoder involved, so
// a hostile file cannot cost more than a bounded scan of its first segments.

const {
  PREVIEW_MAX_BYTES, PREVIEW_MIN_WIDTH, PREVIEW_ASPECT, PREVIEW_ASPECT_TOLERANCE, PREVIEW_MAX_DIMENSION,
} = require('./config');
const { httpError } = require('./http-error');

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
/** Signature (8) + IHDR length and type (8) + width and height (8). */
const PNG_HEADER_BYTES = 24;

const JPEG_SIGNATURE = Buffer.from('ffd8ff', 'hex');
/** Start-of-frame markers carry the dimensions; C4 (DHT), C8 (JPG) and CC (DAC) share the range but are not frames. */
const isStartOfFrame = marker => marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);

const TRUNCATED = 'Файл зображення пошкоджений або обрізаний';

/** `{ width, height }` from a PNG's IHDR, or null when the buffer ends first or the chunk is not IHDR. */
function pngSize(buffer) {
  if (buffer.length < PNG_HEADER_BYTES || buffer.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * `{ width, height }` from the first start-of-frame segment of a JPEG, or null if the buffer
 * ends first. Walks segment by segment (each declares its length), so it is linear in the number
 * of segments and never reads past the buffer.
 */
function jpegSize(buffer) {
  let at = 2;
  while (at + 4 <= buffer.length) {
    if (buffer[at] !== 0xff) return null;
    const marker = buffer[at + 1];
    if (marker === 0xff) { at++; continue; }           // fill byte before a marker
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; } // no length
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of scan: no frame header came first

    const length = buffer.readUInt16BE(at + 2);
    if (length < 2) return null;
    if (isStartOfFrame(marker)) {
      if (at + 9 > buffer.length) return null;
      return { height: buffer.readUInt16BE(at + 5), width: buffer.readUInt16BE(at + 7) };
    }
    at += 2 + length;
  }
  return null;
}

/**
 * Checks `buffer` as a cover image.
 *
 * Returns `{ ext, type, width, height, warnings }`: `ext` is `png` or `jpg`; `warnings` holds a
 * message when the picture is not 16:10 within the tolerance (stored regardless - a card crops it).
 * Throws `httpError(400)` for anything else: not a PNG or JPEG, too large, shorter than its header,
 * a zero or absurd size, or narrower than the minimum width.
 */
function inspectPreview(buffer) {
  if (buffer.length > PREVIEW_MAX_BYTES) {
    throw httpError(400, `Зображення завелике: максимум ${PREVIEW_MAX_BYTES / (1024 * 1024)} МіБ`);
  }

  let kind;
  let size;
  if (buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    kind = { type: 'png', ext: 'png' };
    size = pngSize(buffer);
  } else if (buffer.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) {
    kind = { type: 'jpeg', ext: 'jpg' };
    size = jpegSize(buffer);
  } else {
    throw httpError(400, 'Дозволені лише зображення PNG та JPEG');
  }

  if (!size) throw httpError(400, TRUNCATED);
  const { width, height } = size;
  if (width < 1 || height < 1) throw httpError(400, TRUNCATED);
  if (width > PREVIEW_MAX_DIMENSION || height > PREVIEW_MAX_DIMENSION) {
    throw httpError(400, `Зображення завелике: не більше ${PREVIEW_MAX_DIMENSION} пікселів з кожного боку`);
  }
  if (width < PREVIEW_MIN_WIDTH) {
    throw httpError(400, `Ширина зображення ${width} px: потрібно щонайменше ${PREVIEW_MIN_WIDTH} px`);
  }

  const warnings = [];
  if (Math.abs(width / height - PREVIEW_ASPECT) / PREVIEW_ASPECT > PREVIEW_ASPECT_TOLERANCE) {
    warnings.push(`Співвідношення сторін ${width}×${height} відрізняється від 16:10 — картку буде обрізано`);
  }

  return { ...kind, width, height, warnings };
}

module.exports = { inspectPreview };
