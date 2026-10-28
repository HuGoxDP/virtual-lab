// path: src/app/services/admin.service.spec.ts
//
// Token storage and error mapping (test-plan 82-84, 208). The bearer on each request is pinned in admin-api.service.spec.ts.

import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpErrorResponse } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';

import { AdminService } from './admin.service';

describe('AdminService', () => {
  let service: AdminService;

  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();

    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(AdminService);
  });

  describe('token storage', () => {
    it('starts unauthenticated', () => {
      expect(service.isAuthenticated()).toBe(false);
      expect(service.token()).toBe('');
    });

    it('stores the token in sessionStorage, never localStorage', () => {
      service.setToken('secret-token');

      // sessionStorage dies with the tab; localStorage would outlive it.
      expect(sessionStorage.getItem('adminToken')).toBe('secret-token');
      expect(localStorage.getItem('adminToken')).toBeNull();
      expect(service.isAuthenticated()).toBe(true);
    });

    it('trims surrounding whitespace', () => {
      service.setToken('  padded  ');
      expect(service.token()).toBe('padded');
    });

    it('clears the token on sign out', () => {
      service.setToken('secret-token');
      service.clearToken();

      expect(sessionStorage.getItem('adminToken')).toBeNull();
      expect(service.isAuthenticated()).toBe(false);
    });

    it('DW-5.5 endSession clears the code and remembers why; the next sign-in forgets the reason', () => {
      service.setToken('secret-token');
      service.endSession('Код відкликано.');

      expect(sessionStorage.getItem('adminToken')).toBeNull();
      expect(service.isAuthenticated()).toBe(false);
      expect(service.endedReason()).toBe('Код відкликано.');

      service.setToken('another');
      expect(service.endedReason()).toBeNull();
    });
  });

  describe('describeError', () => {
    it('maps the auth statuses to actionable messages', () => {
      const at = (status: number) =>
        AdminService.describeError(new HttpErrorResponse({ status }));

      expect(at(401)).toMatch(/код/i);
      expect(at(403)).toMatch(/Невірний/);
      // The server no longer answers 503 (an unset ADMIN_TOKEN only switches the bootstrap off).
      expect(at(503)).toBe('Помилка 503');
    });

    it('DW-5.5 the words the server sent win over the status text, so a refused action is not called a bad code', () => {
      const forbidden = new HttpErrorResponse({ status: 403, error: { error: 'Це не ваш сценарій' } });
      expect(AdminService.describeError(forbidden)).toBe('Це не ваш сценарій');
    });

    it('prefers the server-supplied message', () => {
      const err = new HttpErrorResponse({ status: 400, error: { error: 'Файл не є ZIP-архівом' } });
      expect(AdminService.describeError(err)).toBe('Файл не є ZIP-архівом');
    });

    it('falls back to the status code', () => {
      const err = new HttpErrorResponse({ status: 418 });
      expect(AdminService.describeError(err)).toBe('Помилка 418');
    });

    it('handles a plain Error and an unknown value', () => {
      expect(AdminService.describeError(new Error('boom'))).toBe('boom');
      expect(AdminService.describeError('weird')).toMatch(/Невідома/);
    });
  });
});
