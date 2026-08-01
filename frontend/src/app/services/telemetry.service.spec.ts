// path: src/app/services/telemetry.service.spec.ts
//
// Covers test-plan scenarios 62, 63 and the client half of 55–57.

import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { TelemetryService } from './telemetry.service';

describe('TelemetryService', () => {
  let service: TelemetryService;
  let http: HttpTestingController;
  let beacons: string[];

  beforeEach(() => {
    localStorage.clear();
    beacons = [];

    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      writable: true,
      value: (url: string) => {
        beacons.push(url);
        return true;
      },
    });

    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(TelemetryService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function start(scenarioId = 'solar-system', sessionId = '42') {
    const pending = service.startSession(scenarioId);
    http.expectOne('/api/telemetry/session').flush({ sessionId });
    await pending;
  }

  describe('client id', () => {
    it('generates one and persists it', async () => {
      const pending = service.startSession('solar-system');
      const req = http.expectOne('/api/telemetry/session');

      const sent = req.request.body.clientId as string;
      expect(sent).toMatch(/^[0-9a-f-]{36}$/i);
      expect(localStorage.getItem('vlClientId')).toBe(sent);

      req.flush({ sessionId: '1' });
      await pending;
    });

    it('reuses the stored id across sessions', async () => {
      await start();
      const first = localStorage.getItem('vlClientId');

      service.endSession();
      const pending = service.startSession('solar-system');
      const req = http.expectOne('/api/telemetry/session');
      expect(req.request.body.clientId).toBe(first);
      req.flush({ sessionId: '2' });
      await pending;
    });
  });

  describe('startSession', () => {
    it('posts the scenario id', async () => {
      const pending = service.startSession('cell-biology');
      const req = http.expectOne('/api/telemetry/session');
      expect(req.request.body.scenarioId).toBe('cell-biology');
      req.flush({ sessionId: '7' });
      await pending;
    });

    it('closes a previous session before opening a new one', async () => {
      await start('solar-system', '10');

      const pending = service.startSession('cell-biology');
      expect(beacons).toEqual(['/api/telemetry/session/10/end']);

      http.expectOne('/api/telemetry/session').flush({ sessionId: '11' });
      await pending;
    });

    it('never throws when the API fails', async () => {
      const pending = service.startSession('solar-system');
      http.expectOne('/api/telemetry/session')
        .flush('nope', { status: 500, statusText: 'Server Error' });

      // Telemetry must not be able to break playback.
      await expect(pending).resolves.toBeUndefined();
    });

    it('sends no end call when the start failed', async () => {
      const pending = service.startSession('solar-system');
      http.expectOne('/api/telemetry/session')
        .flush('nope', { status: 500, statusText: 'Server Error' });
      await pending;

      service.endSession();
      expect(beacons).toEqual([]);
    });
  });

  describe('endSession', () => {
    it('beacons the end call once', async () => {
      await start('solar-system', '99');

      service.endSession();
      expect(beacons).toEqual(['/api/telemetry/session/99/end']);
    });

    it('is a no-op when called twice', async () => {
      await start('solar-system', '99');

      service.endSession();
      service.endSession();

      // The server end call is idempotent too, but the client should not
      // even attempt a second one.
      expect(beacons.length).toBe(1);
    });

    it('is a no-op with no session open', () => {
      service.endSession();
      expect(beacons).toEqual([]);
    });

    it('URL-encodes the session id', async () => {
      await start('solar-system', 'a/b');
      service.endSession();
      expect(beacons).toEqual(['/api/telemetry/session/a%2Fb/end']);
    });

    it('swallows a sendBeacon failure', async () => {
      await start('solar-system', '5');

      Object.defineProperty(navigator, 'sendBeacon', {
        configurable: true,
        writable: true,
        value: () => { throw new Error('blocked'); },
      });

      expect(() => service.endSession()).not.toThrow();
    });
  });
});
