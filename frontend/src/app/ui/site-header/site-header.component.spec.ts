// path: src/app/ui/site-header/site-header.component.spec.ts
//
// Release 1, phase 2 - DW-2.4: the header renders the texts of site.config.ts, and its two brand
// modes put the logo and the projected slots in the order the catalog and scenario pages need.

import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { SITE } from '../../site.config';
import { SiteHeaderComponent } from './site-header.component';

@Component({
  standalone: true,
  imports: [SiteHeaderComponent],
  template: `
    <vl-site-header [brand]="brand">
      <input header-start class="search" />
      <button header-end class="account">Увійти</button>
    </vl-site-header>
  `,
})
class HostComponent {
  brand: 'full' | 'logo' = 'full';
}

async function render(brand: 'full' | 'logo'): Promise<HTMLElement> {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.componentInstance.brand = brand;
  fixture.detectChanges();
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

/** Document order of the header's meaningful pieces. */
const order = (root: HTMLElement): string[] =>
  [...root.querySelectorAll('.brand, .search, .account, header > vl-site-logo')].map(el =>
    el.classList.contains('brand') ? 'brand' : el.classList.contains('search') ? 'start' : el.classList.contains('account') ? 'end' : 'logo',
  );

describe('SiteHeaderComponent', () => {
  it('DW-2.4 full: renders the site and university names from site.config.ts, linking to the catalog', async () => {
    const root = await render('full');
    expect(root.querySelector('.brand-name')!.textContent!.trim()).toBe(SITE.name);
    expect(root.querySelector('.brand-sub')!.textContent!.trim()).toBe(SITE.university);
    expect(root.querySelector('.brand')!.getAttribute('href')).toBe('/catalog');
  });

  it('DW-2.4 the logo comes from site.config.ts', async () => {
    const img = (await render('full')).querySelector('img')!;
    expect(img.getAttribute('src')).toBe(SITE.logo.src);
    expect(img.getAttribute('alt')).toBe(SITE.logo.alt);
  });

  it('DW-2.4 full: logo + names first, then [header-start], then [header-end]', async () => {
    expect(order(await render('full'))).toEqual(['brand', 'start', 'end']);
  });

  it('DW-2.4 logo: the start slot fills the left, the logo alone comes last, with no names', async () => {
    const root = await render('logo');
    expect(order(root)).toEqual(['start', 'end', 'logo']);
    expect(root.querySelector('.brand-name')).toBeNull();
    expect(root.textContent).not.toContain(SITE.university);
    expect(root.querySelectorAll('img')).toHaveLength(1);
  });

  it('projects slot content in both modes', async () => {
    for (const brand of ['full', 'logo'] as const) {
      const root = await render(brand);
      TestBed.resetTestingModule();
      expect(root.querySelector('.search'), brand).not.toBeNull();
      expect(root.querySelector('.account')!.textContent, brand).toBe('Увійти');
    }
  });

  it('defaults to the full brand', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(SiteHeaderComponent);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.brand')).not.toBeNull();
  });
});
