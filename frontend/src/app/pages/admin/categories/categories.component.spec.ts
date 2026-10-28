// path: src/app/pages/admin/categories/categories.component.spec.ts
//
// Test-plan scenario 229 (DW-7.3): categories are added, reordered, hidden and, when empty, deleted from the UI;
// a category with scenarios cannot be deleted; a reorder conflict re-reads the list.

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { AdminCategory } from '../../../models/admin.model';
import { settle } from '../admin-testing';
import { CategoriesComponent } from './categories.component';

const cat = (slug: string, order: number, overrides: Partial<AdminCategory> = {}): AdminCategory =>
  ({ slug, label: `Назва ${slug}`, icon: 'atom', sortOrder: order, isVisible: true, scenarioCount: 0, ...overrides });

const LIST = [cat('physics', 10, { scenarioCount: 2 }), cat('biology', 20), cat('chem', 30, { isVisible: false })];

describe('CategoriesComponent', () => {
  let fixture: ComponentFixture<CategoriesComponent>;
  let root: HTMLElement;
  let http: HttpTestingController;

  beforeEach(async () => {
    sessionStorage.setItem('adminToken', 'code');
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(CategoriesComponent);
    root = fixture.nativeElement;
    fixture.detectChanges();
    http.expectOne('/api/categories').flush({ categories: LIST });
    await settle(fixture);
  });

  afterEach(() => {
    http.verify();
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  const qa = (selector: string) => [...root.querySelectorAll<HTMLElement>(selector)];
  const slugs = () => qa('tbody tr').map(tr => tr.getAttribute('data-slug'));
  const row = (slug: string) => root.querySelector<HTMLElement>(`tr[data-slug="${slug}"]`)!;
  const btn = (slug: string, action: string) => row(slug).querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!;
  async function click(el: HTMLElement): Promise<void> { el.click(); await settle(fixture, 2); }
  async function refetch(list: AdminCategory[]): Promise<void> {
    await settle(fixture, 2);
    http.expectOne('/api/categories').flush({ categories: list });
    await settle(fixture);
  }

  it('lists the categories in the server\'s order with count and visibility', () => {
    expect(slugs()).toEqual(['physics', 'biology', 'chem']);
    expect(row('physics').querySelector('[data-role="count"]')?.textContent).toBe('2');
    expect(btn('chem', 'visibility').textContent).toContain('Сховано');
    expect(btn('physics', 'visibility').textContent).toContain('Показано');
    expect(root.querySelector('[data-role="summary"]')?.textContent).toContain('3 категорії');
  });

  it('states the rule about deleting a used category', () => {
    expect(root.querySelector('[data-role="used-hint"]')?.textContent).toContain('не можна видалити');
  });

  describe('add (DW-7.3)', () => {
    const fill = (id: string, value: string) => {
      const input = root.querySelector<HTMLInputElement>(id)!;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };

    it('DW-7.3 posts slug, label, icon and visibility, then re-reads the list and clears the form', async () => {
      fill('#cat-label', '  Математика ');
      fill('#cat-slug', 'math');
      root.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
      const req = http.expectOne('/api/categories');
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({ slug: 'math', label: 'Математика', icon: 'folder', isVisible: true });
      req.flush({ category: cat('math', 40) });
      await refetch([...LIST, cat('math', 40)]);
      expect(slugs()).toContain('math');
      expect(root.querySelector<HTMLInputElement>('#cat-slug')!.value).toBe('');
    });

    it('rejects a bad slug or empty name before any request', async () => {
      fill('#cat-label', 'X');
      fill('#cat-slug', 'Bad Slug');
      root.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
      await settle(fixture, 2);
      expect(root.querySelector('[data-role="form-error"]')?.textContent).toContain('Slug');
      fill('#cat-label', '  ');
      fill('#cat-slug', 'ok-slug');
      root.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
      await settle(fixture, 2);
      expect(root.querySelector('[data-role="form-error"]')?.textContent).toContain('назву');
      http.expectNone('/api/categories');
    });

    it('shows the server\'s refusal (duplicate slug) on the form and keeps the input', async () => {
      fill('#cat-label', 'Фізика 2');
      fill('#cat-slug', 'physics');
      root.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
      http.expectOne('/api/categories').flush({ error: 'Категорія "physics" вже існує' }, { status: 409, statusText: 'Conflict' });
      await settle(fixture);
      expect(root.querySelector('[data-role="form-error"]')?.textContent).toContain('вже існує');
      expect(root.querySelector<HTMLInputElement>('#cat-slug')!.value).toBe('physics');
    });
  });

  describe('reorder (DW-7.3)', () => {
    it('DW-7.3 moving a row down sends the whole new order and shows what the server then lists', async () => {
      await click(btn('physics', 'down'));
      const req = http.expectOne('/api/categories/reorder');
      expect(req.request.body).toEqual({ slugs: ['biology', 'physics', 'chem'] });
      req.flush({ categories: [] });
      await refetch([LIST[1], LIST[0], LIST[2]]);
      expect(slugs()).toEqual(['biology', 'physics', 'chem']);
    });

    it('moving up works, and the first up / last down buttons are disabled', async () => {
      expect(btn('physics', 'up').disabled).toBe(true);
      expect(btn('chem', 'down').disabled).toBe(true);
      await click(btn('chem', 'up'));
      const req = http.expectOne('/api/categories/reorder');
      expect(req.request.body).toEqual({ slugs: ['physics', 'chem', 'biology'] });
      req.flush({ categories: [] });
      await refetch(LIST);
    });

    it('DW-7.3 a conflict (409) shows the message and re-reads the list', async () => {
      await click(btn('physics', 'down'));
      http.expectOne('/api/categories/reorder').flush({ error: 'Список категорій змінився: оновіть сторінку та повторіть' }, { status: 409, statusText: 'Conflict' });
      await refetch([cat('newcomer', 5), ...LIST]);
      expect(root.querySelector('[data-role="error"]')?.textContent).toContain('Список категорій змінився');
      expect(slugs()[0]).toBe('newcomer');
    });

    it('any other failure shows the message and does not re-read', async () => {
      await click(btn('physics', 'down'));
      http.expectOne('/api/categories/reorder').flush({ error: 'Помилка сервера' }, { status: 500, statusText: 'x' });
      await settle(fixture);
      expect(root.querySelector('[data-role="error"]')?.textContent).toContain('Помилка сервера');
      expect(slugs()).toEqual(['physics', 'biology', 'chem']);
    });
  });

  describe('hide, icon, rename, delete', () => {
    it('DW-7.3 hiding sends isVisible=false for a visible category, showing sends true', async () => {
      await click(btn('biology', 'visibility'));
      const hide = http.expectOne('/api/categories/biology');
      expect(hide.request.method).toBe('PUT');
      expect(hide.request.body).toEqual({ isVisible: false });
      hide.flush({ category: cat('biology', 20, { isVisible: false }) });
      await refetch([LIST[0], cat('biology', 20, { isVisible: false }), LIST[2]]);
      expect(btn('biology', 'visibility').textContent).toContain('Сховано');
      await click(btn('chem', 'visibility'));
      const show = http.expectOne('/api/categories/chem');
      expect(show.request.body).toEqual({ isVisible: true });
      show.flush({ category: LIST[2] });
      await refetch(LIST);
    });

    it('DW-7.3 delete is disabled while scenarios use the category', () => {
      expect(btn('physics', 'delete').disabled).toBe(true);
      expect(btn('biology', 'delete').disabled).toBe(false);
    });

    it('DW-7.3 an empty category is deleted after confirmation and the list re-read', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      await click(btn('biology', 'delete'));
      const req = http.expectOne('/api/categories/biology');
      expect(req.request.method).toBe('DELETE');
      req.flush({ message: 'ok' });
      await refetch([LIST[0], LIST[2]]);
      expect(slugs()).toEqual(['physics', 'chem']);
    });

    it('declining the confirmation deletes nothing', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      await click(btn('biology', 'delete'));
      http.expectNone('/api/categories/biology');
    });

    it('a rename sends the trimmed label; an unchanged or empty one sends nothing', async () => {
      const input = row('biology').querySelector<HTMLInputElement>('.label-input')!;
      input.value = 'Назва biology';
      input.dispatchEvent(new Event('change'));
      http.expectNone('/api/categories/biology');
      input.value = '   ';
      input.dispatchEvent(new Event('change'));
      await settle(fixture, 2);
      expect(input.value).toBe('Назва biology');
      expect(root.querySelector('[data-role="error"]')?.textContent).toContain('порожньою');
      input.value = '  Біологія ';
      input.dispatchEvent(new Event('change'));
      const rename = http.expectOne('/api/categories/biology');
      expect(rename.request.body).toEqual({ label: 'Біологія' });
      rename.flush({ category: LIST[1] });
      await refetch(LIST);
    });

    it('an icon choice is sent as the category\'s icon', async () => {
      row('biology').querySelector<HTMLButtonElement>('vl-icon-picker .trigger')!.click();
      await settle(fixture, 2);
      row('biology').querySelector<HTMLButtonElement>('vl-icon-picker .option[aria-label="dna"]')!.click();
      const icon = http.expectOne('/api/categories/biology');
      expect(icon.request.body).toEqual({ icon: 'dna' });
      icon.flush({ category: LIST[1] });
      await refetch(LIST);
    });
  });

  it('a failed first load shows the message and an empty table', async () => {
    const second = TestBed.createComponent(CategoriesComponent);
    second.detectChanges();
    http.expectOne('/api/categories').flush({ error: 'Немає зв\'язку' }, { status: 500, statusText: 'x' });
    await settle(second);
    expect((second.nativeElement as HTMLElement).querySelector('[data-role="error"]')?.textContent).toContain('Немає зв\'язку');
  });
});
