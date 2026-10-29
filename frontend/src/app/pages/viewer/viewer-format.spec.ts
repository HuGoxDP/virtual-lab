// path: src/app/pages/viewer/viewer-format.spec.ts
//
// Covers test-plan scenario 138 (DW-4.1, DW-4.7).
//
// The byte line of the loading screen and the launch-flag parser the viewer relied on before the
// restyle (characterization of `readFlag`, which moved here unchanged).

import { byteLabel, readFlag } from './viewer-format';

const MB = 1024 * 1024;

describe('byteLabel', () => {
  it('DW-4.1 known total: "X з Y МБ" with comma decimals', () => {
    expect(byteLabel(3.2 * MB, 48.2 * MB)).toBe('Завантаження архіву — 3,2 з 48,2 МБ');
  });

  it('DW-4.1 unknown total (0): "X МБ" with no total', () => {
    expect(byteLabel(5 * MB, 0)).toBe('Завантаження архіву — 5,0 МБ');
    expect(byteLabel(5 * MB, null)).toBe('Завантаження архіву — 5,0 МБ');
    expect(byteLabel(5 * MB, Number.NaN)).toBe('Завантаження архіву — 5,0 МБ');
  });

  it('DW-4.1 loaded greater than total: the wrong total is dropped, never "5 з 3"', () => {
    expect(byteLabel(5 * MB, 3 * MB)).toBe('Завантаження архіву — 5,0 МБ');
  });

  it('loaded equal to total is a complete download', () => {
    expect(byteLabel(2 * MB, 2 * MB)).toBe('Завантаження архіву — 2,0 з 2,0 МБ');
  });

  it('nothing loaded yet reads 0,0 з Y', () => {
    expect(byteLabel(0, 10 * MB)).toBe('Завантаження архіву — 0,0 з 10,0 МБ');
  });

  it('is empty when there is no archive download (null / undefined / NaN loaded)', () => {
    expect(byteLabel(null, 10 * MB)).toBe('');
    expect(byteLabel(undefined, undefined)).toBe('');
    expect(byteLabel(Number.NaN, 10 * MB)).toBe('');
  });

  it('a negative loaded value is clamped to zero', () => {
    expect(byteLabel(-5, 0)).toBe('Завантаження архіву — 0,0 МБ');
  });
});

describe('readFlag', () => {
  it('accepts 1, true (any case) and a bare flag', () => {
    expect(readFlag('1')).toBe(true);
    expect(readFlag('true')).toBe(true);
    expect(readFlag('TRUE')).toBe(true);
    expect(readFlag('')).toBe(true);
  });

  it('everything else, and a missing parameter, is off', () => {
    expect(readFlag(null)).toBe(false);
    expect(readFlag('0')).toBe(false);
    expect(readFlag('false')).toBe(false);
    expect(readFlag('yes')).toBe(false);
  });
});

// ── player isolation, phase 5: error mapping, URL absolutising, the pause shortcut ──

import { absoluteUrl, isPauseShortcut, mapPlayerError, parseDraftHash, validReturnTo } from './viewer-format';

describe('mapPlayerError', () => {
  it('DW-5.2 handshake: a Ukrainian "no response" text, not the engine wording', () => {
    const text = mapPlayerError({ code: 'handshake', message: 'the player did not say hello' })!;
    expect(text).toContain('Відтворювач сценаріїв не відповів');
    expect(text).not.toContain('hello');
  });
  it('origin and version: the incompatibility text', () => {
    for (const code of ['origin', 'version'] as const) expect(mapPlayerError({ code, message: 'x' })).toContain('не сумісний');
  });
  it('load: the player message is kept; an empty one gets the fallback', () => {
    expect(mapPlayerError({ code: 'load', message: 'bad manifest' })).toBe('bad manifest');
    expect(mapPlayerError({ code: 'load', message: '  ' })).toBe('Не вдалося завантажити сценарій');
  });
  it('runtime: nothing to show', () => {
    expect(mapPlayerError({ code: 'runtime', message: 'TypeError' })).toBeNull();
  });
});

