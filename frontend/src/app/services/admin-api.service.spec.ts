// path: src/app/services/admin-api.service.spec.ts
//
// Test-plan scenario 208 (release 2, phase 5: DW-5.1, DW-5.5): the typed admin routes carry the session's
// bearer, and the answers that mean "the server stopped accepting this code" end the session while a refused
// action by a valid user does not.

import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { adminRow } from '../pages/admin/admin-testing';
import { AdminApi, UploadCancelled, isCredentialRejection } from './admin-api.service';
import { AdminService } from './admin.service';

describe('AdminApi', () => {
  let api: AdminApi;
  let admin: AdminService;
  let http: HttpTestingController;

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    api = TestBed.inject(AdminApi);
    admin = TestBed.inject(AdminService);
    http = TestBed.inject(HttpTestingController);
    admin.setToken('session-code');
  });

  afterEach(() => http.verify());

  describe('requests', () => {
    it('sends the session code as the bearer and unwraps the list', async () => {
      const pending = api.listScenarios();
      const req = http.expectOne('/api/admin/scenarios');
      expect(req.request.headers.get('Authorization')).toBe('Bearer session-code');
      req.flush({ scenarios: [adminRow('a')] });
      expect((await pending).map(row => row.id)).toEqual(['a']);
    });

    it('scenario(id) finds the row in the list, or answers null', async () => {
      const found = api.scenario('b');
      http.expectOne('/api/admin/scenarios').flush({ scenarios: [adminRow('a'), adminRow('b')] });
      expect((await found)?.id).toBe('b');

      const missing = api.scenario('zzz');
      http.expectOne('/api/admin/scenarios').flush({ scenarios: [adminRow('a')] });
      expect(await missing).toBeNull();
    });

    it('updateScenario PUTs only the patch to the encoded id', async () => {
      const pending = api.updateScenario('a b', { title: 'Нова' });
      const req = http.expectOne('/api/catalog/a%20b');
      expect(req.request.method).toBe('PUT');
      expect(req.request.body).toEqual({ title: 'Нова' });
      req.flush({ message: 'ok' });
      await pending;
    });

    it('transition posts the action; only a rejection carries its note', async () => {
      const submit = api.transition('a', 'submit', 'ignored');
      const submitReq = http.expectOne('/api/scenarios/a/submit');
      expect(submitReq.request.body).toEqual({});
      submitReq.flush({ id: 'a', status: 'review' });
      await submit;

      const reject = api.transition('a', 'reject', 'Додайте опис');
      const rejectReq = http.expectOne('/api/scenarios/a/reject');
      expect(rejectReq.request.body).toEqual({ note: 'Додайте опис' });
      rejectReq.flush({ id: 'a', status: 'rejected' });
      await reject;

      const bare = api.transition('a', 'reject');
      const bareReq = http.expectOne('/api/scenarios/a/reject');
      expect(bareReq.request.body).toEqual({});
      bareReq.flush({ id: 'a', status: 'rejected' });
      await bare;
    });

    it('bulk posts ids, action and category, and unwraps the per-id results', async () => {
      const pending = api.bulk(['a', 'b'], 'set-category', 'biology');
      const req = http.expectOne('/api/scenarios/bulk');
      expect(req.request.body).toEqual({ ids: ['a', 'b'], action: 'set-category', category: 'biology' });
      req.flush({ results: [{ id: 'a', ok: true }, { id: 'b', ok: false, error: 'Сценарій не знайдено' }] });
      expect(await pending).toEqual([{ id: 'a', ok: true }, { id: 'b', ok: false, error: 'Сценарій не знайдено' }]);

      const noCategory = api.bulk(['a'], 'approve');
      const approveReq = http.expectOne('/api/scenarios/bulk');
      expect(approveReq.request.body).toEqual({ ids: ['a'], action: 'approve' });
      approveReq.flush({ results: [] });
      await noCategory;
    });

    it('uploadPreview sends the file in the "preview" field', async () => {
      const file = new File(['x'], 'cover.png', { type: 'image/png' });
      const pending = api.uploadPreview('a', file);
      const req = http.expectOne('/api/scenarios/a/preview');
      expect((req.request.body as FormData).get('preview')).toBeInstanceOf(File);
      req.flush({ imageUrl: '/previews/x.png', warnings: ['16:10'] });
      expect(await pending).toEqual({ imageUrl: '/previews/x.png', warnings: ['16:10'] });
    });

    it('covers the remaining routes with the contract paths', async () => {
      const calls: Array<[Promise<unknown>, string, string, unknown?]> = [
        [api.versions('a'), 'GET', '/api/scenarios/a/versions', { versions: [] }],
        [api.history('a'), 'GET', '/api/scenarios/a/history', []],
        [api.dashboard(), 'GET', '/api/admin/dashboard', { counts: {}, queueSize: 0, activity: [] }],
        [api.categories(), 'GET', '/api/categories', { categories: [] }],
        [api.keys(), 'GET', '/api/keys', { keys: [] }],
        [api.revokeKey(4), 'POST', '/api/keys/4/revoke', {}],
        [api.versionAction('a', 3, 'accept'), 'POST', '/api/scenarios/a/versions/3/accept', {}],
        [api.deleteVersion('a', 3), 'DELETE', '/api/scenarios/a/versions/3', {}],
        [api.versionContents('a', 3), 'GET', '/api/scenarios/a/versions/3/contents', []],
        [api.runChecks('a', 3), 'POST', '/api/scenarios/a/versions/3/checks', { ok: true, items: [] }],
        [api.removePreview('a'), 'DELETE', '/api/scenarios/a/preview', { imageUrl: '' }],
        [api.config(), 'GET', '/api/config', {}],
        [api.reorderCategories(['a', 'b']), 'POST', '/api/categories/reorder', {}],
        [api.deleteCategory('a'), 'DELETE', '/api/categories/a', {}],
      ];
      for (const [pending, method, url, body] of calls) {
        const req = http.expectOne(url);
        expect(req.request.method).toBe(method);
        req.flush(body ?? {});
        await pending;
      }
    });
  });

  describe('remaining routes: method, path and body', () => {
    async function expectCall(pending: Promise<unknown>, method: string, url: string, body: unknown, answer: object = {}) {
      const req = http.expectOne(url);
      expect(req.request.method).toBe(method);
      expect(req.request.headers.get('Authorization')).toBe('Bearer session-code');
      if (body !== undefined) expect(req.request.body).toEqual(body);
      req.flush(answer);
      return pending;
    }

    it('createScenario POSTs the body to /api/catalog', async () => {
      await expectCall(api.createScenario({ id: 'n', title: 'T' }), 'POST', '/api/catalog', { id: 'n', title: 'T' });
    });

    it('deleteScenario DELETEs the encoded id', async () => {
      await expectCall(api.deleteScenario('a b'), 'DELETE', '/api/catalog/a%20b', undefined);
    });

    it('saveTestRun POSTs the run and unwraps the stored one', async () => {
      const run = { avgFps: 60, timeToFirstFrameMs: 900, gpuMemoryBytes: 1, consoleErrors: 0 };
      const stored = await expectCall(api.saveTestRun('a', 3, run), 'POST', '/api/scenarios/a/versions/3/test-run', run, { testRun: { ...run, ranBy: 'M' } });
      expect(stored).toEqual({ ...run, ranBy: 'M' });
    });

    it('createCategory POSTs and updateCategory PUTs to the encoded slug', async () => {
      const created = await expectCall(api.createCategory({ slug: 'chem', label: 'Хімія' }), 'POST', '/api/categories',
        { slug: 'chem', label: 'Хімія' }, { category: { slug: 'chem' } });
      expect(created).toMatchObject({ slug: 'chem' });
      const updated = await expectCall(api.updateCategory('c/d', { isVisible: false }), 'PUT', '/api/categories/c%2Fd',
        { isVisible: false }, { category: { slug: 'c/d', isVisible: false } });
      expect(updated).toMatchObject({ isVisible: false });
    });

    it('createKey POSTs label and role', async () => {
      const created = await expectCall(api.createKey('Олена', 'author'), 'POST', '/api/keys', { label: 'Олена', role: 'author' },
        { id: 5, label: 'Олена', role: 'author', token: 't' });
      expect(created).toMatchObject({ id: 5, token: 't' });
    });

    it('list wrappers fall back to [] when the key is missing', async () => {
      expect(await expectCall(api.versions('a'), 'GET', '/api/scenarios/a/versions', undefined, {})).toEqual([]);
      expect(await expectCall(api.categories(), 'GET', '/api/categories', undefined, {})).toEqual([]);
      expect(await expectCall(api.keys(), 'GET', '/api/keys', undefined, {})).toEqual([]);
      expect(await expectCall(api.listScenarios(), 'GET', '/api/admin/scenarios', undefined, {})).toEqual([]);
    });
  });

  describe('a rejected code (DW-5.5)', () => {
    async function failWith(status: number, message: string): Promise<unknown> {
      const pending = api.listScenarios();
      http.expectOne('/api/admin/scenarios').flush({ error: message }, { status, statusText: 'x' });
      return pending.then(() => null, err => err);
    }

    it('a 401 ends the session with a reason and still rejects to the caller', async () => {
      const err = await failWith(401, 'Потрібна авторизація');
      expect(err).toBeInstanceOf(HttpErrorResponse);
      expect(admin.isAuthenticated()).toBe(false);
      expect(sessionStorage.getItem('adminToken')).toBeNull();
      expect(admin.endedReason()).toMatch(/увійти знову/);
    });

    it('a 403 "Невірний токен" (unknown or revoked code) ends the session', async () => {
      await failWith(403, 'Невірний токен');
      expect(admin.isAuthenticated()).toBe(false);
      expect(admin.endedReason()).toMatch(/відкликаний/);
    });

    it('any other 403 is a refused action by a valid user: the session stays', async () => {
      await failWith(403, 'Недостатньо прав');
      expect(admin.isAuthenticated()).toBe(true);
      expect(admin.endedReason()).toBeNull();

      await failWith(403, 'Це не ваш сценарій');
      expect(admin.isAuthenticated()).toBe(true);
    });

    it('a 500 or 409 does not touch the session', async () => {
      await failWith(500, 'Помилка сервера');
      await failWith(409, 'Сценарій на перевірці');
      expect(admin.isAuthenticated()).toBe(true);
    });

    it('me(code) with an explicit code never ends a session: it is a sign-in attempt', async () => {
      const pending = api.me('wrong').then(() => null, err => err);
      const req = http.expectOne('/api/auth/me');
      expect(req.request.headers.get('Authorization')).toBe('Bearer wrong');
      req.flush({ error: 'Невірний токен' }, { status: 403, statusText: 'Forbidden' });
      expect(await pending).toBeInstanceOf(HttpErrorResponse);
      expect(admin.isAuthenticated()).toBe(true);
      expect(admin.endedReason()).toBeNull();
    });
  });

  describe('isCredentialRejection', () => {
    const response = (status: number, error: unknown) => new HttpErrorResponse({ status, error });

    it('is true for 401 and the unknown-code 403 only', () => {
      expect(isCredentialRejection(response(401, null))).toBe(true);
      expect(isCredentialRejection(response(403, { error: 'Невірний токен' }))).toBe(true);
      expect(isCredentialRejection(response(403, { error: 'Недостатньо прав' }))).toBe(false);
      expect(isCredentialRejection(response(403, null))).toBe(false);
      expect(isCredentialRejection(response(429, { error: 'Забагато' }))).toBe(false);
      expect(isCredentialRejection(new Error('network'))).toBe(false);
    });
  });

  describe('archive uploads (DW-6.1, DW-6.3)', () => {
    const answer = { id: 'a', sha256: 's', bytes: 1, url: '/x', deduplicated: false, manifestId: 'a', warnings: [] };

    it('uploadArchive posts the archive under "archive" with the bearer and reports progress', async () => {
      const seen: number[] = [];
      const pending = api.uploadArchive('a b', new File(['x'], 'a.zip'), p => seen.push(p));
      const req = http.expectOne('/api/scenarios/a%20b/archive');
      expect(req.request.method).toBe('POST');
      expect(req.request.reportProgress).toBe(true);
      expect(req.request.headers.get('Authorization')).toBe('Bearer session-code');
      expect((req.request.body as FormData).get('archive')).toBeInstanceOf(File);

      req.event({ type: 1, loaded: 25, total: 100 } as never);
      req.event({ type: 1, loaded: 100, total: 100 } as never);
      req.flush(answer);
      expect((await pending).sha256).toBe('s');
      expect(seen).toEqual([25, 100]);
    });

    it('fromArchive sends the archive and, only when given, the category', async () => {
      const withCategory = api.fromArchive(new File(['x'], 'a.zip'), () => undefined, undefined, 'biology');
      const req = http.expectOne('/api/scenarios/from-archive');
      const form = req.request.body as FormData;
      expect(form.get('category')).toBe('biology');
      expect(form.get('archive')).toBeInstanceOf(File);
      req.flush({ scenario: adminRow('a'), version: {}, manifest: {}, warnings: [] });
      expect((await withCategory).scenario.id).toBe('a');

      const without = api.fromArchive(new File(['x'], 'a.zip'), () => undefined);
      const bare = http.expectOne('/api/scenarios/from-archive');
      expect((bare.request.body as FormData).has('category')).toBe(false);
      bare.flush({});
      await without;
    });

    it('aborting the signal cancels the request and rejects with UploadCancelled', async () => {
      const controller = new AbortController();
      const pending = api.uploadArchive('a', new File(['x'], 'a.zip'), () => undefined, controller.signal);
      const req = http.expectOne('/api/scenarios/a/archive');

      controller.abort();
      await expect(pending).rejects.toBeInstanceOf(UploadCancelled);
      expect(req.cancelled).toBe(true);
    });

    it('an already-aborted signal sends nothing that survives and rejects at once', async () => {
      const controller = new AbortController();
      controller.abort();
      const pending = api.fromArchive(new File(['x'], 'a.zip'), () => undefined, controller.signal);
      await expect(pending).rejects.toBeInstanceOf(UploadCancelled);
      http.match('/api/scenarios/from-archive').forEach(req => expect(req.cancelled).toBe(true));
    });

    it('a server refusal reaches the caller untouched, and a rejected code still ends the session', async () => {
      const refused = api.uploadArchive('a', new File(['x'], 'a.zip'), () => undefined).then(() => null, (err: HttpErrorResponse) => err);
      http.expectOne('/api/scenarios/a/archive').flush({ error: 'Архів завеликий' }, { status: 413, statusText: 'Too Large' });
      expect((await refused)?.status).toBe(413);
      expect(admin.isAuthenticated()).toBe(true);

      const revoked = api.uploadArchive('a', new File(['x'], 'a.zip'), () => undefined).catch(err => err);
      http.expectOne('/api/scenarios/a/archive').flush({ error: 'Невірний токен' }, { status: 403, statusText: 'Forbidden' });
      await revoked;
      expect(admin.isAuthenticated()).toBe(false);
    });

    it('a progress report never exceeds 100', async () => {
      const seen: number[] = [];
      const pending = api.uploadArchive('a', new File(['x'], 'a.zip'), p => seen.push(p));
      const req = http.expectOne('/api/scenarios/a/archive');
      req.event({ type: 1, loaded: 150, total: 100 } as never);
      req.flush(answer);
      await pending;
      expect(seen).toEqual([100]);
    });
  });
});
