// path: src/app/services/admin-session.service.spec.ts
//
// Test-plan scenario 208 (DW-5.1): signing in by code shows who the server says it is, the code lives only in
// sessionStorage and goes away on sign-out. Scenario 225 (DW-6.3): a transient restore failure keeps the code.

import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { AdminSession } from './admin-session.service';
import { AdminService } from './admin.service';

describe('AdminSession', () => {
  let session: AdminSession;
  let admin: AdminService;
  let http: HttpTestingController;

  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    session = TestBed.inject(AdminSession);
    admin = TestBed.inject(AdminService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('DW-5.1 an author code shows the name and the author role from /api/auth/me', async () => {
    const pending = session.signIn('  author-code  ');
    const req = http.expectOne('/api/auth/me');
    expect(req.request.headers.get('Authorization')).toBe('Bearer author-code');
    req.flush({ role: 'author', label: 'Олена Мельник', keyId: 7 });

    expect(await pending).toEqual({ role: 'author', label: 'Олена Мельник', keyId: 7 });
    expect(session.user()?.label).toBe('Олена Мельник');
    expect(session.role()).toBe('author');
    expect(session.isModerator()).toBe(false);
  });

  it('DW-5.1 a moderator code (the bootstrap has keyId null) is a moderator', async () => {
    const pending = session.signIn('boot');
    http.expectOne('/api/auth/me').flush({ role: 'moderator', label: 'bootstrap', keyId: null });
    await pending;
    expect(session.isModerator()).toBe(true);
    expect(session.user()?.keyId).toBeNull();
  });

  it('DW-5.1 the code is kept only in sessionStorage', async () => {
    const pending = session.signIn('secret-code');
    http.expectOne('/api/auth/me').flush({ role: 'author', label: 'A', keyId: 1 });
    await pending;

    expect(sessionStorage.getItem('adminToken')).toBe('secret-code');
    expect(JSON.stringify({ ...localStorage })).not.toContain('secret-code');
  });

  it('DW-5.1 a revoked or unknown code (403) is refused with a message and nothing is stored', async () => {
    const pending = session.signIn('revoked').then(() => null, err => err as Error);
    http.expectOne('/api/auth/me').flush({ error: 'Невірний токен' }, { status: 403, statusText: 'Forbidden' });

    expect((await pending)?.message).toMatch(/Невірний або відкликаний/);
    expect(sessionStorage.getItem('adminToken')).toBeNull();
    expect(session.user()).toBeNull();
    expect(admin.endedReason()).toBeNull();
  });

  it('DW-5.1 empty or blank input is refused without a request', async () => {
    for (const blank of ['', '   ']) {
      await expect(session.signIn(blank)).rejects.toThrow(/Введіть код/);
    }
    http.expectNone('/api/auth/me');
    expect(sessionStorage.getItem('adminToken')).toBeNull();
  });

  it('DW-5.1 sign-out clears sessionStorage and the user', async () => {
    const pending = session.signIn('code');
    http.expectOne('/api/auth/me').flush({ role: 'author', label: 'A', keyId: 1 });
    await pending;

    session.signOut();
    expect(sessionStorage.getItem('adminToken')).toBeNull();
    expect(session.user()).toBeNull();
    expect(admin.isAuthenticated()).toBe(false);
  });

  it('the user disappears when the code is cleared anywhere else (a revoked key noticed by the API)', async () => {
    const pending = session.signIn('code');
    http.expectOne('/api/auth/me').flush({ role: 'moderator', label: 'M', keyId: 2 });
    await pending;

    admin.endSession('Код відкликано.');
    expect(session.user()).toBeNull();
    expect(session.role()).toBeNull();
  });

  describe('restore after a reload', () => {
    it('is false without a code and asks nothing', async () => {
      expect(await session.restore()).toBe(false);
      http.expectNone('/api/auth/me');
    });

    it('fetches the identity once for a stored code', async () => {
      admin.setToken('stored');
      const pending = session.restore();
      http.expectOne('/api/auth/me').flush({ role: 'author', label: 'Стара сесія', keyId: 3 });
      expect(await pending).toBe(true);
      expect(session.user()?.label).toBe('Стара сесія');

      expect(await session.restore()).toBe(true);
      http.expectNone('/api/auth/me');
    });

    it('a stored code the server now rejects is dropped with the reason', async () => {
      admin.setToken('revoked-since');
      const pending = session.restore();
      http.expectOne('/api/auth/me').flush({ error: 'Невірний токен' }, { status: 403, statusText: 'Forbidden' });
      expect(await pending).toBe(false);
      expect(admin.isAuthenticated()).toBe(false);
      expect(admin.endedReason()).toMatch(/відкликаний/);
    });

    it('DW-6.3 a transient failure (5xx) keeps the code and reports the problem instead of signing out', async () => {
      admin.setToken('stored');
      const pending = session.restore();
      http.expectOne('/api/auth/me').flush('boom', { status: 500, statusText: 'Server Error' });
      expect(await pending).toBe(false);
      expect(admin.isAuthenticated()).toBe(true);
      expect(sessionStorage.getItem('adminToken')).toBe('stored');
      expect(admin.endedReason()).toBeNull();
      expect(session.restoreProblem()).toMatch(/Помилка 500/);
      expect(session.user()).toBeNull();
    });

    it('DW-6.3 a network failure keeps the code too, and the next restore asks again and clears the problem', async () => {
      admin.setToken('stored');
      const first = session.restore();
      http.expectOne('/api/auth/me').error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });
      expect(await first).toBe(false);
      expect(admin.isAuthenticated()).toBe(true);
      expect(session.restoreProblem()).not.toBeNull();

      const second = session.restore();
      http.expectOne('/api/auth/me').flush({ role: 'author', label: 'A', keyId: 1 });
      expect(await second).toBe(true);
      expect(session.restoreProblem()).toBeNull();
    });

    it('DW-6.3 a credential rejection after an earlier outage drops the code and leaves no stale problem', async () => {
      admin.setToken('stored');
      const first = session.restore();
      http.expectOne('/api/auth/me').flush('boom', { status: 503, statusText: 'Unavailable' });
      await first;

      const second = session.restore();
      http.expectOne('/api/auth/me').flush({ error: 'Невірний токен' }, { status: 403, statusText: 'Forbidden' });
      expect(await second).toBe(false);
      expect(admin.isAuthenticated()).toBe(false);
      expect(session.restoreProblem()).toBeNull();
    });
  });
});
