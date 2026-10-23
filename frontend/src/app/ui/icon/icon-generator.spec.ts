/// <reference types="node" />
// path: src/app/ui/icon/icon-generator.spec.ts
//
// Release 1, phase 2 - DW-2.3: the committed icon-data.generated.ts is exactly what
// scripts/build-icons.mjs produces (re-running it is a no-op), and the generator refuses an icon
// that is not made of plain <path d> elements.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// @ts-expect-error - plain ESM script without type declarations
import { ICON_NAMES as SCRIPT_ICON_NAMES, parsePaths, renderIconModule } from '../../../../scripts/build-icons.mjs';
import { ICON_NAMES } from './icon-data.generated';

const SCRIPT = 'scripts/build-icons.mjs';
const GENERATED = 'src/app/ui/icon/icon-data.generated.ts';

const svg = (inner: string, attrs = 'viewBox="0 0 256 256" fill="currentColor"'): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${inner}</svg>`;

describe('build-icons generator', () => {
  it('DW-2.3 re-running the generator produces no diff (--check passes)', () => {
    expect(() => execFileSync(process.execPath, [SCRIPT, '--check'], { stdio: 'pipe' })).not.toThrow();
  });

  it('DW-2.3 --stdout output equals the committed file byte for byte, on every run', () => {
    const run = () => execFileSync(process.execPath, [SCRIPT, '--stdout'], { encoding: 'utf8' });
    const committed = readFileSync(GENERATED, 'utf8').replace(/\r\n/g, '\n');
    expect(run()).toBe(committed);
    expect(run()).toBe(run());
  });

  it('DW-2.3 the script is the single source of the list: the generated ICON_NAMES equals it, sorted and unique', () => {
    expect([...ICON_NAMES]).toEqual([...SCRIPT_ICON_NAMES]);
    expect([...ICON_NAMES]).toEqual([...new Set(ICON_NAMES)].sort());
  });

  it('renders a module from the SVG text it is given, deterministically', () => {
    const files: Record<string, string> = {
      a: svg('<path d="M0,0L1,1"/>'),
      b: svg('<path d="M1,1L2,2"/><path d="M3,3L4,4"/>'),
    };
    const first = renderIconModule(['a', 'b'], (name: string) => files[name]);
    expect(first).toBe(renderIconModule(['a', 'b'], (name: string) => files[name]));
    expect(first).toContain(`export const ICON_NAMES: readonly string[] = ['a', 'b'];`);
    expect(first).toContain(`'a': ['M0,0L1,1'],`);
    expect(first).toContain(`'b': ['M1,1L2,2', 'M3,3L4,4'],`);
  });

  it('DW-2.3 fails on an icon that is not path-only', () => {
    const reject = (markup: string) => () => parsePaths('dirty', markup);

    expect(reject(svg('<circle cx="1" cy="1" r="1"/>'))).toThrow(/path-only/);
    expect(reject(svg('<path d="M0,0"/><rect width="1" height="1"/>'))).toThrow(/path-only/);
    expect(reject(svg('<path d="M0,0" fill="none"/>'))).toThrow(/path-only/);
    expect(reject(svg('<g><path d="M0,0"/></g>'))).toThrow(/path-only/);
    expect(reject(svg(''))).toThrow(/path-only/);
    expect(reject(svg('<path d="M0,0"/>', 'viewBox="0 0 24 24"'))).toThrow(/viewBox/);
    expect(reject('<div></div>')).toThrow(/not an <svg>/);
  });
});
