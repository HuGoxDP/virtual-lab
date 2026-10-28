// path: src/app/pages/admin/scenario-list/scenario-list.component.spec.ts
//
// Test-plan scenario 210 (DW-5.2): the list filters by status and category, shows the status pills, and gives
// moderators (only) a bulk bar whose per-scenario results are shown.

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';

import { AdminSession } from '../../../services/admin-session.service';
import { adminRow, settle } from '../admin-testing';
import { ScenarioListComponent } from './scenario-list.component';

const ROWS = [
  adminRow('pub', { title: 'Опублікований', status: 'published', isPublished: true }),
  adminRow('rev', { title: 'На розгляді', status: 'review', category: 'biology', categoryLabel: 'Біологія', pendingVersionId: 9 }),
  adminRow('dra', { title: 'Чернетка', status: 'draft', archiveBytes: null, archiveSha256: null, currentVersion: null }),
  adminRow('rej', { title: 'Повернутий', status: 'rejected', author: 'x'.repeat(300) }),
];

const CATEGORIES = [
  { slug: 'physics', label: 'Фізика', icon: 'atom', sortOrder: 10, isVisible: true, scenarioCount: 3 },
  { slug: 'biology', label: 'Біологія', icon: 'dna', sortOrder: 20, isVisible: true, scenarioCount: 1 },
];

