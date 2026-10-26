// path: src/app/pages/scenario/scenario.component.spec.ts
//
// Release 1, phase 3. Covers test-plan scenarios 128 (all fields, hidden blocks, id encoding, title,
// header - DW-3.4), 129 (not-found, error + retry, out-of-order ids - DW-3.4), 130 (copy link, fallback,
// download href - DW-3.5).

import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';

import { ScenarioComponent } from './scenario.component';
import { ScenarioDetail } from '../../models/scenario.model';
import { ScenarioService } from '../../services/scenario.service';
import { SITE } from '../../site.config';
import { ToastService } from '../../ui/toast/toast.service';

function detail(id: string, overrides: Partial<ScenarioDetail> = {}): ScenarioDetail {
  return {
    id,
    title: `Title ${id}`,
    description: 'Short',
    fullDescription: 'Long text\nsecond line',
    category: 'physics',
    categoryLabel: 'Фізика',
    imageUrl: '',
    scenarioUrl: `/scenarios/${id}.zip`,
    version: '1.2.0',
    author: 'Автор',
    archiveBytes: 50537267,
    updatedAt: '2026-03-12T10:00:00.000Z',
    features: [
      { icon: 'atom', title: 'Атоми', subtitle: 'Будова' },
      { icon: 'flask', title: 'Колби' },
    ],
    related: [{ id: 'other', title: 'Інший', category: 'biology', categoryLabel: 'Біологія', imageUrl: '' }],
    ...overrides,
  };
}

