// path: src/app/ui/site-footer/site-footer.component.spec.ts
//
// Covers test-plan scenario 116.
//
// Release 1, phase 2 - DW-2.4: the footer renders the texts of site.config.ts, and the archive limit
// comes from its input (never a hard-coded number, never a Unity/Drive wording).

import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { SITE } from '../../site.config';
import { SiteFooterComponent } from './site-footer.component';

async function render(maxArchiveBytes?: number | null): Promise<HTMLElement> {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(SiteFooterComponent);
  if (maxArchiveBytes !== undefined) fixture.componentRef.setInput('maxArchiveBytes', maxArchiveBytes);
  fixture.detectChanges();
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

const requirement = (root: HTMLElement): string => root.querySelector('.archive-requirement')!.textContent!.trim();

describe('SiteFooterComponent', () => {
  it('DW-2.4 renders the about text, address, e-mail and copyright from site.config.ts', async () => {
    const root = await render();
    const text = root.textContent!.replace(/\s+/g, ' ');
    expect(text).toContain(SITE.about);
    for (const line of SITE.address) expect(text).toContain(line);
    expect(text).toContain(SITE.copyright);
    expect(text).toContain(`${SITE.name} ${SITE.universityShort}`);

    const mail = root.querySelector('a[href^="mailto:"]')!;
    expect(mail.getAttribute('href')).toBe(`mailto:${SITE.email}`);
    expect(mail.textContent!.trim()).toBe(SITE.email);
  });

  it('DW-2.4 names the department in full (the footer wording, not the shortened hero tag)', async () => {
    expect((await render()).textContent).toContain('програмної інженерії та економічної кібернетики');
  });

  it('DW-2.4 links "Панель адміністрування" to /admin', async () => {
    const link = (await render()).querySelector('a.btn-ghost')!;
    expect(link.getAttribute('href')).toBe('/admin');
    expect(link.textContent!.trim()).toBe('Панель адміністрування');
  });

  it('DW-2.4 shows the archive limit passed in', async () => {
    expect(requirement(await render(200 * 1024 * 1024))).toBe('ZIP-архів зі сценарієм, до 200 МБ');
  });

  it('DW-2.4 the limit follows the input, not a constant', async () => {
    expect(requirement(await render(50 * 1024 * 1024))).toContain('50 МБ');
  });

  it('DW-2.4 without a limit (absent, null, 0 or invalid) states the format and no number', async () => {
    for (const value of [undefined, null, NaN, -5]) {
      const line = requirement(await render(value));
      TestBed.resetTestingModule();
      expect(line, String(value)).toBe('ZIP-архів зі сценарієм');
      expect(line).not.toMatch(/\d/);
    }
  });

  it('never ships the prototype\'s Unity / Drive / proxy wording', async () => {
    const text = (await render(1048576)).textContent!;
    expect(text).not.toMatch(/Unity|WebGL-збірк|Google|Drive|proxy|проксі/i);
  });
});
