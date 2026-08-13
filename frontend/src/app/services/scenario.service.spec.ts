// path: src/app/services/scenario.service.spec.ts
//
// Covers test-plan scenarios 6, 12, 13, 14 (catalog state) and 35
// (download URL resolution), plus the download/abort path (F4).

import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { ScenarioService } from './scenario.service';
import { ScenarioCatalogItem, ScenarioCatalogManifest } from '../models/scenario.model';

function scenario(id: string, overrides: Partial<ScenarioCatalogItem> = {}): ScenarioCatalogItem {
  return {
    id,
    title: `Title ${id}`,
    description: '',
    fullDescription: '',
    category: 'astronomy',
    categoryLabel: 'Астрономія',
    imageUrl: '',
    scenarioUrl: `/scenarios/${id}.zip`,
    ...overrides,
  };
}

function manifest(overrides: Partial<ScenarioCatalogManifest> = {}): ScenarioCatalogManifest {
  return {
    version: '1',
    scenarios: [scenario('a'), scenario('b')],
    categories: [{ category: 'astronomy', categoryLabel: 'Астрономія' }],
    total: 5,
    limit: 24,
    offset: 0,
    ...overrides,
  };
}

describe('ScenarioService', () => {
  let service: ScenarioService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(ScenarioService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  describe('loadCatalog', () => {
    it('requests the first page and stores the result', async () => {
      const pending = service.loadCatalog();

      const req = http.expectOne(r => r.url === '/api/catalog');
      expect(req.request.params.get('offset')).toBe('0');
      expect(req.request.params.get('limit')).toBe('24');
      req.flush(manifest());

      await pending;
      expect(service.scenarios().map(s => s.id)).toEqual(['a', 'b']);
      expect(service.total()).toBe(5);
      expect(service.loading()).toBe(false);
      expect(service.error()).toBeNull();
    });

    it('sends category and query only when set', async () => {
      const pending = service.loadCatalog('biology', '  клітина  ');

      const req = http.expectOne(r => r.url === '/api/catalog');
      expect(req.request.params.get('category')).toBe('biology');
      expect(req.request.params.get('q')).toBe('клітина');
      req.flush(manifest());
      await pending;
    });

    it('omits the category when it is "all"', async () => {
      const pending = service.loadCatalog('all', '');

      const req = http.expectOne(r => r.url === '/api/catalog');
      expect(req.request.params.has('category')).toBe(false);
      expect(req.request.params.has('q')).toBe(false);
      req.flush(manifest());
      await pending;
    });

    it('replaces the held page rather than appending', async () => {
      let pending = service.loadCatalog();
      http.expectOne(r => r.url === '/api/catalog').flush(manifest());
      await pending;

      pending = service.loadCatalog();
      http.expectOne(r => r.url === '/api/catalog').flush(
        manifest({ scenarios: [scenario('c')], total: 1 })
      );
      await pending;

      expect(service.scenarios().map(s => s.id)).toEqual(['c']);
      expect(service.total()).toBe(1);
    });

    it('clears the list and reports the error when the first page fails', async () => {
      const pending = service.loadCatalog();
      http.expectOne(r => r.url === '/api/catalog')
        .flush('boom', { status: 500, statusText: 'Server Error' });
      await pending;

      expect(service.scenarios()).toEqual([]);
      expect(service.total()).toBe(0);
      expect(service.error()).not.toBeNull();
    });
  });

  describe('loadMore', () => {
    async function loadFirstPage(total = 5) {
      const pending = service.loadCatalog();
      http.expectOne(r => r.url === '/api/catalog').flush(manifest({ total }));
      await pending;
    }

    it('appends the next page and offsets by what is held', async () => {
      await loadFirstPage();

      const pending = service.loadMore();
      const req = http.expectOne(r => r.url === '/api/catalog');
      expect(req.request.params.get('offset')).toBe('2');
      req.flush(manifest({ scenarios: [scenario('c')], offset: 2 }));
      await pending;

      expect(service.scenarios().map(s => s.id)).toEqual(['a', 'b', 'c']);
    });

    it('keeps the loaded page when an append fails', async () => {
      await loadFirstPage();

      const pending = service.loadMore();
      http.expectOne(r => r.url === '/api/catalog')
        .flush('boom', { status: 500, statusText: 'Server Error' });
      await pending;

      expect(service.scenarios().map(s => s.id)).toEqual(['a', 'b']);
      expect(service.error()).not.toBeNull();
    });

    it('does nothing once everything is loaded', async () => {
      await loadFirstPage(2);
      expect(service.hasMore()).toBe(false);

      await service.loadMore();
      http.expectNone(r => r.url === '/api/catalog');
    });
  });

  describe('hasMore', () => {
    it('is true while fewer rows are held than the total', async () => {
      const pending = service.loadCatalog();
      http.expectOne(r => r.url === '/api/catalog').flush(manifest({ total: 5 }));
      await pending;
      expect(service.hasMore()).toBe(true);
    });

    it('is false when the held count reaches the total', async () => {
      const pending = service.loadCatalog();
      http.expectOne(r => r.url === '/api/catalog').flush(manifest({ total: 2 }));
      await pending;
      expect(service.hasMore()).toBe(false);
    });
  });

  describe('categories', () => {
    it('always prepends the "all" entry', () => {
      expect(service.categories()[0].id).toBe('all');
    });

    it('maps API categories and keeps known icons', async () => {
      const pending = service.loadCatalog();
      http.expectOne(r => r.url === '/api/catalog').flush(manifest({
        categories: [
          { category: 'physics', categoryLabel: 'Фізика' },
          { category: 'astronomy', categoryLabel: 'Астрономія' },
        ],
      }));
      await pending;

      const ids = service.categories().map(c => c.id);
      expect(ids).toEqual(['all', 'physics', 'astronomy']);
      expect(service.categories()[1].icon).toBe('⚡');
    });

    it('falls back to a default icon for an unknown category', async () => {
      const pending = service.loadCatalog();
      http.expectOne(r => r.url === '/api/catalog').flush(manifest({
        categories: [{ category: 'quantum-basketry', categoryLabel: 'Дивна' }],
      }));
      await pending;

      // Without a default this rendered as `undefined` in the chip bar.
      expect(service.categories()[1].icon).toBe('📁');
    });
  });

  describe('fetchScenarioById', () => {
    it('URL-encodes the id', async () => {
      const pending = service.fetchScenarioById('with space & pct%');
      const req = http.expectOne(r => r.url.startsWith('/api/catalog/'));
      expect(req.request.url).toBe('/api/catalog/with%20space%20%26%20pct%25');
      req.flush(scenario('with space & pct%'));
      await pending;
    });
  });

  describe('downloadScenarioZip', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    /** Minimal streamed Response stand-in. */
    function stubFetch(chunks: Uint8Array[], contentLength?: number) {
      const captured: { url?: string; signal?: AbortSignal } = {};

      globalThis.fetch = ((url: string, init?: RequestInit) => {
        captured.url = url;
        captured.signal = init?.signal ?? undefined;

        let index = 0;
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {
            get: (name: string) =>
              name.toLowerCase() === 'content-length' && contentLength !== undefined
                ? String(contentLength)
                : null,
          },
          body: {
            getReader: () => ({
              read: () =>
                Promise.resolve(
                  index < chunks.length
                    ? { done: false, value: chunks[index++] }
                    : { done: true, value: undefined }
                ),
              cancel: () => Promise.resolve(),
            }),
          },
        } as unknown as Response);
      }) as typeof fetch;

      return captured;
    }

    it('fetches a local archive directly', async () => {
      const captured = stubFetch([new Uint8Array([1, 2, 3])], 3);

      await service.downloadScenarioZip(scenario('a', { scenarioUrl: '/scenarios/abc.zip' }));

      expect(captured.url).toBe('/scenarios/abc.zip');
    });

    it('does not route anything through a proxy any more', async () => {
      const captured = stubFetch([new Uint8Array([1])], 1);

      await service.downloadScenarioZip(
        scenario('drive one', { scenarioUrl: 'https://drive.google.com/file/d/X/view' })
      );

      // The proxy that used to relay off-origin archives is deleted along with
      // the last row that needed it. An off-origin URL is now a misconfigured
      // row: it fails the fetch visibly instead of being quietly relayed.
      expect(captured.url).not.toContain('/api/proxy-download');
      expect(captured.url).toBe('https://drive.google.com/file/d/X/view');
    });

    it('reports progress with a real percentage when Content-Length is known', async () => {
      stubFetch([new Uint8Array([1, 2]), new Uint8Array([3, 4])], 4);

      const seen: number[] = [];
      await service.downloadScenarioZip(scenario('a'), p => seen.push(p.percent));

      expect(seen).toEqual([50, 100]);
    });

    it('reports -1 when the length is unknown', async () => {
      stubFetch([new Uint8Array([1, 2])]);

      const seen: number[] = [];
      await service.downloadScenarioZip(scenario('a'), p => seen.push(p.percent));

      expect(seen).toEqual([-1]);
    });

    it('concatenates chunks into the full buffer', async () => {
      stubFetch([new Uint8Array([1, 2]), new Uint8Array([3])], 3);

      const buffer = await service.downloadScenarioZip(scenario('a'));

      expect(Array.from(new Uint8Array(buffer))).toEqual([1, 2, 3]);
    });

    it('aborts mid-stream when the signal is already aborted', async () => {
      stubFetch([new Uint8Array([1]), new Uint8Array([2])], 2);

      const controller = new AbortController();
      controller.abort();

      await expect(
        service.downloadScenarioZip(scenario('a'), undefined, controller.signal)
      ).rejects.toThrow();
    });

    it('passes the signal to fetch', async () => {
      const captured = stubFetch([new Uint8Array([1])], 1);
      const controller = new AbortController();

      await service.downloadScenarioZip(scenario('a'), undefined, controller.signal);

      expect(captured.signal).toBe(controller.signal);
    });
  });
});