describe('absoluteUrl', () => {
  it('resolves a site-relative URL against the page and leaves an absolute one alone', () => {
    expect(absoluteUrl('/a/x.json', 'http://localhost:8045/play/x?stream=1')).toBe('http://localhost:8045/a/x.json');
    expect(absoluteUrl('https://cdn.example/a/x.json', 'http://localhost/')).toBe('https://cdn.example/a/x.json');
  });
});

describe('isPauseShortcut', () => {
  /** Dispatches a keydown and evaluates the predicate inside the listener, where `target` is set. */
  const decide = (init: KeyboardEventInit, target: Element = document.body, prevent = false): boolean => {
    let result = false;
    const handler = (e: KeyboardEvent) => { if (prevent) e.preventDefault(); result = isPauseShortcut(e); };
    document.addEventListener('keydown', handler, { once: true });
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    return result;
  };

  it('DW-5.2 a plain first-press Space on the page is the shortcut', () => {
    expect(decide({ code: 'Space' })).toBe(true);
  });
  it('is not the shortcut for repeats, modifiers or other keys', () => {
    expect(decide({ code: 'Space', repeat: true })).toBe(false);
    for (const mod of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey']) expect(decide({ code: 'Space', [mod]: true })).toBe(false);
    expect(decide({ code: 'KeyP' })).toBe(false);
  });
  it('is not the shortcut for controls that use Space, nor inside them', () => {
    for (const html of ['<button><span id="t">x</span></button>', '<a href="/x"><span id="t">x</span></a>', '<input id="t">', '<textarea id="t"></textarea>', '<select id="t"></select>', '<div contenteditable id="t"></div>', '<div role="button" id="t"></div>']) {
      const host = document.createElement('div');
      host.innerHTML = html;
      document.body.append(host);
      expect(decide({ code: 'Space' }, host.querySelector('#t')!), html).toBe(false);
      host.remove();
    }
  });
  it('is not the shortcut when the event was already handled', () => {
    expect(decide({ code: 'Space' }, document.body, true)).toBe(false);
  });
});

// Test-plan scenario 196 (DW-3.5): the draft preview's two URL parameters.
describe('parseDraftHash', () => {
  const HASH = 'a1'.repeat(32);
  it('DW-3.5 accepts exactly 64 hex characters and lowercases them', () => {
    expect(parseDraftHash(HASH)).toBe(HASH);
    expect(parseDraftHash(HASH.toUpperCase())).toBe(HASH);
  });
  it('is null when absent or malformed', () => {
    for (const raw of [null, '', HASH.slice(1), `${HASH}0`, `${HASH.slice(1)}g`, ` ${HASH.slice(1)}`, `${HASH}\n`, '../x']) {
      expect(parseDraftHash(raw), String(raw)).toBeNull();
    }
  });
});

describe('validReturnTo', () => {
  it('DW-3.5 accepts a relative path into /admin, with query and fragment', () => {
    for (const ok of ['/admin', '/admin/', '/admin/scenarios/x', '/admin/scenarios/x?tab=file', '/admin?x=1', '/admin#top', '/admin/a%20b']) {
      expect(validReturnTo(ok), ok).toBe(ok);
    }
  });
  it('DW-3.5 rejects anything that leaves /admin or the site', () => {
    for (const bad of [
      null, '', '/', '/catalog', '/administrator', '/admin2', 'admin/x', 'https://evil.example', 'http://evil.example/admin',
      '//evil.example', '//admin', '/\\evil.example', '/admin\\..\\x','/admin/../catalog', '/admin/./x', 'javascript:alert(1)',
      '/admin/x y', '/admin/x\ny', '/admin/x\u0000', ' /admin', '/admin\t',
    ]) {
      expect(validReturnTo(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
