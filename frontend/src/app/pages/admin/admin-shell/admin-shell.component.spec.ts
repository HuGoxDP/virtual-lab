// path: src/app/pages/admin/admin-shell/admin-shell.component.spec.ts
//
// Test-plan scenario 209 (DW-5.1, DW-5.5): the frame names the user and the role, shows the items the role
// may use, signs out, follows a session that ended, and opens its sidebar as a drawer from the burger. Which
// layout applies at 390 px is CSS (a media query jsdom does not evaluate); what the burger does is tested
// here and the viewport itself in the e2e.

import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';

import { AdminSession } from '../../../services/admin-session.service';
import { AdminService } from '../../../services/admin.service';
import { settle } from '../admin-testing';
import { AdminShellComponent, initials } from './admin-shell.component';

@Component({ standalone: true, template: '<p class="stub">stub</p>' })
class StubPage {}

describe('AdminShellComponent', () => {
  let fixture: ComponentFixture<AdminShellComponent>;
  let root: HTMLElement;
  let http: HttpTestingController;

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'admin/scenarios', component: StubPage },
          { path: 'admin/login', component: StubPage },
          { path: 'catalog', component: StubPage },
        ]),
        provideHttpClient(), provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function openAs(identity: { role: string; label: string; keyId: number | null }, queueSize = 3): Promise<void> {
    const signedIn = TestBed.inject(AdminSession).signIn('code');
    http.expectOne('/api/auth/me').flush(identity);
    await signedIn;

    fixture = TestBed.createComponent(AdminShellComponent);
    root = fixture.nativeElement;
    fixture.detectChanges();
    if (identity.role === 'moderator') http.expectOne('/api/admin/dashboard').flush({ counts: {}, queueSize, activity: [] });
    await settle(fixture);
  }

  const navLabels = () => [...root.querySelectorAll('.nav-label')].map(el => el.textContent?.trim());
  const burger = () => root.querySelector<HTMLButtonElement>('.burger')!;
  const shell = () => root.querySelector<HTMLElement>('.shell')!;

  it('DW-5.1 shows the name and the role the server reported', async () => {
    await openAs({ role: 'author', label: 'Олена Мельник', keyId: 4 });
    expect(root.querySelector('.user-name')?.textContent).toBe('Олена Мельник');
    expect(root.querySelector('.user-role')?.textContent).toBe('Автор');
    expect(root.querySelector('.avatar')?.textContent).toBe('ОМ');
  });

  it('DW-5.1 an author sees their own list and upload, and no moderator items', async () => {
    await openAs({ role: 'author', label: 'А', keyId: 4 });
    expect(navLabels()).toEqual(['Мої сценарії', 'Завантажити']);
    expect(root.querySelector('.badge')).toBeNull();
  });

  it('DW-5.1 a moderator sees every item, the queue badge and the old interface', async () => {
    await openAs({ role: 'moderator', label: 'Модер', keyId: 1 }, 3);
    expect(navLabels()).toEqual(['Усі сценарії', 'Завантажити', 'Черга модерації', 'Напрями', 'Доступ', 'Старий інтерфейс']);
    expect(root.querySelector('.badge')?.textContent?.trim()).toBe('3');
    expect(root.querySelector('.user-role')?.textContent).toBe('Модератор');
  });

  it('a zero queue shows no badge', async () => {
    await openAs({ role: 'moderator', label: 'Модер', keyId: 1 }, 0);
    expect(root.querySelector('.badge')).toBeNull();
  });

  it('a failing queue call only drops the badge', async () => {
    const signedIn = TestBed.inject(AdminSession).signIn('code');
    http.expectOne('/api/auth/me').flush({ role: 'moderator', label: 'M', keyId: 1 });
    await signedIn;
    fixture = TestBed.createComponent(AdminShellComponent);
    root = fixture.nativeElement;
    fixture.detectChanges();
    http.expectOne('/api/admin/dashboard').flush('x', { status: 500, statusText: 'err' });
    await settle(fixture);
    expect(root.querySelector('.badge')).toBeNull();
    expect(navLabels()).toContain('Черга модерації');
  });

  it('DW-5.1 sign-out clears sessionStorage and goes to the sign-in screen', async () => {
    await openAs({ role: 'author', label: 'А', keyId: 4 });
    expect(sessionStorage.getItem('adminToken')).toBe('code');

    root.querySelector<HTMLButtonElement>('.sign-out')!.click();
    await settle(fixture);
    await fixture.whenStable();

    expect(sessionStorage.getItem('adminToken')).toBeNull();
    expect(TestBed.inject(Router).url).toBe('/admin/login');
    expect(root.querySelector('.user-card')).toBeNull();
  });

  it('DW-5.5 a session that ends under the screen (a revoked code) sends the user to sign-in', async () => {
    await openAs({ role: 'author', label: 'А', keyId: 4 });
    TestBed.inject(AdminService).endSession('Код доступу недійсний або відкликаний: увійдіть знову.');
    await settle(fixture);
    await fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/admin/login');
  });

  describe('the drawer (DW-5.5)', () => {
    beforeEach(() => openAs({ role: 'author', label: 'А', keyId: 4 }));

    it('is closed at first; the burger opens it and says so', () => {
      expect(shell().classList.contains('menu-open')).toBe(false);
      expect(burger().getAttribute('aria-expanded')).toBe('false');
      expect(burger().getAttribute('aria-controls')).toBe('admin-sidebar');
      expect(root.querySelector('#admin-sidebar')).not.toBeNull();

      burger().click();
      fixture.detectChanges();
      expect(shell().classList.contains('menu-open')).toBe(true);
      expect(burger().getAttribute('aria-expanded')).toBe('true');
    });

    it('closes from the burger, the scrim and Escape', () => {
      const open = () => { burger().click(); fixture.detectChanges(); };

      open(); burger().click(); fixture.detectChanges();
      expect(shell().classList.contains('menu-open')).toBe(false);

      open(); root.querySelector<HTMLElement>('.scrim')!.click(); fixture.detectChanges();
      expect(shell().classList.contains('menu-open')).toBe(false);

      open(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); fixture.detectChanges();
      expect(shell().classList.contains('menu-open')).toBe(false);
    });

    it('closes when a navigation ends', async () => {
      burger().click();
      fixture.detectChanges();
      await TestBed.inject(Router).navigateByUrl('/admin/scenarios');
      fixture.detectChanges();
      expect(shell().classList.contains('menu-open')).toBe(false);
    });
  });
});

describe('initials', () => {
  it('takes the first letter of up to two words, upper-cased', () => {
    expect(initials('Олена Мельник')).toBe('ОМ');
    expect(initials('  іван   петрович  коваль ')).toBe('ІП');
    expect(initials('bootstrap')).toBe('B');
  });

  it('never returns an empty avatar', () => {
    expect(initials('')).toBe('?');
    expect(initials('   ')).toBe('?');
  });
});
