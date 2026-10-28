// path: src/app/pages/admin/upload-wizard/upload-wizard.component.spec.ts
//
// Test-plan scenario 220 (DW-6.3): the four-step wizard turns a ZIP into a draft with the manifest's fields
// prefilled, lets the user edit them, shows the checks and saves or submits; an oversize archive is refused
// before upload, a cancel leaves no draft, and leaving after step 1 keeps the draft that already exists.

import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';

import { AdminRole, FromArchiveResult } from '../../../models/admin.model';
import { AdminSession } from '../../../services/admin-session.service';
import { ToastService } from '../../../ui/toast/toast.service';
import { adminRow, settle, versionRow } from '../admin-testing';
import { UploadWizardComponent } from './upload-wizard.component';

@Component({ standalone: true, template: 'stub' })
class StubPage {}

const MIB = 1024 * 1024;
const CATEGORIES = [{ slug: 'biology', label: 'Біологія', icon: 'dna', sortOrder: 10, isVisible: true }];
const CONFIG = { maxArchiveBytes: 200 * MIB, preview: { maxBytes: 1024, minWidth: 800, aspect: 1.6 } };

function created(overrides: Partial<FromArchiveResult> = {}, title = 'Модель клітини'): FromArchiveResult {
  return {
    scenario: adminRow('cell-model', { title, description: 'Будова клітини', category: 'biology', categoryLabel: 'Біологія', imageUrl: '', version: '0.9.0', status: 'draft' }),
    version: versionRow(1, 'current', { manifestId: 'cell-model', manifestVersion: '0.9.0', engineVersion: 'WebEngineTS 0.4' }),
    manifest: { id: 'cell-model', name: title, version: '0.9.0', entryPoint: 'main.js', resourceCount: 26, engineVersion: 'WebEngineTS 0.4' },
    warnings: [],
    ...overrides,
  };
}

