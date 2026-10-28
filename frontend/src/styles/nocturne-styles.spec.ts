/// <reference types="node" />
// path: src/styles/nocturne-styles.spec.ts
//
// Covers test-plan scenario 112, 113 (DW-2.1, DW-2.2 stylesheet half).
//
// Release 1, phase 2 - DW-2.1 (tokens and component classes carry the design file's values, the page
// ground is #161826, no light theme) and the stylesheet half of DW-2.2 (Inter faces point at files
// that ship). The design file is outside the repo; `nocturne.fixture.ts` is the committed copy.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { NOCTURNE_KEYFRAMES, NOCTURNE_RULES, NOCTURNE_TOKENS } from './nocturne.fixture';

const STYLES_DIR = 'src/styles';

const read = (file: string): string => readFileSync(join(STYLES_DIR, file), 'utf8');
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Flat `selector { declarations }` rules, whitespace-collapsed. */
function parseRules(css: string): Array<[string, string]> {
  return [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => [collapse(m[1]), collapse(m[2])]);
}

/** `--name: value` pairs of every `:root` block. */
function parseTokens(css: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const [selector, body] of parseRules(css)) {
    if (selector !== ':root') continue;
    for (const declaration of body.split(';')) {
      const colon = declaration.indexOf(':');
      if (colon > 0) tokens[collapse(declaration.slice(0, colon))] = collapse(declaration.slice(colon + 1));
    }
  }
  return tokens;
}

/** Every stylesheet source that ships to the browser. */
function allStylesheets(): Array<[string, string]> {
  const files = readdirSync(STYLES_DIR).filter(f => f.endsWith('.scss')).map(f => join(STYLES_DIR, f));
  return [...files, 'src/styles.scss'].map(f => [f, readFileSync(f, 'utf8')]);
}

describe('Nocturne stylesheet source (DW-2.1)', () => {
  const tokensSource = read('_tokens.scss');
  const rulesSource = `${read('_base.scss')}\n${read('_components.scss')}`;

  it('DW-2.1 defines every design token with the design file value', () => {
    const tokens = parseTokens(tokensSource);
    expect(Object.keys(NOCTURNE_TOKENS).length).toBeGreaterThan(45);
    for (const [name, value] of Object.entries(NOCTURNE_TOKENS)) {
      expect(tokens[name], name).toBe(value);
    }
  });

  it('DW-2.1 the page ground is #161826 and the body paints it', () => {
    expect(parseTokens(tokensSource)['--color-bg']).toBe('#161826');
    const body = parseRules(rulesSource).find(([selector]) => selector.startsWith('body'));
    expect(body?.[1]).toContain('background: var(--color-bg)');
  });

  it('DW-2.1 carries every base and component rule of the design file unchanged', () => {
    const present = new Set(parseRules(rulesSource).map(([selector, body]) => `${selector}\u0000${body}`));
    expect(NOCTURNE_RULES.length).toBeGreaterThan(80);
    for (const [selector, body] of NOCTURNE_RULES) {
      expect(present.has(`${selector}\u0000${body}`), `${selector} { ${body} }`).toBe(true);
    }
  });

  it('DW-2.1 has the component classes the foundation promises', () => {
    const selectors = parseRules(rulesSource).map(([selector]) => selector).join(' ,');
    const promised = [
      'btn', 'btn-primary', 'btn-secondary', 'btn-ghost', 'btn-icon', 'btn-block', 'input', 'field', 'seg', 'seg-opt',
      'tag', 'tag-accent', 'tag-outline', 'tag-neutral', 'card-kicker', 'card-title', 'card-body', 'card-meta',
      'table', 'hr', 'text-muted',
    ];
    for (const name of promised) {
      expect(new RegExp(`\\.${name}(?![\\w-])`).test(selectors), `.${name}`).toBe(true);
    }
  });

  it('DW-2.1 has the vl-* keyframes of the design file', () => {
    const css = collapse(stripComments(read('_animations.scss')));
    for (const [name, frames] of NOCTURNE_KEYFRAMES) {
      expect(css, name).toContain(`@keyframes ${name}{${frames}}`);
    }
  });

  it('DW-2.1 no light-theme rules remain in any global stylesheet', () => {
    for (const [file, css] of allStylesheets()) {
      expect(stripComments(css), file).not.toMatch(/dark-theme|light-theme|prefers-color-scheme|color-scheme\s*:\s*light/i);
    }
  });

  it('DW-2.1 styles.scss pulls in every partial', () => {
    const entry = readFileSync('src/styles.scss', 'utf8');
    const partials = readdirSync(STYLES_DIR).filter(f => f.startsWith('_')).map(f => f.slice(1, -'.scss'.length));
    expect(partials.length).toBeGreaterThanOrEqual(5);
    for (const partial of partials) expect(entry, partial).toContain(`@use 'styles/${partial}'`);
  });
});

describe('Inter font faces (DW-2.2)', () => {
  const faces = [...read('_fonts.scss').matchAll(/@font-face\s*\{([^}]*)\}/g)].map(m => m[1]);
  const field = (face: string, name: string): string => face.match(new RegExp(`${name}:\\s*([^;]+);`))![1].trim();

  it('DW-2.2 declares Inter 400 and 500 for cyrillic-ext, cyrillic and latin', () => {
    expect(faces).toHaveLength(6);
    const seen = faces.map(f => `${field(f, 'font-weight')}:${field(f, 'src').match(/inter-([a-z-]+)-\d+\.woff2/)![1]}`);
    for (const weight of ['400', '500']) {
      for (const subset of ['cyrillic-ext', 'cyrillic', 'latin']) expect(seen).toContain(`${weight}:${subset}`);
    }
  });

  it('DW-2.2 every face is served from /assets/fonts/ and the file ships', () => {
    for (const face of faces) {
      const url = field(face, 'src').match(/url\("([^"]+)"\)/)![1];
      expect(url).toMatch(/^\/assets\/fonts\/inter-[a-z-]+-\d+\.woff2$/);
      expect(existsSync(join('src', url)), url).toBe(true);
      expect(field(face, 'font-display')).toBe('swap');
    }
  });

  it('DW-2.2 the cyrillic subset covers Ukrainian (і ї є ґ)', () => {
    const cyrillic = faces.find(f => field(f, 'src').includes('inter-cyrillic-400'))!;
    const ranges = field(cyrillic, 'unicode-range');
    expect(ranges).toContain('U+0400-045F'); // includes і (0456) ї (0457) є (0454)
    expect(ranges).toContain('U+0490-0491'); // Ґ ґ
  });

  it('DW-2.2 no stylesheet references a third-party origin', () => {
    for (const [file, css] of allStylesheets()) expect(stripComments(css), file).not.toMatch(/https?:\/\//);
  });
});

describe('the old admin is gone (release 2, phase 6)', () => {
  it('DW-6.4 no legacy stylesheet or legacy admin component is left to maintain', () => {
    expect(existsSync(join('src/styles', '_legacy.scss'))).toBe(false);
    expect(existsSync('src/app/pages/admin/legacy')).toBe(false);
  });
});
