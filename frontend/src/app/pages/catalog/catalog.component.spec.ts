// path: src/app/pages/catalog/catalog.component.spec.ts
//
// Release 1, phase 3. Covers test-plan scenarios 75, 76 (debounce, category resets paging),
// 124 (header, chips, "Знайдено N", footer - DW-3.1; no hero, copyright-only footer - DW-5.1), 125 (sort, URL <-> filters, back, load more
// - DW-3.1, DW-3.2), 126 (empty state, error state - DW-3.3), 127 (no modal, no theme, card and
// launch targets - DW-3.6).
//
// Timers: vitest fake timers, never `fakeAsync()` (this app is zoneless).

import { TestBed } from '@angular/core/testing';
import { Location } from '@angular/common';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';

import { CatalogComponent } from './catalog.component';
import { CatalogCategory, ScenarioCatalogItem } from '../../models/scenario.model';
import { AdminService } from '../../services/admin.service';
import { SITE } from '../../site.config';

function scenario(id: string, overrides: Partial<ScenarioCatalogItem> = {}): ScenarioCatalogItem {
  return {
    id,
    title: `Title ${id}`,
    description: 'desc',
    fullDescription: 'full',
    category: 'astronomy',
    categoryLabel: 'Астрономія',
    imageUrl: '',
    scenarioUrl: `/scenarios/${id}.zip`,
    archiveBytes: 1048576,
    updatedAt: '2026-10-01T00:00:00.000Z',
    features: [],
    ...overrides,
  };
}

const CATEGORIES: CatalogCategory[] = [
  { category: 'physics', categoryLabel: 'Фізика', icon: 'lightning', count: 4 },
  { category: 'astronomy', categoryLabel: 'Астрономія', icon: 'planet', count: 2 },
];

const payload = (overrides: Record<string, unknown> = {}) => ({
  version: '1',
  scenarios: [scenario('a'), scenario('b')],
  categories: CATEGORIES,
  summary: { scenarios: 6, categories: 2 },
  total: 4,
  limit: 24,
  offset: 0,
  ...overrides,
});

