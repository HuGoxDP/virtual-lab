// path: src/app/pages/catalog/catalog.component.spec.ts
//
// Covers test-plan scenarios 75, 76, 77, 79, 80.
//
// Timers are driven with vitest's fake timers rather than Angular's
// `fakeAsync()`: that helper is part of zone.js testing, and this app is
// zoneless — calling it fails outright.

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { CatalogComponent } from './catalog.component';
import { ScenarioCatalogItem } from '../../models/scenario.model';

function scenario(id: string, overrides: Partial<ScenarioCatalogItem> = {}): ScenarioCatalogItem {
  return {
    id,
    title: `Title ${id}`,
    description: 'desc',
    fullDescription: 'full',
    category: 'astronomy',
    categoryLabel: 'Астрономія',
    imageUrl: 'https://example.test/img.png',
    scenarioUrl: `/scenarios/${id}.zip`,
    ...overrides,
  };
}

const PAYLOAD = {
  version: '1',
  scenarios: [scenario('a'), scenario('b')],
  categories: [{ category: 'astronomy', categoryLabel: 'Астрономія' }],
  total: 4,
  limit: 24,
  offset: 0,
};

describe('CatalogComponent', () => {
  let fixture: ComponentFixture<CatalogComponent>;
  let component: CatalogComponent;
  let http: HttpTestingController;

  beforeEach(async () => {
    vi.useFakeTimers();
    localStorage.clear();
    document.documentElement.classList.remove('dark-theme');

    await TestBed.configureTestingModule({
      imports: [CatalogComponent],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();

    fixture = TestBed.createComponent(CatalogComponent);
    component = fixture.componentInstance;
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    fixture.destroy();
    http.verify();
    vi.useRealTimers();
  });

  /**
   * Lets pending promise continuations run.
   *
   * The service writes its signals *after* awaiting the HTTP observable, so a
   * flush alone is not enough — the assertion would see the state as it was
   * before the response.
   */
  async function settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  /** Renders and answers the initial catalog request. */
  async function init(payload = PAYLOAD): Promise<void> {
    fixture.detectChanges();
    http.expectOne(r => r.url === '/api/catalog').flush(payload);
    await settle();
    fixture.detectChanges();
  }

  function inputEvent(value: string): Event {
    const input = document.createElement('input');
    input.value = value;
    return { target: input } as unknown as Event;
  }

  function openModalWith(item: ScenarioCatalogItem, trigger = document.createElement('button')): void {
    component.openModal(item, { currentTarget: trigger } as unknown as Event);
    vi.advanceTimersByTime(0);
  }

  function closeModal(): void {
    component.closeModal();
    vi.advanceTimersByTime(250);
  }

  describe('initial load', () => {
    it('requests the catalog on init', async () => {
      await init();
      expect(component.scenarios().map(s => s.id)).toEqual(['a', 'b']);
      expect(component.total()).toBe(4);
    });
  });

  describe('search debounce', () => {
    it('issues one request after the debounce window, not one per keystroke', async () => {
      await init();

      component.onSearch(inputEvent('с'));
      component.onSearch(inputEvent('со'));
      component.onSearch(inputEvent('сон'));

      // Nothing yet — each keystroke resets the timer.
      http.expectNone(r => r.url === '/api/catalog');

      vi.advanceTimersByTime(300);
      const req = http.expectOne(r => r.url === '/api/catalog');
      expect(req.request.params.get('q')).toBe('сон');
      req.flush(PAYLOAD);
    });

    it('does not fire when the component is destroyed mid-debounce', async () => {
      await init();
      component.onSearch(inputEvent('abc'));

      fixture.destroy();
      vi.advanceTimersByTime(300);

      http.expectNone(r => r.url === '/api/catalog');
    });
  });

  describe('category filter', () => {
    it('reloads from offset 0 when the category changes', async () => {
      await init();

      component.selectCategory('biology');
      const req = http.expectOne(r => r.url === '/api/catalog');
      expect(req.request.params.get('category')).toBe('biology');
      expect(req.request.params.get('offset')).toBe('0');
      req.flush({ ...PAYLOAD, scenarios: [], total: 0 });
    });

    it('ignores selecting the category already active', async () => {
      await init();
      component.selectCategory('all');
      http.expectNone(r => r.url === '/api/catalog');
    });
  });

  describe('paging', () => {
    it('appends the next page with the right offset', async () => {
      await init();
      expect(component.hasMore()).toBe(true);

      component.loadMore();
      const req = http.expectOne(r => r.url === '/api/catalog');
      expect(req.request.params.get('offset')).toBe('2');
      req.flush({ ...PAYLOAD, scenarios: [scenario('c'), scenario('d')], offset: 2 });
      await settle();

      expect(component.scenarios().map(s => s.id)).toEqual(['a', 'b', 'c', 'd']);
      expect(component.hasMore()).toBe(false);
    });
  });

  describe('image fallback', () => {
    it('swaps in the inline placeholder', async () => {
      const img = document.createElement('img');
      img.src = 'https://example.test/missing.png';

      component.handleImageError({ target: img } as unknown as Event);

      expect(img.src.startsWith('data:image/svg+xml')).toBe(true);
    });

    it('does not loop when the placeholder itself fails', async () => {
      const img = document.createElement('img');
      component.handleImageError({ target: img } as unknown as Event);
      const first = img.src;

      component.handleImageError({ target: img } as unknown as Event);

      expect(img.src).toBe(first);
    });
  });

  describe('theme', () => {
    it('reads the stored preference and applies it to <html>', async () => {
      localStorage.setItem('theme', 'dark');
      await init();

      expect(component.isDarkMode()).toBe(true);
      // On <html>, not just the catalog layout, so the viewer follows it too.
      expect(document.documentElement.classList.contains('dark-theme')).toBe(true);
    });

    it('persists a toggle', async () => {
      await init();
      component.toggleTheme();

      expect(localStorage.getItem('theme')).toBe('dark');
      expect(document.documentElement.classList.contains('dark-theme')).toBe(true);

      component.toggleTheme();
      expect(localStorage.getItem('theme')).toBe('light');
      expect(document.documentElement.classList.contains('dark-theme')).toBe(false);
    });
  });

  describe('modal', () => {
    it('opens with the chosen scenario', async () => {
      await init();
      openModalWith(scenario('a'));

      expect(component.isModalOpen()).toBe(true);
      expect(component.activeScenario()?.id).toBe('a');

      closeModal();
    });

    it('returns focus to the card that opened it', async () => {
      await init();
      const trigger = document.createElement('button');
      document.body.appendChild(trigger);

      openModalWith(scenario('a'), trigger);
      component.closeModal();

      expect(document.activeElement).toBe(trigger);

      vi.advanceTimersByTime(250);
      expect(component.activeScenario()).toBeNull();
      trigger.remove();
    });

    it('closes on Escape', async () => {
      await init();
      openModalWith(scenario('a'));

      component.onModalKeydown(new KeyboardEvent('keydown', { key: 'Escape' }));

      expect(component.isModalOpen()).toBe(false);
      vi.advanceTimersByTime(250);
    });

    it('ignores unrelated keys', async () => {
      await init();
      openModalWith(scenario('a'));

      component.onModalKeydown(new KeyboardEvent('keydown', { key: 'a' }));
      expect(component.isModalOpen()).toBe(true);

      closeModal();
    });
  });

  describe('launch', () => {
    it('navigates by id alone, never carrying the archive URL', async () => {
      await init();
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

      openModalWith(scenario('a'));
      component.launchScenario();

      // Regression for the open relay: the viewer resolves the URL itself.
      expect(navigate).toHaveBeenCalledWith(['/play', 'a']);
      expect(JSON.stringify(navigate.mock.calls)).not.toContain('scenarioUrl');

      closeModal();
    });

    it('does nothing for a scenario with no archive', async () => {
      await init();
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

      openModalWith(scenario('empty', { scenarioUrl: '' }));
      component.launchScenario();

      expect(navigate).not.toHaveBeenCalled();

      closeModal();
    });
  });
});
