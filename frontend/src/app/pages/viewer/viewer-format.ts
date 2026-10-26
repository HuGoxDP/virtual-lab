// path: src/app/pages/viewer/viewer-format.ts
//
// Pure helpers of the viewer, kept out of ViewerComponent so they can be tested without an engine.

/** Stage label while the archive travels over the network. */
export const STAGE_FETCH = 'Отримання даних із сервера';

/** Stage label while the engine unpacks the scenario and starts it. */
export const STAGE_ENGINE = 'Ініціалізація сцени';

const BYTES_PER_MB = 1024 * 1024;

/** `12,3` — megabytes with one decimal and a comma, like the prototype. */
function megabytes(bytes: number): string {
  return (Math.max(0, bytes) / BYTES_PER_MB).toFixed(1).replace('.', ',');
}

/**
 * The line under the title while downloading: `Завантаження архіву — 3,2 з 48,2 МБ`.
 *
 * `''` when nothing was downloaded (the streamed path has no archive). An unknown total (the server
 * sent no Content-Length: 0 / null / NaN) gives `— 3,2 МБ`. A total smaller than what already
 * arrived is a wrong Content-Length (a compressed transfer, say): it is dropped rather than printed,
 * so the line never says "5 з 3".
 */
export function byteLabel(loadedBytes: number | null | undefined, totalBytes: number | null | undefined): string {
  if (loadedBytes == null || !Number.isFinite(loadedBytes)) return '';

  const prefix = 'Завантаження архіву — ';
  const total = totalBytes ?? 0;
  if (!Number.isFinite(total) || total <= 0 || loadedBytes > total) {
    return `${prefix}${megabytes(loadedBytes)} МБ`;
  }
  return `${prefix}${megabytes(loadedBytes)} з ${megabytes(total)} МБ`;
}

/** Accepts `1`, `true` or a bare `?flag`; anything else (including a missing parameter) means off. */
export function readFlag(raw: string | null): boolean {
  if (raw === null) return false;
  const v = raw.toLowerCase();
  return v === '' || v === '1' || v === 'true';
}
