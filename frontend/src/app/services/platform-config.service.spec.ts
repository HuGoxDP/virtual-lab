// path: src/app/services/platform-config.service.spec.ts
//
// Covers test-plan scenario 123 (release 1, phase 3 - DW-3.1): the footer's archive limit comes from
// GET /api/config; a failure or a malformed answer leaves it unset.

import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { PlatformConfigService } from './platform-config.service';

describe('PlatformConfigService', () => {
  let service: PlatformConfigService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(PlatformConfigService);
    http = TestBed.inject(HttpTestingController);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => http.verify());

  it('DW-3.1 stores the limit from /api/config', async () => {
    const pending = service.load();
    http.expectOne('/api/config').flush({ maxArchiveBytes: 209715200 });
    await pending;
    expect(service.maxArchiveBytes()).toBe(209715200);
  });

  it('is unset before the answer arrives', () => {
    expect(service.maxArchiveBytes()).toBeNull();
  });

  it('asks once: concurrent and later calls share the request', async () => {
    const first = service.load();
    const second = service.load();
    http.expectOne('/api/config').flush({ maxArchiveBytes: 1 });
    await Promise.all([first, second]);
    await service.load();
    http.expectNone('/api/config');
  });

  it('a failed request leaves the limit unset and may be retried', async () => {
    const failed = service.load();
    http.expectOne('/api/config').flush('x', { status: 500, statusText: 'Server Error' });
    await failed;
    expect(service.maxArchiveBytes()).toBeNull();

    const retry = service.load();
    http.expectOne('/api/config').flush({ maxArchiveBytes: 5 });
    await retry;
    expect(service.maxArchiveBytes()).toBe(5);
  });

  it.each([[undefined], [null], ['200'], [0], [-5], [Infinity]])('a malformed limit (%s) is not stored', async bad => {
    const pending = service.load();
    http.expectOne('/api/config').flush({ maxArchiveBytes: bad });
    await pending;
    expect(service.maxArchiveBytes()).toBeNull();
  });
});
