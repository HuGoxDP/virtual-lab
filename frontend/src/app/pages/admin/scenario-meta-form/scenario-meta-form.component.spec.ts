// path: src/app/pages/admin/scenario-meta-form/scenario-meta-form.component.spec.ts
//
// Test-plan scenario 211 (DW-5.3): the Метадані form saves what changed, up to six features and a preview,
// shows the live catalog card and the readiness list, keeps `author` to moderators, and never loses edits.

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { AdminRole } from '../../../models/admin.model';
import { AdminScenario } from '../../../models/scenario.model';
import { AdminService } from '../../../services/admin.service';
import { ScenarioCardComponent } from '../../../ui/scenario-card/scenario-card.component';
import { ToastService } from '../../../ui/toast/toast.service';
import { adminRow, settle } from '../admin-testing';
import { MAX_DESCRIPTION, MAX_FEATURES, ScenarioMetaFormComponent } from './scenario-meta-form.component';

const CATEGORIES = [
  { slug: 'physics', label: 'Фізика', icon: 'atom', sortOrder: 10, isVisible: true },
  { slug: 'biology', label: 'Біологія', icon: 'dna', sortOrder: 20, isVisible: true },
];
const CONFIG = { maxArchiveBytes: 1, preview: { maxBytes: 5 * 1024 * 1024, minWidth: 800, aspect: 1.6 } };