describe('ScenarioListComponent', () => {
  let fixture: ComponentFixture<ScenarioListComponent>;
  let root: HTMLElement;
  let http: HttpTestingController;

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.restoreAllMocks();
  });

  async function openAs(role: 'author' | 'moderator', rows = ROWS): Promise<void> {
    const signedIn = TestBed.inject(AdminSession).signIn('code');
    http.expectOne('/api/auth/me').flush({ role, label: 'Хтось', keyId: role === 'author' ? 4 : null });
    await signedIn;

    fixture = TestBed.createComponent(ScenarioListComponent);
    root = fixture.nativeElement;
    fixture.detectChanges();
    http.expectOne('/api/admin/scenarios').flush({ scenarios: rows });
    if (role === 'moderator') http.expectOne('/api/categories').flush({ categories: CATEGORIES });
    await settle(fixture);
  }

  const qa = (selector: string) => [...root.querySelectorAll<HTMLElement>(selector)];
  const titles = () => qa('.row-title').map(el => el.textContent?.trim());
  const chip = (label: string) => qa('.status-chip').find(el => el.textContent?.includes(label))!;
  const button = (label: string) => qa('button').find(el => el.textContent?.trim() === label)!;

  async function click(el: HTMLElement): Promise<void> {
    el.click();
    await settle(fixture, 2);
  }

  async function selectRows(...ids: string[]): Promise<void> {
    for (const id of ids) {
      const box = qa('tbody input[type="checkbox"]')[ROWS.findIndex(r => r.id === id)] as HTMLInputElement;
      box.click();
    }
    await settle(fixture, 2);
  }

  /** The bulk request, answered with `results`; then the list reloads. */
  async function answerBulk(results: Array<{ id: string; ok: boolean; error?: string }>): Promise<TestRequest> {
    const req = http.expectOne('/api/scenarios/bulk');
    req.flush({ results });
    await settle(fixture, 2);
    http.expectOne('/api/admin/scenarios').flush({ scenarios: ROWS });
    await settle(fixture);
    return req;
  }

  describe('status pills and filters (DW-5.2)', () => {
    beforeEach(() => openAs('author'));

    it('shows every status chip with its count, "Усі" first', () => {
      expect(qa('.status-chip').map(el => el.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
        'Усі 4', 'Опубліковано 1', 'На перевірці 1', 'Чернетка 1', 'На доопрацюванні 1',
      ]);
      expect(root.querySelector('.sub')?.textContent).toBe('4 записи · 1 опубліковано · 1 на перевірці');
    });

    it('shows a status pill per row with its Ukrainian label', () => {
      expect(qa('tbody tr').map(tr => tr.querySelector('vl-status-pill')?.textContent?.trim())).toEqual([
        'Опубліковано', 'На перевірці', 'Чернетка', 'На доопрацюванні',
      ]);
    });

    it('filters by status when a chip is pressed, and says which one is pressed', async () => {
      await click(chip('На перевірці'));
      expect(titles()).toEqual(['На розгляді']);
      expect(chip('На перевірці').getAttribute('aria-pressed')).toBe('true');
      expect(chip('Усі').getAttribute('aria-pressed')).toBe('false');

      await click(chip('Усі'));
      expect(titles().length).toBe(4);
    });

    it('filters by category, offering only categories the rows use', async () => {
      const select = root.querySelector<HTMLSelectElement>('#category-filter')!;
      expect([...select.options].map(o => o.text)).toEqual(['Усі категорії', 'Фізика', 'Біологія']);

      select.value = 'biology';
      select.dispatchEvent(new Event('change'));
      await settle(fixture, 2);
      expect(titles()).toEqual(['На розгляді']);
    });

    it('combines both filters and offers a reset when nothing matches', async () => {
      await click(chip('Чернетка'));
      const select = root.querySelector<HTMLSelectElement>('#category-filter')!;
      select.value = 'biology';
      select.dispatchEvent(new Event('change'));
      await settle(fixture, 2);

      expect(titles()).toEqual([]);
      expect(root.textContent).toContain('За цими фільтрами нічого немає');

      await click(button('Скинути фільтри'));
      expect(titles().length).toBe(4);
    });

    it('marks a published scenario that has an author\'s new version waiting', () => {
      expect(root.querySelectorAll('.pending').length).toBe(1);
    });

    it('links each title to its editor and offers a way to look at the scenario', () => {
      expect(qa('.row-title')[0].getAttribute('href')).toBe('/admin/scenarios/pub/meta');
      const view = qa('tbody tr').map(tr => [...tr.querySelectorAll('.actions a')].map(a => a.getAttribute('href')));
      expect(view[0]).toContain('/scenario/pub');
      expect(view[1]?.some(href => href?.startsWith('/play/rev?draft=' + 'a'.repeat(64) + '&returnTo=%2Fadmin%2Fscenarios'))).toBe(true);
      expect(view[2]).toEqual(['/admin/scenarios/dra/meta']); // a draft with no archive has nothing to play
    });

    it('shows the archive size, or says there is none', () => {
      expect(qa('tbody tr').map(tr => tr.querySelectorAll('td')[4]?.textContent?.trim())).toEqual(['2 МБ', '2 МБ', 'Немає архіву', '2 МБ']);
    });

    it('keeps a 300-character unbroken author in the cell (the text is wrapped, never the layout)', () => {
      const cell = qa('tbody tr')[3].querySelector<HTMLElement>('.author')!;
      expect(cell.textContent?.trim().length).toBe(300);
      expect(cell.classList.contains('wrap')).toBe(true);
    });

    it('"Новий сценарій" goes to the upload section', () => {
      expect(root.querySelector('.page-head a.btn-primary')?.getAttribute('href')).toBe('/admin/upload');
    });
  });

  describe('authors (DW-5.2)', () => {
    beforeEach(() => openAs('author'));

    it('are titled "Мої сценарії" and get no selection column, no bulk bar and no categories request', () => {
      expect(root.querySelector('h1')?.textContent).toBe('Мої сценарії');
      expect(root.querySelectorAll('input[type="checkbox"]').length).toBe(0);
      expect(root.querySelector('.bulk-bar')).toBeNull();
    });
  });

  describe('moderators: selection and the bulk bar (DW-5.2)', () => {
    beforeEach(() => openAs('moderator'));

    it('are titled "Усі сценарії" and get a checkbox per row but no bar until something is selected', () => {
      expect(root.querySelector('h1')?.textContent).toBe('Усі сценарії');
      expect(qa('tbody input[type="checkbox"]').length).toBe(4);
      expect(root.querySelector('.bulk-bar')).toBeNull();
    });

    it('show the bar with the count in Ukrainian plural form', async () => {
      await selectRows('pub');
      expect(root.querySelector('.bulk-count')?.textContent?.trim()).toBe('Вибрано 1 сценарій');
      await selectRows('rev');
      expect(root.querySelector('.bulk-count')?.textContent?.trim()).toBe('Вибрано 2 сценарії');
    });

    it('select all picks the visible rows only and a second press clears them', async () => {
      await click(chip('Опубліковано'));
      await click(root.querySelector<HTMLElement>('thead input[type="checkbox"]')!);
      expect(root.querySelector('.bulk-count')?.textContent?.trim()).toBe('Вибрано 1 сценарій');

      await click(root.querySelector<HTMLElement>('thead input[type="checkbox"]')!);
      expect(root.querySelector('.bulk-bar')).toBeNull();
    });

    it('changing a filter drops the selection, so a hidden row is never acted on', async () => {
      await selectRows('pub');
      await click(chip('Чернетка'));
      expect(root.querySelector('.bulk-bar')).toBeNull();
    });

    it('publish sends the ids and shows the server\'s answer for each, then reloads and clears the selection', async () => {
      await selectRows('pub', 'rev');
      await click(button('Опублікувати'));
      const req = await answerBulk([{ id: 'pub', ok: true }, { id: 'rev', ok: false, error: 'Немає архіву' }]);

      expect(req.request.body).toEqual({ ids: ['pub', 'rev'], action: 'approve' });
      expect(root.querySelector('.bulk-results strong')?.textContent).toBe('Опублікування: 1 з 2');
      const lines = qa('.bulk-results li');
      expect(lines.map(li => li.querySelector('.result-id')?.textContent)).toEqual(['Опублікований', 'На розгляді']);
      expect(lines[0].querySelector('.result-error')).toBeNull();
      expect(lines[1].querySelector('.result-error')?.textContent).toBe('Немає архіву');
      expect(lines[1].classList.contains('failed')).toBe(true);
      expect(root.querySelector('.bulk-bar')).toBeNull();
    });

    it('the results can be dismissed', async () => {
      await selectRows('pub');
      await click(button('Зняти з публікації'));
      await answerBulk([{ id: 'pub', ok: true }]);
      await click(button('Закрити'));
      expect(root.querySelector('.bulk-results')).toBeNull();
    });

    it('change category needs a category chosen first and sends it', async () => {
      await selectRows('pub');
      expect(button('Змінити категорію').hasAttribute('disabled')).toBe(true);

      const select = root.querySelector<HTMLSelectElement>('.bulk-category select')!;
      expect([...select.options].map(o => o.text)).toEqual(['Категорія…', 'Фізика', 'Біологія']);
      select.value = 'biology';
      select.dispatchEvent(new Event('change'));
      await settle(fixture, 2);
      await click(button('Змінити категорію'));

      const req = await answerBulk([{ id: 'pub', ok: true }]);
      expect(req.request.body).toEqual({ ids: ['pub'], action: 'set-category', category: 'biology' });
    });

    it('delete asks first: declining sends nothing and keeps the selection', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      await selectRows('pub');
      await click(button('Видалити'));
      expect(confirm).toHaveBeenCalled();
      http.expectNone('/api/scenarios/bulk');
      expect(root.querySelector('.bulk-bar')).not.toBeNull();
    });

    it('delete after a yes sends the action', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      await selectRows('pub');
      await click(button('Видалити'));
      const req = await answerBulk([{ id: 'pub', ok: true }]);
      expect(req.request.body).toEqual({ ids: ['pub'], action: 'delete' });
    });

    it('a request refused as a whole shows the server\'s message and keeps the selection', async () => {
      await selectRows('pub');
      await click(button('Опублікувати'));
      http.expectOne('/api/scenarios/bulk').flush({ error: 'ids: не більше 100 за один запит' }, { status: 400, statusText: 'Bad Request' });
      await settle(fixture);

      expect(root.querySelector('.banner-error')?.textContent).toContain('не більше 100');
      expect(root.querySelector('.bulk-bar')).not.toBeNull();
      expect(root.querySelector('.bulk-results')).toBeNull();
    });

    it('"Зняти виділення" clears the selection', async () => {
      await selectRows('pub');
      await click(button('Зняти виділення'));
      expect(root.querySelector('.bulk-bar')).toBeNull();
    });
  });

  describe('states', () => {
    it('says so when there are no scenarios at all', async () => {
      await openAs('author', []);
      expect(root.textContent).toContain('Сценаріїв ще немає');
      expect(root.querySelector('table')).toBeNull();
    });

    it('shows the server\'s message when the list fails', async () => {
      const signedIn = TestBed.inject(AdminSession).signIn('code');
      http.expectOne('/api/auth/me').flush({ role: 'author', label: 'А', keyId: 4 });
      await signedIn;
      fixture = TestBed.createComponent(ScenarioListComponent);
      root = fixture.nativeElement;
      fixture.detectChanges();
      http.expectOne('/api/admin/scenarios').flush({ error: 'Помилка сервера' }, { status: 500, statusText: 'err' });
      await settle(fixture);

      expect(root.querySelector('.banner-error')?.textContent).toContain('Помилка сервера');
    });
  });
});
