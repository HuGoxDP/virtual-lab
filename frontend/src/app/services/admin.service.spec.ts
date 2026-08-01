// path: src/app/services/admin.service.spec.ts
//
// Covers test-plan scenarios 83, 84 and the error-mapping half of 82.

import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpErrorResponse } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { AdminService, ScenarioDraft } from './admin.service';

const DRAFT: ScenarioDraft = {
  id: 'probe',
  title: 'Probe',
  description: '',
  fullDescription: '',
  category: 'test',
  categoryLabel: 'Test',
  imageUrl: '',
  version: '1.0.0',
  author: '',
};

describe('AdminService', () => {
  let service: AdminService;
  let http: HttpTestingController;

  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();

    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(AdminService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

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
  });

  describe('authorisation header', () => {
    beforeEach(() => service.setToken('secret-token'));

    it('is sent on the admin list', async () => {
      const pending = service.listScenarios();
      const req = http.expectOne('/api/admin/scenarios');
      expect(req.request.headers.get('Authorization')).toBe('Bearer secret-token');
      req.flush({ scenarios: [] });
      await pending;
    });

    it('is sent on create, update and delete', async () => {
      const create = service.createScenario(DRAFT);
      const createReq = http.expectOne('/api/catalog');
      expect(createReq.request.headers.get('Authorization')).toBe('Bearer secret-token');
      createReq.flush({});
      await create;

      const update = service.updateScenario('probe', { isPublished: false });
      const updateReq = http.expectOne('/api/catalog/probe');
      expect(updateReq.request.method).toBe('PUT');
      expect(updateReq.request.body.isPublished).toBe(false);
      updateReq.flush({});
      await update;

      const remove = service.deleteScenario('probe');
      const deleteReq = http.expectOne('/api/catalog/probe');
      expect(deleteReq.request.method).toBe('DELETE');
      deleteReq.flush({});
      await remove;
    });

    it('URL-encodes ids containing spaces', async () => {
      const pending = service.deleteScenario('with space');
      const req = http.expectOne('/api/catalog/with%20space');
      req.flush({});
      await pending;
    });
  });

  describe('uploadArchive', () => {
    beforeEach(() => service.setToken('secret-token'));

    it('posts multipart under the "archive" field and reports progress', async () => {
      const file = new File([new Uint8Array([1, 2, 3])], 'scenario.zip');
      const seen: number[] = [];

      const pending = service.uploadArchive('probe', file, p => seen.push(p));
      const req = http.expectOne('/api/scenarios/probe/archive');

      expect(req.request.body instanceof FormData).toBe(true);
      expect((req.request.body as FormData).get('archive')).toBe(file);
      expect(req.request.reportProgress).toBe(true);

      req.event({ type: 1, loaded: 50, total: 100 } as never);
      req.flush({
        id: 'probe', sha256: 'abc', bytes: 3,
        url: '/scenarios/abc.zip', deduplicated: false,
        manifestId: 'x.y', warnings: [],
      });

      const result = await pending;
      expect(seen).toEqual([50]);
      expect(result.sha256).toBe('abc');
    });
  });

  describe('describeError', () => {
    it('maps the auth statuses to actionable messages', () => {
      const at = (status: number) =>
        AdminService.describeError(new HttpErrorResponse({ status }));

      expect(at(401)).toMatch(/токен/i);
      expect(at(403)).toMatch(/Невірний/);
      expect(at(503)).toMatch(/ADMIN_TOKEN/);
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