describe('ScenarioMetaFormComponent', () => {
  let fixture: ComponentFixture<ScenarioMetaFormComponent>;
  let root: HTMLElement;
  let http: HttpTestingController;
  let saved: number;

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    TestBed.inject(AdminService).setToken('code');
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function open(scenario: AdminScenario = adminRow('alpha'), role: AdminRole = 'author'): Promise<void> {
    fixture = TestBed.createComponent(ScenarioMetaFormComponent);
    saved = 0;
    fixture.componentInstance.saved.subscribe(() => saved++);
    fixture.componentRef.setInput('scenario', scenario);
    fixture.componentRef.setInput('role', role);
    root = fixture.nativeElement;
    fixture.detectChanges();
    http.expectOne('/api/categories').flush({ categories: CATEGORIES });
    http.expectOne('/api/config').flush(CONFIG);
    await settle(fixture);
  }

  const q = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const qa = (selector: string) => [...root.querySelectorAll<HTMLElement>(selector)];

  function type(el: HTMLElement, value: string): void {
    (el as HTMLInputElement).value = value;
    el.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  const title = () => q<HTMLInputElement>('#meta-title');
  const description = () => q<HTMLTextAreaElement>('#meta-description');
  const saveButton = () => q<HTMLButtonElement>('.save');
  const rows = () => qa('.feature-row');
  const addFeature = () => q<HTMLButtonElement>('.add-feature');

  async function save(): Promise<void> {
    q<HTMLFormElement>('form').dispatchEvent(new Event('submit'));
    await settle(fixture, 2);
  }

  describe('fields', () => {
    it('DW-5.3 shows the scenario\'s values, the id and the date read-only, and the category list', async () => {
      await open(adminRow('alpha', { title: 'Альфа', version: '2.0.1', updatedAt: '2026-03-12T10:00:00Z' }));
      expect(title().value).toBe('Альфа');
      expect(q<HTMLInputElement>('#meta-version').value).toBe('2.0.1');
      expect(q<HTMLInputElement>('#meta-id').value).toBe('alpha');
      expect(q<HTMLInputElement>('#meta-id').readOnly).toBe(true);
      expect(q<HTMLInputElement>('#meta-updated').value).toBe('12 бер 2026');
      expect([...q<HTMLSelectElement>('#meta-category').options].map(o => o.text)).toEqual(['Фізика', 'Біологія']);
      expect(q<HTMLSelectElement>('#meta-category').value).toBe('physics');
    });

    it('a legacy category the list does not have stays selectable', async () => {
      await open(adminRow('alpha', { category: 'old-slug', categoryLabel: 'Стара' }));
      expect([...q<HTMLSelectElement>('#meta-category').options].map(o => o.text)).toEqual(['Стара', 'Фізика', 'Біологія']);
      expect(q<HTMLSelectElement>('#meta-category').value).toBe('old-slug');
    });

    it('DW-5.3 the short description counter runs from 0 / 160 and turns on at 161 with Save blocked', async () => {
      await open(adminRow('alpha', { description: '' }));
      expect(q('.counter').textContent?.trim()).toBe('0 / 160');

      type(description(), 'а'.repeat(MAX_DESCRIPTION));
      expect(q('.counter').textContent?.trim()).toBe('160 / 160');
      expect(q('.counter').classList.contains('over')).toBe(false);
      expect(saveButton().disabled).toBe(false);

      type(description(), 'а'.repeat(MAX_DESCRIPTION + 1));
      expect(q('.counter').classList.contains('over')).toBe(true);
      expect(saveButton().disabled).toBe(true);
      expect(q('.problems').textContent).toContain('довший за 160');
    });

    it('DW-5.3 author is read-only for an author and editable for a moderator', async () => {
      await open(adminRow('alpha', { author: 'Олена' }), 'author');
      expect(q<HTMLInputElement>('#meta-author').readOnly).toBe(true);
      expect(root.textContent).toContain('Імʼя автора змінює модератор');
      fixture.destroy();

      await open(adminRow('alpha', { author: 'Олена' }), 'moderator');
      expect(q<HTMLInputElement>('#meta-author').readOnly).toBe(false);
      expect(root.textContent).not.toContain('Імʼя автора змінює модератор');
    });
  });

  describe('saving', () => {
    it('DW-5.3 sends only what changed, then tells the parent and toasts', async () => {
      await open();
      expect(saveButton().disabled).toBe(true); // nothing changed yet

      type(title(), '  Нова назва  ');
      const pending = save();
      const req = http.expectOne('/api/catalog/alpha');
      expect(req.request.method).toBe('PUT');
      expect(req.request.body).toEqual({ title: 'Нова назва' });
      req.flush({ message: 'ok' });
      await pending;

      expect(saved).toBe(1);
      expect(TestBed.inject(ToastService).message()).toBe('Зміни збережено');
    });

    it('DW-5.3 an author never sends author, even from a tampered field; a moderator does', async () => {
      await open(adminRow('alpha', { author: 'Олена' }), 'author');
      const field = q<HTMLInputElement>('#meta-author');
      field.readOnly = false; // someone removed the attribute in dev tools
      type(field, 'Підміна');
      expect(saveButton().disabled).toBe(true);
      expect(fixture.componentInstance.dirty()).toBe(false);
      fixture.destroy();

      await open(adminRow('alpha', { author: 'Олена' }), 'moderator');
      type(q('#meta-author'), 'Олена Мельник');
      const pending = save();
      const req = http.expectOne('/api/catalog/alpha');
      expect(req.request.body).toEqual({ author: 'Олена Мельник' });
      req.flush({});
      await pending;
    });

    it('DW-5.3 a changed category sends the slug and its label', async () => {
      await open();
      const select = q<HTMLSelectElement>('#meta-category');
      select.value = 'biology';
      select.dispatchEvent(new Event('change'));
      fixture.detectChanges();

      const pending = save();
      const req = http.expectOne('/api/catalog/alpha');
      expect(req.request.body).toEqual({ category: 'biology', categoryLabel: 'Біологія' });
      req.flush({});
      await pending;
    });

    it('an empty title blocks saving and says why', async () => {
      await open();
      type(title(), '   ');
      expect(saveButton().disabled).toBe(true);
      expect(q('.problems').textContent).toContain('Вкажіть назву');
      await save();
      http.expectNone('/api/catalog/alpha');
    });

    it('a server refusal is shown as sent and keeps every edit', async () => {
      await open();
      type(title(), 'Інша');
      const pending = save();
      http.expectOne('/api/catalog/alpha').flush({ error: 'Це не ваш сценарій' }, { status: 403, statusText: 'Forbidden' });
      await pending;
      await settle(fixture);

      expect(q('.banner-error').textContent).toContain('Це не ваш сценарій');
      expect(title().value).toBe('Інша');
      expect(fixture.componentInstance.dirty()).toBe(true);
      expect(saved).toBe(0);
    });
  });

  describe('"Що всередині" (DW-5.3)', () => {
    it('starts empty with "Додати пункт" enabled', async () => {
      await open();
      expect(rows().length).toBe(0);
      expect(addFeature().disabled).toBe(false);
      expect(q('legend').textContent).toContain('0/6');
    });

    it('allows six entries and blocks the seventh', async () => {
      await open();
      for (let i = 0; i < MAX_FEATURES; i++) { addFeature().click(); fixture.detectChanges(); }
      expect(rows().length).toBe(6);
      expect(addFeature().disabled).toBe(true);
      expect(q('legend').textContent).toContain('6/6');

      addFeature().click(); // a click on a disabled button does nothing; the model refuses too
      fixture.detectChanges();
      expect(rows().length).toBe(6);
    });

    it('removes an entry by its position', async () => {
      await open(adminRow('alpha', { features: [{ icon: 'atom', title: 'А' }, { icon: 'flask', title: 'Б' }, { icon: 'leaf', title: 'В' }] }));
      q<HTMLButtonElement>('button[aria-label="Видалити пункт 2"]').click();
      fixture.detectChanges();
      expect(qa('.feature-title').map(el => (el as HTMLInputElement).value)).toEqual(['А', 'В']);
    });

    it('an entry without a title blocks saving', async () => {
      await open();
      addFeature().click();
      fixture.detectChanges();
      expect(saveButton().disabled).toBe(true);
      expect(q('.problems').textContent).toContain('заголовок');
    });

    it('sends clean entries: icon from the picker, trimmed title, an empty subtitle left out', async () => {
      await open();
      addFeature().click();
      fixture.detectChanges();

      q<HTMLButtonElement>('vl-icon-picker .trigger').click();
      fixture.detectChanges();
      qa('vl-icon-picker .option').find(o => o.title === 'flask')!.click();
      fixture.detectChanges();
      type(q('.feature-title'), '  Колба ');

      const pending = save();
      const req = http.expectOne('/api/catalog/alpha');
      expect(req.request.body).toEqual({ features: [{ icon: 'flask', title: 'Колба' }] });
      req.flush({});
      await pending;
    });

    it('limits the title to 60 and the subtitle to 90 characters in the field itself', async () => {
      await open(adminRow('alpha', { features: [{ icon: 'atom', title: 'А', subtitle: 'Б' }] }));
      expect((q('.feature-title') as HTMLInputElement).maxLength).toBe(60);
      expect((q('.feature-subtitle') as HTMLInputElement).maxLength).toBe(90);
    });
  });

  describe('preview (DW-5.3)', () => {
    const pick = (file: File) => {
      const input = q<HTMLInputElement>('.upload-preview input[type="file"]');
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new Event('change'));
    };
    const png = () => new File(['x'], 'cover.png', { type: 'image/png' });

    it('states the limits from the server config, not from a constant in the page', async () => {
      await open();
      expect(q('.cover .hint').textContent).toContain('PNG або JPG, 16:10, від 800 px завширшки, до 5 МБ');
    });

    it('uploads the file, shows the server\'s warnings, tells the parent and toasts', async () => {
      await open();
      pick(png());
      const req = http.expectOne('/api/scenarios/alpha/preview');
      expect((req.request.body as FormData).get('preview')).toBeInstanceOf(File);
      req.flush({ imageUrl: '/previews/n.png', warnings: ['Співвідношення сторін відрізняється від 16:10'] });
      await settle(fixture);

      expect(qa('.preview-warnings li').map(li => li.textContent)).toEqual(['Співвідношення сторін відрізняється від 16:10']);
      expect(saved).toBe(1);
      expect(TestBed.inject(ToastService).message()).toBe('Превʼю завантажено');
    });

    it('a refused image shows the server\'s message and changes nothing', async () => {
      await open();
      pick(png());
      http.expectOne('/api/scenarios/alpha/preview').flush({ error: 'Зображення завузьке' }, { status: 400, statusText: 'Bad Request' });
      await settle(fixture);
      expect(q('.banner-error').textContent).toContain('завузьке');
      expect(saved).toBe(0);
    });

    it('removes the cover and clears the warnings', async () => {
      await open();
      q<HTMLButtonElement>('.cover-actions .btn-ghost').click();
      http.expectOne('/api/scenarios/alpha/preview').flush({ imageUrl: '' });
      await settle(fixture);
      expect(saved).toBe(1);
      expect(qa('.preview-warnings').length).toBe(0);
    });

    it('with no cover there is nothing to remove', async () => {
      await open(adminRow('alpha', { imageUrl: '' }));
      expect(qa('.cover-actions .btn-ghost').length).toBe(0);
      expect(qa('.cover-image').length).toBe(0);
    });

    it('an upload does not wipe what was typed', async () => {
      await open();
      type(title(), 'Незбережена назва');
      pick(png());
      http.expectOne('/api/scenarios/alpha/preview').flush({ imageUrl: '/previews/n.png', warnings: [] });
      await settle(fixture);

      fixture.componentRef.setInput('scenario', adminRow('alpha', { imageUrl: '/previews/n.png' })); // the parent's refetch
      fixture.detectChanges();
      expect(title().value).toBe('Незбережена назва');
      expect(fixture.componentInstance.dirty()).toBe(true);
    });
  });

  describe('the live card (DW-5.3)', () => {
    const cardHtml = (el: HTMLElement) => el.querySelector('.live-card vl-scenario-card')?.innerHTML ?? el.innerHTML;

    it('IS the catalog card component, rendering the form\'s current values', async () => {
      await open(adminRow('alpha', { title: 'Альфа', description: 'Опис', version: '1.0.0', author: 'Олена', archiveBytes: 52_428_800 }));

      const reference = TestBed.createComponent(ScenarioCardComponent);
      reference.componentRef.setInput('scenario', {
        id: 'alpha', title: 'Альфа', description: 'Опис', category: 'physics', categoryLabel: 'Фізика',
        version: '1.0.0', author: 'Олена', imageUrl: '/previews/a.png', archiveBytes: 52_428_800,
      });
      reference.detectChanges();

      expect(q('.live-card vl-scenario-card .scenario-card')).not.toBeNull();
      expect(cardHtml(root)).toBe(reference.nativeElement.innerHTML);
    });

    it('follows typing before anything is saved', async () => {
      await open();
      type(title(), 'Нова назва картки');
      type(description(), 'Новий опис картки');
      expect(q('.live-card .title').textContent?.trim()).toBe('Нова назва картки');
      expect(q('.live-card .description').textContent?.trim()).toBe('Новий опис картки');
    });

    it('shows the prototype\'s placeholder for an empty description and a gradient for no preview', async () => {
      await open(adminRow('alpha', { description: '', imageUrl: '' }));
      expect(q('.live-card .description').textContent?.trim()).toBe('Опис не заповнено');
      expect(q('.live-card img')).toBeNull();
    });

    it('is inert: its buttons are out of reach', async () => {
      await open();
      expect(q('.live-card').hasAttribute('inert')).toBe(true);
    });

    it('shows author-supplied markup as text, never as elements', async () => {
      await open();
      type(title(), '<img src=x onerror=alert(1)>');
      expect(q('.live-card .title').textContent).toContain('<img src=x onerror=alert(1)>');
      expect(root.querySelectorAll('img[src="x"]').length).toBe(0);
    });

    it('keeps a 300-character unbroken title inside the card (clamped, wrappable)', async () => {
      await open();
      type(title(), 'Ж'.repeat(300));
      expect(q('.live-card .title').textContent?.trim().length).toBe(300);
      expect(q('.live-card .title').classList.contains('title')).toBe(true);
    });
  });

  describe('readiness (DW-5.3)', () => {
    const labels = () => qa('.readiness li').map(li => li.textContent?.trim());

    it('is all green for a complete, checked scenario', async () => {
      await open();
      expect(labels()).toEqual(['Архів перевірено', 'Короткий опис заповнено', 'Превʼю додано']);
      expect(qa('.readiness .level-ok').length).toBe(3);
    });

    it('lists a missing description, preview and archive', async () => {
      await open(adminRow('alpha', { description: '', imageUrl: '', archiveSha256: null, currentVersion: null }));
      expect(labels()).toEqual(['Немає архіву', 'Немає короткого опису', 'Немає превʼю']);
      expect(qa('.readiness .level-bad').length).toBe(3);
    });

    it('reacts to the description being typed, before saving', async () => {
      await open(adminRow('alpha', { description: '' }));
      expect(labels()[1]).toBe('Немає короткого опису');
      type(description(), 'Тепер є');
      expect(labels()[1]).toBe('Короткий опис заповнено');
    });

    it('reports check findings on the current archive', async () => {
      await open(adminRow('alpha', { currentVersion: { id: 1, sha256: 'a'.repeat(64), bytes: 1, checked: true, checks: { errors: 1, warnings: 0 } } }));
      expect(labels()[0]).toBe('Автоперевірка: 1 помилка');
    });
  });

  describe('unsaved edits (DW-5.5)', () => {
    it('are not dirty until something differs, and a reverted edit is clean again', async () => {
      await open(adminRow('alpha', { title: 'Альфа' }));
      expect(fixture.componentInstance.dirty()).toBe(false);
      type(title(), 'Бета');
      expect(fixture.componentInstance.dirty()).toBe(true);
      expect(q('.unsaved')).not.toBeNull();
      type(title(), 'Альфа');
      expect(fixture.componentInstance.dirty()).toBe(false);
    });

    it('"Скасувати зміни" restores the saved values', async () => {
      await open(adminRow('alpha', { title: 'Альфа' }));
      type(title(), 'Бета');
      q<HTMLButtonElement>('.discard').click();
      fixture.detectChanges();
      expect(title().value).toBe('Альфа');
      expect(fixture.componentInstance.dirty()).toBe(false);
    });

    it('survive a refetch of the same scenario; edits the refetch now equals are retired', async () => {
      await open(adminRow('alpha', { title: 'Альфа', version: '1.0.0' }));
      type(title(), 'Бета');
      type(q('#meta-version'), '1.1.0');

      // the server now has the title the user typed, and a version nobody typed
      fixture.componentRef.setInput('scenario', adminRow('alpha', { title: 'Бета', version: '1.0.5' }));
      fixture.detectChanges();
      await settle(fixture, 2);

      expect(title().value).toBe('Бета');
      expect(q<HTMLInputElement>('#meta-version').value).toBe('1.1.0'); // the user's edit still wins
      expect(fixture.componentInstance.dirty()).toBe(true);

      fixture.componentRef.setInput('scenario', adminRow('alpha', { title: 'Бета', version: '1.1.0' }));
      fixture.detectChanges();
      await settle(fixture, 2);
      expect(fixture.componentInstance.dirty()).toBe(false);
    });

    it('another scenario starts clean', async () => {
      await open(adminRow('alpha', { title: 'Альфа' }));
      type(title(), 'Бета');
      fixture.componentRef.setInput('scenario', adminRow('gamma', { title: 'Гамма' }));
      fixture.detectChanges();
      await settle(fixture, 2);
      expect(title().value).toBe('Гамма');
      expect(fixture.componentInstance.dirty()).toBe(false);
    });
  });
});