describe('ScenarioComponent', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;
  let root: HTMLElement;

  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'scenario/:id', component: ScenarioComponent },
          { path: 'catalog', children: [] },
          { path: 'play/:id', children: [] },
        ]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => http.verify());

  async function settle(): Promise<void> {
    for (let i = 0; i < 4; i++) await Promise.resolve();
    harness.detectChanges();
    await harness.fixture.whenStable();
    harness.detectChanges();
  }

  /** Opens the page and returns the request for the scenario, for the caller to answer. */
  async function open(path = '/scenario/a'): Promise<TestRequest> {
    await harness.navigateByUrl(path, ScenarioComponent);
    root = harness.routeNativeElement as HTMLElement;
    return http.expectOne(r => r.url.startsWith('/api/catalog/'));
  }

  async function openWith(body: ScenarioDetail): Promise<void> {
    (await open(`/scenario/${encodeURIComponent(body.id)}`)).flush(body);
    await settle();
  }

  const q = <T extends HTMLElement>(selector: string): T => root.querySelector<T>(selector) as T;
  const qa = (selector: string): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(selector)];
  const text = (selector: string) => q(selector).textContent!.replace(/\s+/g, ' ').trim();

  // ==================== DW-3.4 ====================

  describe('a full scenario (DW-3.4)', () => {
    beforeEach(async () => openWith(detail('a')));

    it('DW-3.4 renders title, kicker, byline and the description with its line breaks', () => {
      expect(text('h1.title')).toBe('Title a');
      expect(text('.kicker')).toBe('Фізика');
      expect(text('.byline')).toContain('Автор');
      expect(text('.byline')).toContain('Оновлено 12 бер 2026');
      expect(text('.byline')).toContain('1.2.0');
      expect(q('.description').textContent).toBe('Long text\nsecond line');
    });

    it('DW-3.4 the meta table lists version, author, size, updated and ID', () => {
      const rows = qa('.meta-row').map(r => [r.querySelector('dt')!.textContent!.trim(), r.querySelector('dd')!.textContent!.trim()]);
      expect(rows).toEqual([
        ['Версія', '1.2.0'],
        ['Автор', 'Автор'],
        ['Розмір архіву', '48,2 МБ'],
        ['Оновлено', '12 бер 2026'],
        ['Ідентифікатор', 'a'],
      ]);
    });

    it('DW-3.4 "Що всередині" shows each feature, the subtitle only when there is one', () => {
      const features = qa('.feature');
      expect(features.length).toBe(2);
      expect(features[0].querySelector('.feature-title')!.textContent).toBe('Атоми');
      expect(features[0].querySelector('.feature-sub')!.textContent).toBe('Будова');
      expect(features[1].querySelector('.feature-sub')).toBeNull();
    });

    it('DW-3.4 related scenarios link to their own pages', () => {
      const link = q('.related-item');
      expect(link.getAttribute('href')).toBe('/scenario/other');
      expect(link.textContent).toContain('Інший');
      expect(link.textContent).toContain('Біологія');
    });

    it('DW-3.4 the breadcrumbs carry category and title; the document title is set', () => {
      expect(text('.crumb-category')).toBe('Фізика');
      expect(text('.crumb-title')).toBe('Title a');
      expect(TestBed.inject(Title).getTitle()).toBe(`Title a — ${SITE.name}`);
    });

    it('DW-3.4 the header is the logo-only variant: back button and breadcrumbs in [header-start]', () => {
      const header = q('header.site-header');
      expect(header.classList.contains('is-logo-only')).toBe(true);
      expect(header.querySelector('.slot-start .back')).not.toBeNull();
      expect(header.querySelector('.slot-start .crumbs')).not.toBeNull();
      expect(header.querySelector('.brand')).toBeNull();
    });

    it('DW-3.4 the launch button goes to /play/:id; the sticky bar has one too', () => {
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      q<HTMLButtonElement>('.side .launch').click();
      q<HTMLButtonElement>('.launch-bar .btn').click();
      expect(navigate).toHaveBeenNthCalledWith(1, ['/play', 'a']);
      expect(navigate).toHaveBeenNthCalledWith(2, ['/play', 'a']);
    });

    it('DW-5.2 no download link and no launch note; the launch button stays', () => {
      expect(q('.download')).toBeNull();
      expect(q('a[download]')).toBeNull();
      expect(q('.launch-note')).toBeNull();
      expect(q('.side .launch')).not.toBeNull();
    });

    it('DW-5.1 the footer is the copyright bar only', () => {
      expect(q('.footer-inner')).toBeNull();
      expect(q('.footer-legal')).not.toBeNull();
    });
  });

  describe('missing data hides its block, never a placeholder (DW-3.4)', () => {
    it('DW-3.4 no features -> no "Що всередині"; no related -> no "Суміжні сценарії"', async () => {
      await openWith(detail('a', { features: [], related: [] }));
      const titles = qa('.block-title').map(t => t.textContent!.trim());
      expect(titles).toEqual([]);
      expect(q('.features')).toBeNull();
      expect(q('.related')).toBeNull();
    });

    it('DW-3.4 only the blocks that have data are drawn', async () => {
      await openWith(detail('a', { related: [] }));
      expect(qa('.block-title').map(t => t.textContent!.trim())).toEqual(['Що всередині']);
    });

    it('DW-3.4 no scenarioUrl -> no launch button and no sticky bar', async () => {
      await openWith(detail('a', { scenarioUrl: '' }));
      expect(q('.launch')).toBeNull();
      expect(q('.launch-bar')).toBeNull();
      expect(q('.copy')).not.toBeNull();
    });

    it('DW-3.4 no archive size, version, author or update date -> those meta rows and byline items are absent', async () => {
      await openWith(detail('a', { archiveBytes: null, version: '', author: '', updatedAt: '' }));
      expect(qa('.meta-row dt').map(d => d.textContent!.trim())).toEqual(['Ідентифікатор']);
      expect(qa('.byline-item').length).toBe(0);
    });

    it('falls back to the short description, and omits the paragraph when both are empty', async () => {
      await openWith(detail('a', { fullDescription: '' }));
      expect(q('.description').textContent).toBe('Short');
    });

    it('no description at all -> no paragraph', async () => {
      await openWith(detail('a', { fullDescription: '', description: '' }));
      expect(q('.description')).toBeNull();
    });

    it('a preview that fails to load falls back to the category gradient', async () => {
      await openWith(detail('a', { imageUrl: '/missing.jpg' }));
      const image = q<HTMLImageElement>('.banner-image');
      expect(image.getAttribute('src')).toBe('/missing.jpg');
      image.dispatchEvent(new Event('error'));
      harness.detectChanges();
      expect(q('.banner-image')).toBeNull();
      expect(q<HTMLElement>('.banner').style.background).not.toBe('');
    });
  });

  describe('id encoding (DW-3.4)', () => {
    it('DW-3.4 an id with "/" and Cyrillic is encoded in the API request and the related links', async () => {
      const id = 'фізика/маятник';
      const req = await open('/scenario/' + encodeURIComponent(id));
      expect(req.request.url).toBe('/api/catalog/' + encodeURIComponent(id));
      req.flush(detail(id, { related: [{ id, title: 'Self', category: 'x', categoryLabel: 'X', imageUrl: '' }] }));
      await settle();

      expect(q('.related-item').getAttribute('href')).toBe('/scenario/' + encodeURIComponent(id));
      expect(text('.meta-row:last-child dd')).toBe(id);
    });
  });

  describe('not found and errors (DW-3.4)', () => {
    it('DW-3.4 an unknown or unpublished id shows the not-found state', async () => {
      const req = await open('/scenario/ghost');
      req.flush({ error: 'Сценарій не знайдено' }, { status: 404, statusText: 'Not Found' });
      await settle();

      expect(text('.not-found-state h1')).toBe('Сценарій не знайдено');
      expect(q('.error-state')).toBeNull();
      expect(q('.layout')).toBeNull();
      expect(TestBed.inject(Title).getTitle()).toContain('Сценарій не знайдено');
    });

    it('DW-3.4 a 500 shows the error state; retry reloads and recovers', async () => {
      const req = await open('/scenario/a');
      req.flush('boom', { status: 500, statusText: 'Server Error' });
      await settle();

      expect(q('.error-state').getAttribute('role')).toBe('alert');
      expect(q('.not-found-state')).toBeNull();

      q<HTMLButtonElement>('.error-state .btn').click();
      await settle();
      http.expectOne('/api/catalog/a').flush(detail('a'));
      await settle();

      expect(q('.error-state')).toBeNull();
      expect(text('h1.title')).toBe('Title a');
    });

    it('a network failure (status 0) is an error state, not a not-found', async () => {
      const req = await open('/scenario/a');
      req.error(new ProgressEvent('error'), { status: 0 });
      await settle();
      expect(q('.error-state')).not.toBeNull();
      expect(q('.not-found-state')).toBeNull();
    });

    it('shows a loading state until the answer arrives', async () => {
      const req = await open('/scenario/a');
      harness.detectChanges();
      expect(q('.state[role="status"]')).not.toBeNull();
      expect(q('.layout')).toBeNull();
      req.flush(detail('a'));
    });

    it('DW-3.4 a late answer for the scenario the visitor already left is dropped', async () => {
      const first = await open('/scenario/a');
      await harness.navigateByUrl('/scenario/b', ScenarioComponent);
      const second = http.expectOne('/api/catalog/b');

      second.flush(detail('b'));
      await settle();
      first.flush(detail('a'));
      await settle();

      expect(text('h1.title')).toBe('Title b');
      expect(TestBed.inject(Title).getTitle()).toBe(`Title b — ${SITE.name}`);
    });
  });

  describe('back to the catalog', () => {
    it('DW-3.2 "Каталог" returns with the filter the visitor came from', async () => {
      const service = TestBed.inject(ScenarioService);
      const pending = service.loadCatalog({ category: 'physics', q: 'сила', sort: 'title' });
      http.expectOne(r => r.url === '/api/catalog').flush({ version: '1', scenarios: [], total: 0 });
      await pending;

      await openWith(detail('a'));
      expect(decodeURIComponent(q('.back').getAttribute('href')!)).toBe('/catalog?category=physics&q=сила&sort=title');
    });

    it('goes to a clean /catalog when nothing was filtered', async () => {
      await openWith(detail('a'));
      expect(q('.back').getAttribute('href')).toBe('/catalog');
    });
  });

  // ==================== DW-3.5 ====================

  describe('copy link (DW-3.5)', () => {
    const clipboardOf = (writeText: unknown) =>
      Object.defineProperty(navigator, 'clipboard', { value: writeText === undefined ? undefined : { writeText }, configurable: true });

    afterEach(() => Reflect.deleteProperty(navigator, 'clipboard'));

    it('DW-3.5 copies the absolute page URL and shows a toast', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      clipboardOf(writeText);
      await openWith(detail('a'));

      q<HTMLButtonElement>('.copy').click();
      await settle();

      expect(writeText).toHaveBeenCalledWith(`${location.origin}/scenario/a`);
      expect(TestBed.inject(ToastService).message()).toBe('Посилання скопійовано');
      expect(q('.manual-link')).toBeNull();
    });

    it('DW-3.5 the copied URL encodes the id', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      clipboardOf(writeText);
      await openWith(detail('фізика/1'));

      q<HTMLButtonElement>('.copy').click();
      await settle();
      expect(writeText).toHaveBeenCalledWith(`${location.origin}/scenario/${encodeURIComponent('фізика/1')}`);
    });

    it('DW-3.5 no Clipboard API (plain HTTP): the link is shown selectable, no toast, no error', async () => {
      clipboardOf(undefined);
      await openWith(detail('a'));

      q<HTMLButtonElement>('.copy').click();
      await settle();

      const input = q<HTMLInputElement>('.manual-link');
      expect(input.value).toBe(`${location.origin}/scenario/a`);
      expect(input.readOnly).toBe(true);
      expect(TestBed.inject(ToastService).message()).toBe('');
    });

    it('DW-3.5 a rejected clipboard write falls back the same way', async () => {
      clipboardOf(vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')));
      await openWith(detail('a'));

      q<HTMLButtonElement>('.copy').click();
      await settle();

      expect(q<HTMLInputElement>('.manual-link').value).toBe(`${location.origin}/scenario/a`);
      expect(TestBed.inject(ToastService).message()).toBe('');
    });

    it('a later successful copy removes the fallback input', async () => {
      clipboardOf(undefined);
      await openWith(detail('a'));
      q<HTMLButtonElement>('.copy').click();
      await settle();
      expect(q('.manual-link')).not.toBeNull();

      clipboardOf(vi.fn().mockResolvedValue(undefined));
      q<HTMLButtonElement>('.copy').click();
      await settle();
      expect(q('.manual-link')).toBeNull();
    });
  });
});
