// path: src/app/pages/admin/scenario-edit/scenario-edit.component.spec.ts
//
// Test-plan scenario 213 (DW-5.5): one scenario's page keeps unsaved Метадані edits across a visit to another
// tab, asks before leaving them behind, and refetches after a save.

import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { AdminSession } from '../../../services/admin-session.service';
import { AdminService } from '../../../services/admin.service';
import { UNSAVED_PROMPT, unsavedChangesGuard } from '../admin-guards';
import { adminRow } from '../admin-testing';
import { ScenarioEditComponent } from './scenario-edit.component';

@Component({ standalone: true, template: 'list' })
class StubList {}

const CATEGORIES = [{ slug: 'physics', label: 'Фізика', icon: 'atom', sortOrder: 10, isVisible: true }];

describe('ScenarioEditComponent', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;
  let page: ScenarioEditComponent;
  let root: HTMLElement;

  beforeEach(async () => {
    sessionStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'admin/scenarios', component: StubList },
          { path: 'admin/scenarios/:id/:tab', component: ScenarioEditComponent, canDeactivate: [unsavedChangesGuard] },
        ]),
        provideHttpClient(), provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
    const signedIn = TestBed.inject(AdminSession).signIn('code');
    http.expectOne('/api/auth/me').flush({ role: 'author', label: 'Олена', keyId: 4 });
    await signedIn;
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => {
    http.verify();
    vi.restoreAllMocks();
  });

  async function settle(rounds = 8): Promise<void> {
    for (let i = 0; i < rounds; i++) {
      await Promise.resolve();
      harness.detectChanges();
    }
  }

  /** Opens the page and answers the list and the form's two lookups. */
  async function open(url = '/admin/scenarios/alpha/meta', rows = [adminRow('alpha', { title: 'Альфа', status: 'draft' })]): Promise<void> {
    page = await harness.navigateByUrl(url, ScenarioEditComponent);
    root = harness.routeNativeElement as HTMLElement;
    harness.detectChanges();
    http.expectOne('/api/admin/scenarios').flush({ scenarios: rows });
    await settle();
    if (rows.length) {
      http.expectOne('/api/categories').flush({ categories: CATEGORIES });
      http.expectOne('/api/config').flush({ maxArchiveBytes: 1, preview: { maxBytes: 1024, minWidth: 800, aspect: 1.6 } });
    }
    await settle();
  }

  const q = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const qa = (selector: string) => [...root.querySelectorAll<HTMLElement>(selector)];
  const title = () => q<HTMLInputElement>('#meta-title');
  const metaPanel = () => q('.tab-panel');

  function type(el: HTMLElement, value: string): void {
    (el as HTMLInputElement).value = value;
    el.dispatchEvent(new Event('input'));
    harness.detectChanges();
  }

  /** Moves to another tab of the same scenario. */
  async function goToTab(tab: string): Promise<void> {
    await harness.navigateByUrl(`/admin/scenarios/alpha/${tab}`);
    await settle(2);
  }

  describe('the page', () => {
    it('DW-5.5 shows the title, status, author line, four tabs and the Метадані form', async () => {
      await open('/admin/scenarios/alpha/meta', [adminRow('alpha', { title: 'Альфа', status: 'review', author: 'Олена', version: '2.1.0', updatedAt: '2026-03-12T10:00:00Z' })]);
      expect(q('h1').textContent).toBe('Альфа');
      expect(q('.status-pill').textContent).toContain('На перевірці');
      expect(q('.subline').textContent).toBe('Олена · 2.1.0 · оновлено 12 бер 2026');
      expect(qa('.tab').map(el => el.textContent?.trim())).toEqual(['Метадані', 'Файл', 'Перевірка', 'Публікація']);
      expect(qa('.tab.on').map(el => el.textContent?.trim())).toEqual(['Метадані']);
      expect(metaPanel().hasAttribute('hidden')).toBe(false);
      expect(title().value).toBe('Альфа');
    });

    it('offers the viewer preview of the current archive and returns to this tab', async () => {
      await open();
      const href = q<HTMLAnchorElement>('.viewer-preview').getAttribute('href')!;
      expect(href).toBe(`/play/alpha?draft=${'a'.repeat(64)}&returnTo=%2Fadmin%2Fscenarios%2Falpha%2Fmeta`);
    });

    it('has no viewer preview while there is no archive', async () => {
      await open('/admin/scenarios/alpha/meta', [adminRow('alpha', { currentVersion: null, archiveSha256: null })]);
      expect(qa('.viewer-preview').length).toBe(0);
    });

    it('says so for a scenario that does not exist or is not the caller\'s', async () => {
      await open('/admin/scenarios/nope/meta', []);
      expect(root.textContent).toContain('Сценарій не знайдено');
      expect(qa('.tabs').length).toBe(0);
    });

    it('shows the failure and can retry', async () => {
      page = await harness.navigateByUrl('/admin/scenarios/alpha/meta', ScenarioEditComponent);
      root = harness.routeNativeElement as HTMLElement;
      harness.detectChanges();
      http.expectOne('/api/admin/scenarios').flush({ error: 'Помилка сервера' }, { status: 500, statusText: 'err' });
      await settle();
      expect(q('.banner-error').textContent).toContain('Помилка сервера');

      q<HTMLButtonElement>('.btn-secondary').click();
      http.expectOne('/api/admin/scenarios').flush({ scenarios: [adminRow('alpha')] });
      await settle();
      http.expectOne('/api/categories').flush({ categories: CATEGORIES });
      http.expectOne('/api/config').flush({});
      await settle();
      expect(q('h1').textContent).toBe('Сценарій alpha');
    });

    it('an unknown tab segment shows the Метадані tab', async () => {
      await open('/admin/scenarios/alpha/whatever');
      expect(qa('.tab.on').map(el => el.textContent?.trim())).toEqual(['Метадані']);
    });

    it('keeps a 300-character unbroken title in the header', async () => {
      await open('/admin/scenarios/alpha/meta', [adminRow('alpha', { title: 'Ж'.repeat(300) })]);
      expect(q('h1').textContent?.length).toBe(300);
    });

    it('DW-5.5 a code the server stops accepting ends the session', async () => {
      page = await harness.navigateByUrl('/admin/scenarios/alpha/meta', ScenarioEditComponent);
      harness.detectChanges();
      http.expectOne('/api/admin/scenarios').flush({ error: 'Невірний токен' }, { status: 403, statusText: 'Forbidden' });
      await settle();
      const admin = TestBed.inject(AdminService);
      expect(admin.isAuthenticated()).toBe(false);
      expect(admin.endedReason()).toMatch(/відкликаний/);
    });
  });

  describe('unsaved edits', () => {
    it('DW-5.5 survive Метадані -> Публікація -> Метадані, with one list request in all', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false); // a tab switch must not even ask
      await open();
      type(title(), 'Назва, якої ще немає на сервері');
      expect(page.hasUnsavedChanges()).toBe(true);

      await goToTab('publish');
      http.expectOne('/api/scenarios/alpha/history').flush([]);
      await settle();
      expect(metaPanel().hasAttribute('hidden')).toBe(true);
      expect(root.querySelector('vl-scenario-publish')).not.toBeNull();
      expect(page.hasUnsavedChanges()).toBe(true);

      await goToTab('meta');
      expect(metaPanel().hasAttribute('hidden')).toBe(false);
      expect(root.querySelector('vl-scenario-publish')).toBeNull();
      expect(title().value).toBe('Назва, якої ще немає на сервері');
      expect(page.hasUnsavedChanges()).toBe(true);
      expect(confirm).not.toHaveBeenCalled();
      expect(TestBed.inject(Router).url).toBe('/admin/scenarios/alpha/meta');
    });

    it('DW-5.5 leaving asks first; staying keeps the page and the edits', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      await open();
      type(title(), 'Чернетка назви');

      await harness.navigateByUrl('/admin/scenarios');
      expect(confirm).toHaveBeenCalledWith(UNSAVED_PROMPT);
      expect(TestBed.inject(Router).url).toBe('/admin/scenarios/alpha/meta');
      expect(title().value).toBe('Чернетка назви');
    });

    it('DW-5.5 leaving after a yes goes through', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      await open();
      type(title(), 'Чернетка назви');
      await harness.navigateByUrl('/admin/scenarios');
      expect(TestBed.inject(Router).url).toBe('/admin/scenarios');
    });

    it('DW-5.5 a clean page leaves without asking', async () => {
      const confirm = vi.spyOn(window, 'confirm');
      await open();
      await harness.navigateByUrl('/admin/scenarios');
      expect(confirm).not.toHaveBeenCalled();
      expect(TestBed.inject(Router).url).toBe('/admin/scenarios');
    });

    it('DW-5.5 the browser is asked to confirm a reload or close only while there are edits', async () => {
      await open();
      const clean = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(clean);
      expect(clean.defaultPrevented).toBe(false);

      type(title(), 'Щось нове');
      const dirty = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(dirty);
      expect(dirty.defaultPrevented).toBe(true);
    });
  });

  describe('after a save', () => {
    it('DW-5.5 refetches the row, shows the saved values and is clean again', async () => {
      await open();
      type(title(), 'Збережена назва');
      q<HTMLFormElement>('form').dispatchEvent(new Event('submit'));
      await settle(2);

      const put = http.expectOne('/api/catalog/alpha');
      expect(put.request.body).toEqual({ title: 'Збережена назва' });
      put.flush({ message: 'ok' });
      await settle(2);
      http.expectOne('/api/admin/scenarios').flush({ scenarios: [adminRow('alpha', { title: 'Збережена назва' })] });
      await settle();

      expect(q('h1').textContent).toBe('Збережена назва');
      expect(title().value).toBe('Збережена назва');
      expect(page.hasUnsavedChanges()).toBe(false);
    });
  });
});