describe('CatalogComponent', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;
  let root: HTMLElement;

  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'catalog', component: CatalogComponent },
          { path: 'scenario/:id', children: [] },
          { path: 'play/:id', children: [] },
          { path: 'admin', children: [] },
        ]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => {
    vi.useRealTimers();
    http.verify();
  });

  const catalogRequests = (): TestRequest[] => http.match(r => r.url === '/api/catalog');

  async function settle(): Promise<void> {
    for (let i = 0; i < 4; i++) await Promise.resolve();
    harness.detectChanges();
    await harness.fixture.whenStable();
    harness.detectChanges();
  }

  /** Opens `/catalog...` and returns the catalog request for the caller to answer. */
  async function open(url = '/catalog'): Promise<TestRequest> {
    await harness.navigateByUrl(url, CatalogComponent);
    root = harness.routeNativeElement as HTMLElement;
    return http.expectOne(r => r.url === '/api/catalog');
  }

  async function openAndAnswer(url = '/catalog', body = payload()): Promise<void> {
    (await open(url)).flush(body);
    await settle();
  }

  const q = <T extends HTMLElement>(selector: string): T => root.querySelector<T>(selector) as T;
  const qa = (selector: string): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(selector)];
  const url = () => TestBed.inject(Location).path();

  // ==================== DW-3.1 ====================

  describe('page content (DW-3.1)', () => {
    beforeEach(async () => openAndAnswer());

    it('DW-5.1 no hero: no section, title, lead or counters', () => {
      expect(q('.hero')).toBeNull();
      expect(q('.hero-title')).toBeNull();
      expect(q('.fact')).toBeNull();
      expect(q('main.catalog-main')).not.toBeNull();
    });

    it('DW-3.7 the main column is as wide as its parent, not as wide as the chip row (390 px must not scroll sideways)', () => {
      // With `margin: 0 auto` in a column flex host the item loses its stretch and shrink-wraps to the chip row.
      const style = getComputedStyle(q('main.catalog-main')!);
      expect(style.width).toBe('100%');
      expect(style.marginLeft).toBe('auto');
      expect(getComputedStyle(q('.chips')!).overflowX).toBe('auto');
    });

    it('DW-3.1 chips: icon, label and count in API order, "Усі напрями" first with the whole count', () => {
      const chips = qa('.chip').map(c => c.textContent!.replace(/\s+/g, ' ').trim());
      expect(chips).toEqual(['Усі напрями6', 'Фізика4', 'Астрономія2']);
      expect(qa('.chip vl-icon').length).toBe(3);
    });

    it('DW-3.1 "Знайдено N" uses the Ukrainian plural of the total', async () => {
      expect(q('.found').textContent!.trim()).toBe('Знайдено 4 сценарії');
    });

    it('DW-3.1 one grid card per scenario', () => {
      expect(qa('vl-scenario-card').length).toBe(2);
    });

    it('DW-5.1 the footer is the copyright bar only: no .footer-inner, no admin link, no ZIP note', () => {
      expect(q('.footer-inner')).toBeNull();
      expect(q('.footer-legal').textContent!.trim()).toBe(SITE.copyright);
      expect(q('footer a[href="/admin"]')).toBeNull();
      expect(q('.archive-requirement')).toBeNull();
    });

    it('DW-3.1 the header button reads "Увійти" without an admin token', () => {
      expect(q('.account').textContent!.trim()).toBe('Увійти');
    });

    it('DW-3.1 the active chip is aria-pressed, the others are not', () => {
      expect(qa('.chip').map(c => c.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    });

    it('DW-3.1 the sort segment shows "Нові" selected by default', () => {
      const radios = qa('input[name="vl-sort"]') as HTMLInputElement[];
      expect(radios.map(r => r.checked)).toEqual([true, false]);
    });
  });

  it('DW-3.1 the header button reads "Панель" while an admin token is in the session', async () => {
    TestBed.inject(AdminService).setToken('secret');
    await openAndAnswer();
    expect(q('.account').textContent!.trim()).toBe('Панель');
  });

  // ==================== DW-3.2 ====================

  describe('filters live in the URL (DW-3.2)', () => {
    it('DW-3.2 a deep link loads exactly that filter from the server', async () => {
      const req = await open('/catalog?category=physics&q=%D0%BC%D0%B0%D1%8F%D1%82%D0%BD%D0%B8%D0%BA&sort=title');
      expect(req.request.params.get('category')).toBe('physics');
      expect(req.request.params.get('q')).toBe('маятник');
      expect(req.request.params.get('sort')).toBe('title');
      expect(req.request.params.get('offset')).toBe('0');
      req.flush(payload());
      await settle();

      expect((q('.search-input') as HTMLInputElement).value).toBe('маятник');
      expect(qa('.chip').map(c => c.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
      expect((qa('input[name="vl-sort"]') as HTMLInputElement[]).map(r => r.checked)).toEqual([false, true]);
    });

    it('DW-3.2 clicking a chip writes the category to the URL and reloads from offset 0', async () => {
      await openAndAnswer();
      qa('.chip')[1].click();
      await settle();

      expect(url()).toBe('/catalog?category=physics');
      const [req] = catalogRequests();
      expect(req.request.params.get('category')).toBe('physics');
      expect(req.request.params.get('offset')).toBe('0');
      req.flush(payload({ scenarios: [], total: 0 }));
    });

    it('chip "Усі напрями" removes the category from the URL', async () => {
      await openAndAnswer('/catalog?category=physics');
      qa('.chip')[0].click();
      await settle();

      expect(url()).toBe('/catalog');
      catalogRequests().forEach(r => r.flush(payload()));
    });

    it('DW-3.1 the sort segment writes sort=title and the request carries it', async () => {
      await openAndAnswer();
      const radio = qa('input[name="vl-sort"]')[1] as HTMLInputElement;
      radio.click();
      await settle();

      expect(url()).toBe('/catalog?sort=title');
      const [req] = catalogRequests();
      expect(req.request.params.get('sort')).toBe('title');
      req.flush(payload());
    });

    it('DW-3.2 typing searches once after the debounce, not per keystroke, and replaces the history entry', async () => {
      await openAndAnswer();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const input = q<HTMLInputElement>('.search-input');
      for (const text of ['с', 'со', 'сон']) {
        input.value = text;
        input.dispatchEvent(new Event('input'));
      }
      expect(catalogRequests()).toHaveLength(0);

      vi.advanceTimersByTime(300);
      vi.useRealTimers();
      await settle();

      expect(url()).toBe('/catalog?q=%D1%81%D0%BE%D0%BD');
      const requests = catalogRequests();
      expect(requests).toHaveLength(1);
      expect(requests[0].request.params.get('q')).toBe('сон');
      requests[0].flush(payload());
    });

    it('DW-3.2 the search box is not overwritten by the URL while the user is mid-word', async () => {
      await openAndAnswer('/catalog?q=ab');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const input = q<HTMLInputElement>('.search-input');
      input.value = 'abc';
      input.dispatchEvent(new Event('input'));
      harness.detectChanges();

      expect(input.value).toBe('abc');
      vi.advanceTimersByTime(300);
      vi.useRealTimers();
      await settle();
      catalogRequests().forEach(r => r.flush(payload()));
    });

    it('DW-3.2 the clear button empties the box and the URL', async () => {
      await openAndAnswer('/catalog?q=abc');
      q('.search-clear').click();
      await settle();

      expect(url()).toBe('/catalog');
      expect((q('.search-input') as HTMLInputElement).value).toBe('');
      expect(q('.search-clear')).toBeNull();
      catalogRequests().forEach(r => r.flush(payload()));
    });

    it('DW-3.2 Back restores the previous filter: the box, the chip and the list follow the URL', async () => {
      await openAndAnswer();
      qa('.chip')[1].click();
      await settle();
      catalogRequests().forEach(r => r.flush(payload({ scenarios: [scenario('p')] })));
      await settle();

      // Back is the router re-activating the earlier URL; the platform's popstate is not wired in unit tests.
      void TestBed.inject(Router).navigateByUrl('/catalog');
      let req!: TestRequest;
      await vi.waitFor(() => {
        harness.detectChanges();
        [req] = catalogRequests();
        expect(req).toBeDefined();
      });

      expect(url()).toBe('/catalog');
      expect(req.request.params.has('category')).toBe(false);
      req.flush(payload());
      await settle();
      expect(qa('.chip').map(c => c.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    });

    it('DW-3.2 coming back from a scenario page with the filter in the URL reloads that filter', async () => {
      await openAndAnswer('/catalog?category=astronomy&sort=title');
      await TestBed.inject(Router).navigateByUrl('/scenario/a');
      await TestBed.inject(Router).navigateByUrl('/catalog?category=astronomy&sort=title');
      await settle();
      root = harness.routeNativeElement as HTMLElement;

      const [req] = catalogRequests();
      expect(req.request.params.get('category')).toBe('astronomy');
      expect(req.request.params.get('sort')).toBe('title');
      req.flush(payload());
    });

    it('DW-3.2 "load more" keeps the whole query and appends from the held offset', async () => {
      await openAndAnswer('/catalog?category=astronomy&q=x&sort=title');
      const more = qa('.more .btn')[0];
      expect(more.textContent!.trim()).toBe('Показати ще (2)');
      more.click();
      await settle();

      const [req] = catalogRequests();
      expect(req.request.params.get('offset')).toBe('2');
      expect(req.request.params.get('category')).toBe('astronomy');
      expect(req.request.params.get('q')).toBe('x');
      expect(req.request.params.get('sort')).toBe('title');
      req.flush(payload({ scenarios: [scenario('c'), scenario('d')], offset: 2 }));
      await settle();
      expect(qa('vl-scenario-card').length).toBe(4);
      expect(qa('.more').length).toBe(0);
    });

    it('DW-3.2 a response for an older filter never wins over the newer one', async () => {
      await openAndAnswer();
      qa('.chip')[1].click();
      await settle();
      const [oldReq] = catalogRequests();
      qa('.chip')[2].click();
      await settle();
      const [newReq] = catalogRequests();

      newReq.flush(payload({ scenarios: [scenario('astro')], total: 1 }));
      await settle();
      oldReq.flush(payload({ scenarios: [scenario('phys')], total: 1 }));
      await settle();

      expect(qa('vl-scenario-card').length).toBe(1);
      expect(q('.found').textContent).toContain('Знайдено 1 сценарій');
      expect(q('.card-title').textContent).toContain('Title astro');
    });

    it('a junk query string falls back to the defaults', async () => {
      const req = await open('/catalog?sort=DROP&category=&q=%20');
      expect(req.request.params.has('sort')).toBe(false);
      expect(req.request.params.has('category')).toBe(false);
      expect(req.request.params.has('q')).toBe(false);
      req.flush(payload());
    });
  });

  // ==================== DW-3.3 ====================

  describe('empty and error states (DW-3.3)', () => {
    it('DW-3.3 no results: "Нічого не знайдено" and a reset that clears the URL', async () => {
      await openAndAnswer('/catalog?category=physics&q=zzz&sort=title', payload({ scenarios: [], total: 0 }));

      expect(q('.empty-state .state-title').textContent!.trim()).toBe('Нічого не знайдено');
      expect(q('.found').textContent!.trim()).toBe('Знайдено 0 сценаріїв');
      expect(qa('vl-scenario-card').length).toBe(0);

      q<HTMLButtonElement>('.empty-state .btn').click();
      await settle();

      expect(url()).toBe('/catalog');
      expect((q('.search-input') as HTMLInputElement).value).toBe('');
      const [req] = catalogRequests();
      expect(req.request.params.has('category')).toBe(false);
      expect(req.request.params.has('q')).toBe(false);
      expect(req.request.params.has('sort')).toBe(false);
      req.flush(payload());
    });

    it('DW-3.3 the empty state is not flashed before the first answer', async () => {
      const req = await open();
      harness.detectChanges();
      expect(q('.empty-state')).toBeNull();
      req.flush(payload());
    });

    it('DW-3.3 a 500 shows the error state; "Спробувати ще раз" reloads the same filter', async () => {
      const req = await open('/catalog?category=physics');
      req.flush('boom', { status: 500, statusText: 'Server Error' });
      await settle();

      const error = q('.error-state');
      expect(error.getAttribute('role')).toBe('alert');
      expect(error.textContent).toContain('Не вдалося завантажити каталог');
      expect(q('.empty-state')).toBeNull();
      expect(q('.found')).toBeNull();

      error.querySelector<HTMLButtonElement>('.btn')!.click();
      await settle();
      const [retry] = catalogRequests();
      expect(retry.request.params.get('category')).toBe('physics');
      retry.flush(payload());
      await settle();
      expect(q('.error-state')).toBeNull();
      expect(qa('vl-scenario-card').length).toBe(2);
    });
  });

  // ==================== DW-3.6 ====================

  describe('modal and theme are gone, navigation targets (DW-3.6)', () => {
    it('DW-3.6 no dialog in the DOM, no theme toggle, and no `theme` key is ever written', async () => {
      await openAndAnswer();
      qa('vl-scenario-card')[0].querySelector<HTMLElement>('.scenario-card')!.click();
      await settle();

      expect(document.querySelector('[role="dialog"], .modal-overlay, .theme-toggle')).toBeNull();
      expect(localStorage.getItem('theme')).toBeNull();
      expect(document.documentElement.classList.contains('dark-theme')).toBe(false);
    });

    it('DW-3.6 a card opens /scenario/:id', async () => {
      await openAndAnswer();
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      qa('vl-scenario-card')[1].querySelector<HTMLElement>('.scenario-card')!.click();
      expect(navigate).toHaveBeenCalledWith(['/scenario', 'b']);
    });

    it('DW-3.6 "Запустити" goes straight to /play/:id, by id alone', async () => {
      await openAndAnswer();
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      qa('vl-scenario-card')[0].querySelector<HTMLElement>('.launch')!.click();

      expect(navigate).toHaveBeenCalledTimes(1);
      expect(navigate).toHaveBeenCalledWith(['/play', 'a']);
      expect(JSON.stringify(navigate.mock.calls)).not.toContain('scenarioUrl');
    });

    it('a scenario without an archive opens its page instead of a viewer that could only fail', async () => {
      await openAndAnswer('/catalog', payload({ scenarios: [scenario('empty', { scenarioUrl: '' })] }));
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      qa('vl-scenario-card')[0].querySelector<HTMLElement>('.launch')!.click();
      expect(navigate).toHaveBeenCalledWith(['/scenario', 'empty']);
    });

    it('an id unknown to the list still opens its page', async () => {
      await openAndAnswer();
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      harness.routeDebugElement!.componentInstance.launchScenario('ghost');
      expect(navigate).toHaveBeenCalledWith(['/scenario', 'ghost']);
    });

    it('the header button goes to /admin whether it reads "Увійти" or "Панель"', async () => {
      await openAndAnswer();
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      q('.account').click();
      expect(navigate).toHaveBeenCalledWith(['/admin']);
    });
  });
});
