// path: src/app/pages/admin/admin-login.component.spec.ts
//
// Test-plan scenario 209 (DW-5.1, DW-5.5): the sign-in screen takes a code, says what went wrong in a plaque
// under the field, shows why a session ended, and never keeps a code the server refused. Scenario 225 (DW-6.3): an outage on restore is reported with the code kept.

import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';

import { AdminSession } from '../../services/admin-session.service';
import { AdminService } from '../../services/admin.service';
import { AdminLoginComponent } from './admin-login.component';
import { settle } from './admin-testing';

@Component({ standalone: true, template: '' })
class StubPage {}

describe('AdminLoginComponent', () => {
  let fixture: ComponentFixture<AdminLoginComponent>;
  let root: HTMLElement;
  let http: HttpTestingController;
  let admin: AdminService;

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideRouter([{ path: 'admin/scenarios', component: StubPage }, { path: 'catalog', component: StubPage }]),
        provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    admin = TestBed.inject(AdminService);
  });

  afterEach(() => http.verify());

  function open(): void {
    fixture = TestBed.createComponent(AdminLoginComponent);
    root = fixture.nativeElement;
    fixture.detectChanges();
  }

  const input = () => root.querySelector<HTMLInputElement>('#access-code')!;
  const plaque = () => root.querySelector<HTMLElement>('.plaque');

  async function submit(code: string): Promise<void> {
    input().value = code;
    input().dispatchEvent(new Event('input'));
    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    await settle(fixture, 2);
  }

  it('DW-5.1 has one masked field and none of the prototype\'s demo codes or session-length claim', () => {
    open();
    expect(input().type).toBe('password');
    expect(input().autocomplete).toBe('off');
    expect(root.querySelectorAll('input').length).toBe(1);
    expect(root.textContent).not.toMatch(/12 годин|Демонстраційн|АВТОР-2026|МОДЕР-2026/);
    expect(root.textContent).toContain('Як працює публікація');
  });

  it('DW-5.1 a valid code signs in, keeps the code only in sessionStorage and goes to the list', async () => {
    open();
    await submit('good-code');
    http.expectOne('/api/auth/me').flush({ role: 'author', label: 'Олена', keyId: 2 });
    await settle(fixture);
    await fixture.whenStable();

    expect(sessionStorage.getItem('adminToken')).toBe('good-code');
    expect(TestBed.inject(Router).url).toBe('/admin/scenarios');
    expect(input().value).toBe('');
  });

  it('DW-5.1 a revoked code shows a plaque, stores nothing and stays on the form', async () => {
    open();
    await submit('revoked');
    http.expectOne('/api/auth/me').flush({ error: 'Невірний токен' }, { status: 403, statusText: 'Forbidden' });
    await settle(fixture);

    expect(plaque()?.textContent).toMatch(/Невірний або відкликаний/);
    expect(plaque()?.getAttribute('role')).toBe('alert');
    expect(sessionStorage.getItem('adminToken')).toBeNull();
    expect(TestBed.inject(Router).url).toBe('/');
  });

  it('DW-5.1 empty input says so without calling the server', async () => {
    open();
    await submit('   ');
    http.expectNone('/api/auth/me');
    expect(plaque()?.textContent).toMatch(/Введіть код/);
  });

  it('typing clears the previous failure', async () => {
    open();
    await submit('');
    expect(plaque()).not.toBeNull();
    input().value = 'a';
    input().dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(plaque()).toBeNull();
  });

  it('DW-5.5 a session that ended mid-way comes back here with its reason', () => {
    admin.endSession('Код доступу недійсний або відкликаний: увійдіть знову.');
    open();
    expect(plaque()?.textContent).toContain('недійсний або відкликаний');
  });

  it('DW-6.3 a stored code the server could not be asked about is kept and the plaque says so', async () => {
    admin.setToken('stored');
    const restored = TestBed.inject(AdminSession).restore();
    http.expectOne('/api/auth/me').flush('boom', { status: 502, statusText: 'Bad Gateway' });
    expect(await restored).toBe(false);

    open();
    expect(plaque()?.textContent).toContain('Не вдалося перевірити збережений код');
    expect(plaque()?.textContent).toContain('Помилка 502');
    expect(sessionStorage.getItem('adminToken')).toBe('stored');
  });

  it('a second submit while one is running is ignored', async () => {
    open();
    await submit('code');
    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    await settle(fixture, 1);
    http.expectOne('/api/auth/me').flush({ role: 'author', label: 'A', keyId: 1 });
    await settle(fixture);
  });
});