describe('UploadWizardComponent', () => {
  let fixture: ComponentFixture<UploadWizardComponent>;
  let root: HTMLElement;
  let http: HttpTestingController;
  let router: Router;
  let navigate: ReturnType<typeof vi.spyOn>;
  let navigateByUrl: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'admin/scenarios', component: StubPage }, { path: 'admin/scenarios/:id/:tab', component: StubPage }]),
        provideHttpClient(), provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    navigateByUrl = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
  });

  afterEach(() => http.verify());

  async function open(role: AdminRole = 'author'): Promise<void> {
    const signedIn = TestBed.inject(AdminSession).signIn('code');
    http.expectOne('/api/auth/me').flush({ role, label: 'Олена', keyId: 4 });
    await signedIn;
    fixture = TestBed.createComponent(UploadWizardComponent);
    root = fixture.nativeElement;
    fixture.detectChanges();
    http.expectOne('/api/config').flush(CONFIG);
    await settle(fixture, 2);
  }

  const q = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const qa = (selector: string) => [...root.querySelectorAll<HTMLElement>(selector)];
  const stepButton = (n: number) => q<HTMLButtonElement>(`[data-step="${n}"]`);
  const action = (name: string) => q<HTMLButtonElement>(`[data-action="${name}"]`);
  const panelVisible = (selector: string) => !q(selector).closest('.step-panel')!.hasAttribute('hidden');

  function pick(file: File): void {
    const input = q<HTMLInputElement>('[data-role="archive-input"]');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
  }

  /** Uploads a ZIP and answers from-archive; the Метадані form then asks for its categories and limits. */
  async function upload(result: FromArchiveResult = created()): Promise<void> {
    pick(new File([new Uint8Array(1000)], 'cell-model-v0.9.0.zip'));
    await settle(fixture, 2);
    http.expectOne('/api/scenarios/from-archive').flush(result);
    await settle(fixture, 3);
    http.expectOne('/api/categories').flush({ categories: CATEGORIES });
    http.expectOne('/api/config').flush(CONFIG);
    await settle(fixture);
  }

  function type(selector: string, value: string): void {
    const el = q<HTMLInputElement>(selector);
    el.value = value;
    el.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  describe('step 1: the file', () => {
    it('DW-6.3 starts with a drop zone, no draft, and the later steps locked', async () => {
      await open();
      expect(q('.dropzone')).toBeTruthy();
      expect([2, 3, 4].map(n => stepButton(n).disabled)).toEqual([true, true, true]);
      expect(action('next').disabled).toBe(true);
      expect(q('h1').textContent).toBe('Новий сценарій');
      expect(root.querySelector('[data-role="manifest"]')).toBeNull();
    });

    it('DW-6.3 a ZIP is posted to from-archive and becomes a draft with what the manifest said', async () => {
      await open();
      pick(new File([new Uint8Array(1000)], 'cell-model-v0.9.0.zip'));
      await settle(fixture, 2);
      const req = http.expectOne('/api/scenarios/from-archive');
      expect(req.request.method).toBe('POST');
      expect(req.request.headers.get('Authorization')).toBe('Bearer code');
      expect((req.request.body as FormData).get('archive')).toBeInstanceOf(File);
      req.flush(created());
      await settle(fixture, 3);
      http.expectOne('/api/categories').flush({ categories: CATEGORIES });
      http.expectOne('/api/config').flush(CONFIG);
      await settle(fixture);

      expect(q('[data-role="uploaded"]').textContent).toContain('cell-model');
      const facts = qa('[data-role="manifest"] > div').map(d => d.textContent!.replace(/\s+/g, ' ').trim());
      expect(facts).toEqual([
        'Назва в манифестіМодель клітини', 'id у манифестіcell-model', 'Версія0.9.0', 'Точка входуmain.js', 'Ресурсів26', 'Версія рушіяWebEngineTS 0.4',
      ]);
      expect(q('h1').textContent).toBe('Модель клітини');
      expect(q('.status-pill').textContent).toContain('Чернетка');
      expect(TestBed.inject(ToastService).message()).toBe('Чернетку створено');
      expect([2, 3, 4].map(n => stepButton(n).disabled)).toEqual([false, false, false]);
    });

    it('DW-6.3 a manifest name with markup renders as text everywhere, never as elements', async () => {
      await open();
      const hostile = '<script>alert(1)</script><img src=x onerror=alert(2)>';
      await upload(created({ warnings: ['<b>увага</b>'] }, hostile));
      expect(q('h1').textContent).toBe(hostile);
      expect(q('[data-role="manifest"]').textContent).toContain(hostile);
      expect(root.querySelector('.banner-warn')!.textContent).toBe('<b>увага</b>');
      expect(root.querySelector('script')).toBeNull();
      expect(root.querySelector('img[src="x"]')).toBeNull();
      expect(root.querySelector('b')).toBeNull();
      stepButton(2).click();
      fixture.detectChanges();
      expect(q<HTMLInputElement>('#meta-title').value).toBe(hostile);
    });

    it('DW-6.3 an archive over the cap is refused before any request', async () => {
      await open();
      pick({ name: 'huge.zip', size: 300 * MIB } as File);
      await settle(fixture);
      http.expectNone('/api/scenarios/from-archive');
      expect(q('.banner-error').textContent).toContain('завеликий');
      expect(q('h1').textContent).toBe('Новий сценарій');
    });

    it('DW-6.3 cancelling the upload aborts the request and leaves no draft', async () => {
      await open();
      pick(new File([new Uint8Array(1000)], 'cell-model.zip'));
      await settle(fixture, 2);
      const req = http.expectOne('/api/scenarios/from-archive');

      q<HTMLButtonElement>('[data-action="cancel-upload"]').click();
      await settle(fixture);

      expect(req.cancelled).toBe(true);
      expect(root.querySelector('[data-role="uploaded"]')).toBeNull();
      expect(stepButton(2).disabled).toBe(true);
      expect(q('.dropzone')).toBeTruthy();
    });

    it('DW-6.3 a 409 (the id is taken) is shown as the server said it and no draft appears', async () => {
      await open();
      pick(new File([new Uint8Array(10)], 'cell-model.zip'));
      await settle(fixture, 2);
      http.expectOne('/api/scenarios/from-archive').flush({ error: 'Сценарій з id "cell-model" вже існує' }, { status: 409, statusText: 'Conflict' });
      await settle(fixture);
      expect(q('.banner-error').textContent).toContain('вже існує');
      expect(root.querySelector('[data-role="uploaded"]')).toBeNull();
    });

    it('DW-6.3 a 400 for a bad manifest id is shown', async () => {
      await open();
      pick(new File([new Uint8Array(10)], 'old.zip'));
      await settle(fixture, 2);
      http.expectOne('/api/scenarios/from-archive').flush({ error: 'Ідентифікатор у manifest.json не підходить для каталогу' }, { status: 400, statusText: 'Bad' });
      await settle(fixture);
      expect(q('.banner-error').textContent).toContain('не підходить для каталогу');
    });

    it('DW-6.3 once the draft exists the same zone replaces its archive and refreshes the row', async () => {
      await open();
      await upload();
      pick(new File([new Uint8Array(500)], 'cell-model-v0.9.1.zip'));
      await settle(fixture, 2);
      const req = http.expectOne('/api/scenarios/cell-model/archive');
      expect((req.request.body as FormData).get('archive')).toBeInstanceOf(File);
      req.flush({ id: 'cell-model', sha256: 's', bytes: 500, url: '/x', deduplicated: false, manifestId: 'cell-model', warnings: [] });
      await settle(fixture, 3);
      http.expectOne('/api/admin/scenarios').flush({ scenarios: [adminRow('cell-model', { title: 'Модель клітини', version: '0.9.1' })] });
      http.expectOne('/api/scenarios/cell-model/versions').flush({ versions: [versionRow(2, 'current', { manifestVersion: '0.9.1' })] });
      await settle(fixture);

      expect(TestBed.inject(ToastService).message()).toBe('Архів замінено');
      const facts = q('[data-role="manifest"]').textContent!;
      expect(facts).toContain('0.9.1');
      expect(facts).not.toContain('Точка входу'); // only the first upload reports it
    });
  });

  describe('steps 2 and 3: metadata and checks', () => {
    it('DW-6.3 step 2 is the editor\'s form with the manifest\'s values in it', async () => {
      await open();
      await upload();
      expect(panelVisible('#meta-title')).toBe(false);
      action('next').click();
      fixture.detectChanges();
      expect(panelVisible('#meta-title')).toBe(true);
      expect(q<HTMLInputElement>('#meta-title').value).toBe('Модель клітини');
      expect(q<HTMLInputElement>('#meta-id').value).toBe('cell-model');
      expect(q<HTMLInputElement>('#meta-version').value).toBe('0.9.0');
      expect(q<HTMLTextAreaElement>('#meta-description').value).toBe('Будова клітини');
    });

    it('DW-6.3 edits survive a trip to another step and are reported as unsaved', async () => {
      await open();
      await upload();
      stepButton(2).click();
      fixture.detectChanges();
      type('#meta-title', 'Клітина');
      expect(fixture.componentInstance.hasUnsavedChanges()).toBe(true);

      stepButton(3).click();
      fixture.detectChanges();
      stepButton(2).click();
      fixture.detectChanges();
      expect(q<HTMLInputElement>('#meta-title').value).toBe('Клітина');
    });

    it('DW-6.3 step 3 shows the checks stored with the first version', async () => {
      await open();
      await upload(created({ version: versionRow(1, 'current', { checks: { ok: true, items: [
        { level: 'ok', label: 'Маніфест', note: 'id "cell-model"' }, { level: 'warning', label: 'Версія рушія', note: 'не вказано' },
      ] } }) }));
      stepButton(3).click();
      fixture.detectChanges();
      expect(q('.verdict').textContent).toContain('1 зауваження');
      expect(qa('[data-role="check-item"]').length).toBe(2);
    });

    it('step 3 says so when no checks were stored', async () => {
      await open();
      await upload(created({ version: versionRow(1, 'current', { checks: null }) }));
      stepButton(3).click();
      fixture.detectChanges();
      expect(q('[data-role="no-checks"]')).toBeTruthy();
    });

    it('Назад and Далі walk the steps and stop at the ends', async () => {
      await open();
      await upload();
      for (let i = 0; i < 5; i++) { action('next').click(); fixture.detectChanges(); }
      expect(q('[data-step="4"]').getAttribute('aria-current')).toBe('step');
      expect(action('next').hidden).toBe(true);
      for (let i = 0; i < 5; i++) { action('back').click(); fixture.detectChanges(); }
      expect(q('[data-step="1"]').getAttribute('aria-current')).toBe('step');
      expect(action('back').hidden).toBe(true);
    });
  });

  describe('step 4: save or submit', () => {
    async function toLastStep(role: AdminRole = 'author'): Promise<void> {
      await open(role);
      await upload();
      stepButton(4).click();
      fixture.detectChanges();
    }

    it('DW-6.3 lists what is ready and what is missing (no preview yet)', async () => {
      await toLastStep();
      const items = qa('[data-role="readiness"] li').map(li => li.textContent!.trim());
      expect(items).toContain('Короткий опис заповнено');
      expect(items).toContain('Немає превʼю');
      expect(root.textContent).toContain('Надіслати можна й так');
    });

    it('DW-6.3 Надіслати на модерацію posts submit, then opens the scenario on Публікація', async () => {
      await toLastStep();
      action('submit').click();
      const req = http.expectOne('/api/scenarios/cell-model/submit');
      expect(req.request.method).toBe('POST');
      req.flush({ id: 'cell-model', status: 'review', isPublished: false, moderatorNote: null, submittedAt: 'x' });
      await settle(fixture, 4);
      expect(navigate).toHaveBeenCalledWith(['/admin/scenarios', 'cell-model', 'publish']);
      expect(TestBed.inject(ToastService).message()).toBe('Надіслано на модерацію');
    });

    it('DW-6.3 Зберегти чернетку sends no transition and goes to the list, where the draft already is', async () => {
      await toLastStep();
      action('save-draft').click();
      await settle(fixture, 4);
      expect(navigateByUrl).toHaveBeenCalledWith('/admin/scenarios');
      expect(TestBed.inject(ToastService).message()).toBe('Чернетку збережено');
    });

    it('DW-6.3 a moderator can also publish straight away; an author cannot', async () => {
      await toLastStep('moderator');
      expect(action('approve')).toBeTruthy();
      action('approve').click();
      http.expectOne('/api/scenarios/cell-model/approve').flush({ id: 'cell-model', status: 'published', isPublished: true, moderatorNote: null, submittedAt: null });
      await settle(fixture, 4);
      expect(navigate).toHaveBeenCalledWith(['/admin/scenarios', 'cell-model', 'publish']);
    });

    it('DW-6.3 an author has no publish button', async () => {
      await toLastStep('author');
      expect(root.querySelector('[data-action="approve"]')).toBeNull();
    });

    it('DW-6.3 unsaved metadata blocks submit and save with a message, and sends nothing', async () => {
      await open();
      await upload();
      stepButton(2).click();
      fixture.detectChanges();
      type('#meta-title', 'Клітина');
      stepButton(4).click();
      fixture.detectChanges();

      action('submit').click();
      await settle(fixture, 2);
      expect(q('.banner-error').textContent).toContain('збережіть зміни');
      action('save-draft').click();
      await settle(fixture, 2);
      expect(navigateByUrl).not.toHaveBeenCalled();
    });

    it('DW-6.3 a refusal from the server is shown and the wizard stays', async () => {
      await toLastStep();
      action('submit').click();
      http.expectOne('/api/scenarios/cell-model/submit').flush({ error: 'Спершу завантажте архів' }, { status: 409, statusText: 'Conflict' });
      await settle(fixture, 3);
      expect(q('.banner-error').textContent).toContain('Спершу завантажте архів');
      expect(action('submit').disabled).toBe(false);
    });
  });

  describe('leaving', () => {
    it('DW-6.3 leaving after step 1 keeps the draft: nothing is deleted or withdrawn', async () => {
      await open();
      await upload();
      fixture.destroy();
      http.expectNone(req => req.method === 'DELETE');
      http.expectNone(req => req.method !== 'GET');
    });

    it('there is nothing unsaved before a draft exists', async () => {
      await open();
      expect(fixture.componentInstance.hasUnsavedChanges()).toBe(false);
    });

    it('leaving while an upload is in flight aborts it', async () => {
      await open();
      pick(new File([new Uint8Array(1000)], 'cell-model.zip'));
      await settle(fixture, 2);
      const req = http.expectOne('/api/scenarios/from-archive');
      fixture.destroy();
      expect(req.cancelled).toBe(true);
    });
  });
});
