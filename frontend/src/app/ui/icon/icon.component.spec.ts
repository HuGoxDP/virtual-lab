// path: src/app/ui/icon/icon.component.spec.ts
//
// Release 1, phase 2 - DW-2.3: <vl-icon> draws every hosted icon from the generated path data,
// inherits colour and size, and falls back (never throws) for names it does not know.

import { ComponentFixture, TestBed } from '@angular/core/testing';

import { IconComponent, ICON_NAMES } from './icon.component';
import { ICON_PATHS } from './icon-data.generated';

function render(name: string | null | undefined, size?: number | string): ComponentFixture<IconComponent> {
  const fixture = TestBed.createComponent(IconComponent);
  fixture.componentRef.setInput('name', name);
  if (size !== undefined) fixture.componentRef.setInput('size', size);
  fixture.detectChanges();
  return fixture;
}

const drawnPaths = (fixture: ComponentFixture<IconComponent>): string[] =>
  [...(fixture.nativeElement as HTMLElement).querySelectorAll('svg > path')].map(p => p.getAttribute('d')!);

describe('IconComponent', () => {
  it('DW-2.3 exposes a non-empty, duplicate-free ICON_NAMES backed by path data for each name', () => {
    expect(ICON_NAMES.length).toBeGreaterThan(40);
    expect(new Set(ICON_NAMES).size).toBe(ICON_NAMES.length);
    expect(Object.keys(ICON_PATHS).sort()).toEqual([...ICON_NAMES].sort());
  });

  it('DW-2.3 renders every ICON_NAMES entry as <svg><path d> with exactly its generated path data', () => {
    for (const name of ICON_NAMES) {
      const fixture = render(name);
      expect(drawnPaths(fixture), name).toEqual([...ICON_PATHS[name]]);
      expect(drawnPaths(fixture).every(d => d.length > 0), name).toBe(true);
      fixture.destroy();
    }
  });

  it('DW-2.3 inherits colour (currentColor) and, by default, the surrounding font size (1em)', () => {
    const svg = (render('play').nativeElement as HTMLElement).querySelector('svg')!;
    expect(svg.getAttribute('fill')).toBe('currentColor');
    expect(svg.getAttribute('viewBox')).toBe('0 0 256 256');
    expect(svg.getAttribute('width')).toBe('1em');
    expect(svg.getAttribute('height')).toBe('1em');
  });

  it('DW-2.3 size takes pixels as a number and any CSS length as a string', () => {
    expect((render('play', 14).nativeElement as HTMLElement).querySelector('svg')!.getAttribute('width')).toBe('14');
    expect((render('play', '2rem').nativeElement as HTMLElement).querySelector('svg')!.getAttribute('height')).toBe('2rem');
  });

  it('DW-2.3 is decorative for assistive technology', () => {
    const svg = (render('play').nativeElement as HTMLElement).querySelector('svg')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('focusable')).toBe('false');
  });

  it('DW-2.3 falls back to the folder icon for unknown, empty, null and undefined names without throwing', () => {
    const fallback = [...ICON_PATHS['folder']];
    for (const name of ['no-such-icon', '', null, undefined, '__proto__', 'constructor', 'toString', ' play ']) {
      expect(() => render(name), String(name)).not.toThrow();
      expect(drawnPaths(render(name)), String(name)).toEqual(fallback);
    }
  });

  it('DW-2.3 re-renders when the name changes', () => {
    const fixture = render('play');
    fixture.componentRef.setInput('name', 'pause');
    fixture.detectChanges();
    expect(drawnPaths(fixture)).toEqual([...ICON_PATHS['pause']]);
  });

  it('DW-2.3 the set covers the seeded category icons and the viewer HUD', () => {
    for (const name of ['lightning', 'dna', 'flask', 'bank', 'planet', 'cube', 'folder']) expect(ICON_NAMES).toContain(name);
    for (const name of ['play', 'pause', 'arrow-left', 'arrows-clockwise', 'corners-out', 'magnifying-glass', 'x']) {
      expect(ICON_NAMES).toContain(name);
    }
  });
});
