// path: src/app/ui/site-footer/site-footer.component.spec.ts
//
// Covers test-plan scenario 116.
//
// Release 1, phase 5 - DW-5.1: the footer is the copyright bar only (phase 2's about / contacts /
// developers block and its archive-limit input were removed).

import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { SITE } from '../../site.config';
import { SiteFooterComponent } from './site-footer.component';

async function render(): Promise<HTMLElement> {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(SiteFooterComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

describe('SiteFooterComponent', () => {
  it('DW-5.1 renders the copyright bar from site.config.ts', async () => {
    const root = await render();
    expect(root.querySelector('.footer-legal')!.textContent!.trim()).toBe(SITE.copyright);
  });

  it('DW-5.1 has no .footer-inner: no brand, about, contacts, admin link or ZIP note', async () => {
    const root = await render();
    expect(root.querySelector('.footer-inner')).toBeNull();
    expect(root.querySelector('a')).toBeNull();
    const text = root.textContent!;
    for (const gone of [SITE.about, SITE.email, 'Розробникам', 'Контакти', 'ZIP', 'Панель адміністрування']) {
      expect(text, gone).not.toContain(gone);
    }
  });

  it('DW-5.1 takes no inputs: the archive limit is not fetched or shown', async () => {
    const root = await render();
    expect(root.querySelector('.archive-requirement')).toBeNull();
    expect(root.textContent).not.toMatch(/\d+\s*МБ/);
  });
});
