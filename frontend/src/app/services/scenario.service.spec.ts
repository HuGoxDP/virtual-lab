// path: src/app/services/scenario.service.spec.ts
//
// Covers test-plan scenarios 6, 12, 13, 14 (catalog state) and 35
// (download URL resolution), plus the download/abort path (F4), and - release 1, phase 3 -
// 121 (sort / summary / category mapping, DW-3.1, DW-3.2) and 122 (out-of-order responses, DW-3.2).

import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { ScenarioService } from './scenario.service';
import { AdminService } from './admin.service';
import { CatalogCategory, ScenarioCatalogItem, ScenarioCatalogManifest } from '../models/scenario.model';
import { CatalogFilter, DEFAULT_CATALOG_FILTER } from './catalog-query';

const filter = (change: Partial<CatalogFilter> = {}): CatalogFilter => ({ ...DEFAULT_CATALOG_FILTER, ...change });
const category = (slug: string, count = 1, icon = 'folder'): CatalogCategory =>
  ({ category: slug, categoryLabel: slug.toUpperCase(), icon, count });

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
    archiveBytes: null,
    updatedAt: '2026-10-01T00:00:00.000Z',
    features: [],
    ...overrides,
  };
}

function manifest(overrides: Partial<ScenarioCatalogManifest> = {}): ScenarioCatalogManifest {
  return {
    version: '1',
    scenarios: [scenario('a'), scenario('b')],
    categories: [category('astronomy')],
    summary: { scenarios: 5, categories: 1 },
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
      const pending = service.loadCatalog(filter({ category: 'biology', q: '  клітина  ' }));

      const req = http.expectOne(r => r.url === '/api/catalog');
      expect(req.request.params.get('category')).toBe('biology');
      expect(req.request.params.get('q')).toBe('клітина');
      req.flush(manifest());
      await pending;
    });

    it('omits the category when it is "all"', async () => {
      const pending = service.loadCatalog(filter());

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
    it('DW-3.1 always prepends "Усі напрями" with the whole-catalog count', async () => {
      const pending = service.loadCatalog();
      http.expectOne(r => r.url === '/api/catalog').flush(manifest({ summary: { scenarios: 7, categories: 1 } }));
      await pending;

      expect(service.categories()[0]).toEqual({ id: 'all', label: 'Усі напрями', icon: 'list-dashes', count: 7 });
    });

    it('DW-3.1 maps the API categories with icon and count, keeping the API order', async () => {
      const pending = service.loadCatalog();
      http.expectOne(r => r.url === '/api/catalog').flush(manifest({
        categories: [category('physics', 4, 'lightning'), category('astronomy', 2, 'planet')],
      }));
      await pending;

      expect(service.categories().map(c => [c.id, c.icon, c.count])).toEqual([
        ['all', 'list-dashes', 5], ['physics', 'lightning', 4], ['astronomy', 'planet', 2],
      ]);
    });

    it('has only the "all" chip (count 0) before anything is loaded', () => {
      expect(service.categories()).toEqual([{ id: 'all', label: 'Усі напрями', icon: 'list-dashes', count: 0 }]);
      expect(service.summary()).toBeNull();
    });

    it('keeps the chips and the summary when a later request fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      let pending = service.loadCatalog();
      http.expectOne(r => r.url === '/api/catalog').flush(manifest());
      await pending;

      pending = service.loadCatalog(filter({ category: 'astronomy' }));
      http.expectOne(r => r.url === '/api/catalog').flush('x', { status: 500, statusText: 'Server Error' });
      await pending;

      expect(service.categories().length).toBe(2);
      expect(service.summary()).toEqual({ scenarios: 5, categories: 1 });
    });
  });

  describe('sort and filter memory', () => {
    it('DW-3.1 sends sort=title only for the non-default order', async () => {
      let pending = service.loadCatalog(filter({ sort: 'title' }));
      let req = http.expectOne(r => r.url === '/api/catalog');
      expect(req.request.params.get('sort')).toBe('title');
      req.flush(manifest());
      await pending;

      pending = service.loadCatalog(filter({ sort: 'new' }));
      req = http.expectOne(r => r.url === '/api/catalog');
      expect(req.request.params.has('sort')).toBe(false);
      req.flush(manifest());
      await pending;
    });

    it('DW-3.2 load more keeps category, query and sort', async () => {
      const active = filter({ category: 'astronomy', q: 'сонце', sort: 'title' });
      let pending = service.loadCatalog(active);
      http.expectOne(r => r.url === '/api/catalog').flush(manifest());
      await pending;

      pending = service.loadMore(active);
      const req = http.expectOne(r => r.url === '/api/catalog');
      expect(req.request.params.get('offset')).toBe('2');
      expect(req.request.params.get('category')).toBe('astronomy');
      expect(req.request.params.get('q')).toBe('сонце');
      expect(req.request.params.get('sort')).toBe('title');
      req.flush(manifest({ scenarios: [scenario('c')] }));
      await pending;
    });

    it('remembers the filter of the latest request', async () => {
      const active = filter({ category: 'physics' });
      const pending = service.loadCatalog(active);
      expect(service.filter()).toEqual(active);
      http.expectOne(r => r.url === '/api/catalog').flush(manifest());
      await pending;
    });

    it('is not "loaded" until a request finishes, and is after a failure too', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(service.loaded()).toBe(false);
      const pending = service.loadCatalog();
      expect(service.loaded()).toBe(false);
      http.expectOne(r => r.url === '/api/catalog').flush('x', { status: 500, statusText: 'Server Error' });
      await pending;
      expect(service.loaded()).toBe(true);
    });
  });

  describe('out-of-order responses', () => {
    it('DW-3.2 a slow answer for an older filter never overwrites the newest one', async () => {
      const older = service.loadCatalog(filter({ category: 'physics' }));
      const newer = service.loadCatalog(filter({ category: 'biology' }));
      const [oldReq, newReq] = http.match(r => r.url === '/api/catalog');
      expect(oldReq.request.params.get('category')).toBe('physics');

      newReq.flush(manifest({ scenarios: [scenario('bio')], total: 1 }));
      await newer;
      oldReq.flush(manifest({ scenarios: [scenario('phys')], total: 1 }));
      await older;

      expect(service.scenarios().map(s => s.id)).toEqual(['bio']);
      expect(service.loading()).toBe(false);
    });

    it('DW-3.2 a late failure of an older request does not show an error over the newer list', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const older = service.loadCatalog(filter({ q: 'a' }));
      const newer = service.loadCatalog(filter({ q: 'ab' }));
      const [oldReq, newReq] = http.match(r => r.url === '/api/catalog');

      newReq.flush(manifest({ scenarios: [scenario('ok')], total: 1 }));
      await newer;
      oldReq.flush('x', { status: 500, statusText: 'Server Error' });
      await older;

      expect(service.error()).toBeNull();
      expect(service.scenarios().map(s => s.id)).toEqual(['ok']);
    });

    it('an older answer arriving first does not end loading while the newer request is in flight', async () => {
      const older = service.loadCatalog(filter({ category: 'physics' }));
      const newer = service.loadCatalog(filter({ category: 'biology' }));
      const [oldReq, newReq] = http.match(r => r.url === '/api/catalog');

      oldReq.flush(manifest({ scenarios: [scenario('phys')] }));
      await older;
      expect(service.loading()).toBe(true);
      expect(service.scenarios()).toEqual([]);

      newReq.flush(manifest({ scenarios: [scenario('bio')] }));
      await newer;
      expect(service.loading()).toBe(false);
      expect(service.scenarios().map(s => s.id)).toEqual(['bio']);
    });

    it('a page being appended is dropped when a new filter starts meanwhile', async () => {
      const first = service.loadCatalog();
      http.expectOne(r => r.url === '/api/catalog').flush(manifest());
      await first;

      const append = service.loadMore();
      const replace = service.loadCatalog(filter({ category: 'biology' }));
      const [appendReq, replaceReq] = http.match(r => r.url === '/api/catalog');

      replaceReq.flush(manifest({ scenarios: [scenario('bio')], total: 1 }));
      await replace;
      appendReq.flush(manifest({ scenarios: [scenario('late')], offset: 2 }));
      await append;

      expect(service.scenarios().map(s => s.id)).toEqual(['bio']);
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

    it('DW-3.4 encodes a slash and Cyrillic in the id', async () => {
      const pending = service.fetchScenarioById('a/б');
      const req = http.expectOne(r => r.url.startsWith('/api/catalog/'));
      expect(req.request.url).toBe('/api/catalog/a%2F%D0%B1');
      req.flush(scenario('a/б'));
      await pending;
    });

    it('DW-3.4 returns related and features as arrays even when the answer omits them', async () => {
      const pending = service.fetchScenarioById('x');
      const bare: Partial<ScenarioCatalogItem> = scenario('x');
      delete bare.features;
      http.expectOne('/api/catalog/x').flush(bare);

      const detail = await pending;
      expect(detail.related).toEqual([]);
      expect(detail.features).toEqual([]);
    });

    it('DW-3.4 keeps the related scenarios the API sent', async () => {
      const pending = service.fetchScenarioById('x');
      const related = [{ id: 'y', title: 'Y', category: 'physics', categoryLabel: 'Фізика', imageUrl: '' }];
      http.expectOne('/api/catalog/x').flush({ ...scenario('x'), related });
      expect((await pending).related).toEqual(related);
    });

    describe('a draft preview (version) - DW-3.5', () => {
      const HASH = 'cd'.repeat(32);
      afterEach(() => sessionStorage.removeItem('adminToken'));

      it('adds ?version= and sends the session bearer', async () => {
        TestBed.inject(AdminService).setToken('session-key');
        const pending = service.fetchScenarioById('x', HASH);
        const req = http.expectOne(r => r.url === '/api/catalog/x');
        expect(req.request.params.get('version')).toBe(HASH);
        expect(req.request.headers.get('Authorization')).toBe('Bearer session-key');
        req.flush(scenario('x'));
        await pending;
      });

      it('sends no Authorization when nobody is signed in (a published scenario versions are public)', async () => {
        TestBed.inject(AdminService).clearToken();
        const pending = service.fetchScenarioById('x', HASH);
        const req = http.expectOne(r => r.url === '/api/catalog/x');
        expect(req.request.params.get('version')).toBe(HASH);
        expect(req.request.headers.has('Authorization')).toBe(false);
        req.flush(scenario('x'));
        await pending;
      });

      it('the plain lookup stays public: no version, no credential, even when signed in', async () => {
        TestBed.inject(AdminService).setToken('session-key');
        const pending = service.fetchScenarioById('x');
        const req = http.expectOne('/api/catalog/x');
        expect(req.request.params.has('version')).toBe(false);
        expect(req.request.headers.has('Authorization')).toBe(false);
        req.flush(scenario('x'));
        await pending;
      });
    });

    it('rejects with the HTTP error so a caller can tell 404 from 500', async () => {
      const pending = service.fetchScenarioById('nope');
      http.expectOne('/api/catalog/nope').flush({ error: 'x' }, { status: 404, statusText: 'Not Found' });
      await expect(pending).rejects.toMatchObject({ status: 404 });
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
