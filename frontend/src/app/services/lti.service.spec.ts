// path: src/app/services/lti.service.spec.ts
//
// LtiService: the session read and the submit call, and how failures become LtiRequestError. DW-6.1.

import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { LtiRequestError, LtiService } from './lti.service';

const SESSION = { scenarioId: 'electric-circuits', role: 'learner', messageType: 'resource', graded: true, submitted: null };

describe('LtiService', () => {
  let service: LtiService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(LtiService);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('getSession reads GET /api/lti/session', async () => {
    const result = service.getSession();
    const req = http.expectOne('/api/lti/session');
    expect(req.request.method).toBe('GET');
    req.flush(SESSION);
    expect(await result).toEqual(SESSION);
  });

  it('submit with a score posts it as JSON', async () => {
    const result = service.submit(0.85);
    const req = http.expectOne('/api/lti/submit');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ score: 0.85 });
    req.flush({ score: 0.85 });
    expect(await result).toEqual({ score: 0.85 });
  });

  it('submit without a score still posts a JSON body (the endpoint requires JSON)', async () => {
    const result = service.submit();
    const req = http.expectOne('/api/lti/submit');
    expect(req.request.body).toEqual({});
    req.flush({ score: 1 });
    expect(await result).toEqual({ score: 1 });
  });

  it('a 409 carries the server message, status and the grade already held', async () => {
    const result = service.submit(0.1);
    http.expectOne('/api/lti/submit').flush({ error: 'Роботу вже здано', score: 0.85 }, { status: 409, statusText: 'Conflict' });
    const err = await result.catch(e => e);
    expect(err).toBeInstanceOf(LtiRequestError);
    expect(err).toMatchObject({ message: 'Роботу вже здано', status: 409, score: 0.85 });
  });

  it('a 401 keeps its status', async () => {
    const result = service.getSession();
    http.expectOne('/api/lti/session').flush({ error: 'Немає сесії' }, { status: 401, statusText: 'Unauthorized' });
    expect(await result.catch(e => e)).toMatchObject({ status: 401, message: 'Немає сесії' });
  });

  it('an error body without a message falls back to a generic Ukrainian one', async () => {
    const result = service.submit();
    http.expectOne('/api/lti/submit').flush('<html>', { status: 502, statusText: 'Bad Gateway' });
    const err = await result.catch(e => e);
    expect(err.status).toBe(502);
    expect(err.message).toBe('Не вдалося виконати запит. Спробуйте ще раз.');
    expect(err.score).toBeUndefined();
  });

  it('no answer at all (status 0) is reported as a connection problem', async () => {
    const result = service.submit();
    http.expectOne('/api/lti/submit').error(new ProgressEvent('error'));
    const err = await result.catch(e => e);
    expect(err.status).toBe(0);
    expect(err.message).toContain('Немає зв');
  });
});
