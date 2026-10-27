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

/** The slice of a player error the viewer maps; structurally `PlayerError` from `WebEngineTS/player-host`. */
export interface PlayerFailure {
  code: 'handshake' | 'origin' | 'version' | 'load' | 'runtime';
  message: string;
}

/**
 * What the student reads for a failure of the isolated player, or `null` when nothing should be shown.
 *
 * `handshake`, `origin` and `version` mean the frame never became a usable player (blocked, offline, an
 * incompatible deploy): the engine's own text is for developers, so they get a Ukrainian explanation.
 * `load` carries the player's message about the scenario itself (a bad manifest, a failed entry point)
 * and is shown as the old viewer showed the engine's. `runtime` is a script error after a successful
 * start: the scene stays on screen, so it is not an error screen.
 */
export function mapPlayerError(error: PlayerFailure): string | null {
  switch (error.code) {
    case 'handshake':
      return 'Відтворювач сценаріїв не відповів. Оновіть сторінку; якщо помилка повторюється — перевірте з’єднання.';
    case 'origin':
    case 'version':
      return 'Відтворювач сценаріїв не сумісний із цією сторінкою. Оновіть сторінку.';
    case 'load':
      return error.message.trim() || 'Не вдалося завантажити сценарій';
    case 'runtime':
      return null;
  }
}

/** The player rejects relative URLs; a catalog `manifestUrl` is site-relative (`/a/<id>.json`). */
export function absoluteUrl(url: string, base: string): string {
  return new URL(url, base).href;
}

/** Elements for which Space already means something (activate, type, scroll a control). */
const SPACE_OWNERS = 'button, a[href], input, select, textarea, summary, [contenteditable], [role="button"]';

/**
 * Whether a keydown is the viewer's "pause" shortcut: a plain, first-press Space that is not
 * addressed to a control that uses Space itself. Only ever evaluated for keys that reach the host
 * page; with the scenario frame focused the player handles Space inside the frame instead.
 */
export function isPauseShortcut(event: KeyboardEvent): boolean {
  if (event.code !== 'Space' || event.repeat || event.defaultPrevented) return false;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  const target = event.target;
  return !(target instanceof Element && target.closest(SPACE_OWNERS));
}

/** A version hash in `?draft=`: exactly what the API's `?version=` accepts. */
const DRAFT_HASH = /^[0-9a-f]{64}$/i;

/** The sha256 of a draft preview from `?draft=`, lowercased; `null` when the parameter is absent or malformed. */
export function parseDraftHash(raw: string | null): string | null {
  return raw !== null && DRAFT_HASH.test(raw) ? raw.toLowerCase() : null;
}

/**
 * Where a draft preview's exit goes: `?returnTo=` only when it is a relative path into `/admin`.
 *
 * `returnTo` comes from the URL, so anyone can craft a link; navigating to it blindly would make the
 * viewer an open redirect. Accepted: `/admin` or `/admin/...` (optionally with a query or fragment),
 * and nothing that resolves off this origin - no scheme, no `//host`, no backslash (browsers read `\`
 * as `/`), no control characters or spaces, no `..` segment that could climb out of `/admin`.
 */
export function validReturnTo(raw: string | null): string | null {
  if (raw === null || !/^\/admin(?:[/?#]|$)/.test(raw)) return null;
  if (/[\\\s\u0000-\u001f\u007f]/.test(raw)) return null;
  const path = raw.split(/[?#]/, 1)[0];
  if (path.split('/').some(segment => segment === '..' || segment === '.')) return null;
  try {
    const url = new URL(raw, 'http://placeholder.invalid');
    return url.origin === 'http://placeholder.invalid' && url.pathname.startsWith('/admin') ? raw : null;
  } catch {
    return null;
  }
}
