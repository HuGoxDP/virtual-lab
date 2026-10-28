// path: src/app/pages/admin/scenario-checks/scenario-checks.component.spec.ts
//
// Test-plan scenario 219 (DW-6.2): the Перевірка tab shows the stored static checks, re-runs them, and reads the
// stored test run against the norms (<= 5 s, >= 30 FPS, <= 1 GB, 0 errors). The test run itself is Phase 7's:
// the tab only raises `runTest`.

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { AdminRole, ScenarioVersion, TestRun } from '../../../models/admin.model';
import { AdminScenario } from '../../../models/scenario.model';
import { AdminService } from '../../../services/admin.service';
import { ToastService } from '../../../ui/toast/toast.service';
import { adminRow, settle, versionRow } from '../admin-testing';
import { ScenarioChecksComponent } from './scenario-checks.component';

const GIB = 1024 ** 3;
const GOOD_RUN: TestRun = { timeToFirstFrameMs: 3800, avgFps: 58, gpuMemoryBytes: 1.4 * GIB, consoleErrors: 0, ranAt: '2026-03-12T09:14:00Z', ranBy: 'Марія', engineBuild: '0.1.0-local.1', userAgent: 'Mozilla/5.0 <b>x</b>' };

describe('ScenarioChecksComponent', () => {
  let fixture: ComponentFixture<ScenarioChecksComponent>;
  let root: HTMLElement;
  let http: HttpTestingController;
  let changed: number;
  let ran: ScenarioVersion[];

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    TestBed.inject(AdminService).setToken('code');
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function open(role: AdminRole, versions: ScenarioVersion[], scenario: AdminScenario = adminRow('alpha'), testEnabled = false): Promise<void> {
    fixture = TestBed.createComponent(ScenarioChecksComponent);
    changed = 0;
    ran = [];
    fixture.componentInstance.changed.subscribe(() => changed++);
    fixture.componentInstance.runTest.subscribe(v => ran.push(v));
    fixture.componentRef.setInput('scenario', scenario);
    fixture.componentRef.setInput('role', role);
    fixture.componentRef.setInput('testEnabled', testEnabled);
    root = fixture.nativeElement;
    fixture.detectChanges();
    http.expectOne(`/api/scenarios/${scenario.id}/versions`).flush({ versions });
    await settle(fixture);
  }

  const q = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const qa = (selector: string) => [...root.querySelectorAll<HTMLElement>(selector)];
  const normRows = () => qa('[data-role="norms"] tbody tr').map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent!.replace(/\s+/g, ' ').trim()));

  describe('the stored checks', () => {
    it('DW-6.2 shows the verdict and the stored items', async () => {
      await open('author', [versionRow(1, 'current', { checks: { ok: true, items: [
        { level: 'ok', label: 'Маніфест', note: 'id "alpha"' }, { level: 'warning', label: 'Розмір архіву понад 50 МБ', note: '96,7 МБ' },
      ] } })]);
      expect(q('.verdict').textContent).toContain('1 зауваження');
      expect(qa('[data-role="check-item"]').length).toBe(2);
      expect(root.textContent).toContain('Розмір архіву понад 50 МБ');
    });

    it('DW-6.2 a version with no stored checks says so instead of looking clean', async () => {
      await open('author', [versionRow(1, 'current', { checks: null })]);
      expect(q('[data-role="unchecked"]').textContent).toContain('збереженої перевірки немає');
      expect(root.querySelector('.verdict')).toBeNull();
    });

    it('DW-6.2 no archive at all: nothing to check, no re-run button', async () => {
      await open('author', [], adminRow('alpha', { currentVersion: null }));
      expect(root.textContent).toContain('Архіву ще немає');
      expect(root.querySelector('[data-action="rerun"]')).toBeNull();
    });

    it('DW-6.2 Перевірити ще раз posts to the version, shows the new result and tells the parent', async () => {
      await open('author', [versionRow(7, 'current', { checks: { ok: true, items: [{ level: 'ok', label: 'Старий', note: '' }] } })]);
      q<HTMLButtonElement>('[data-action="rerun"]').click();
      const req = http.expectOne('/api/scenarios/alpha/versions/7/checks');
      expect(req.request.method).toBe('POST');
      expect(req.request.headers.get('Authorization')).toBe('Bearer code');
      req.flush({ ok: false, items: [{ level: 'error', label: 'Файли', note: 'порожньо' }] });
      await settle(fixture);

      expect(q('.verdict').textContent).toContain('1 помилка');
      expect(root.textContent).not.toContain('Старий');
      expect(changed).toBe(1);
      expect(TestBed.inject(ToastService).message()).toBe('Перевірку виконано');
    });

    it('DW-6.2 a re-run that fails keeps the stored result and shows the server\'s words', async () => {
      await open('author', [versionRow(7, 'current')]);
      q<HTMLButtonElement>('[data-action="rerun"]').click();
      http.expectOne('/api/scenarios/alpha/versions/7/checks').flush({ error: 'Це не ваш сценарій' }, { status: 403, statusText: 'Forbidden' });
      await settle(fixture);
      expect(q('.banner-error').textContent).toContain('Це не ваш сценарій');
      expect(root.textContent).toContain('Маніфест');
      expect(changed).toBe(0);
      expect(q<HTMLButtonElement>('[data-action="rerun"]').disabled).toBe(false);
    });

    it('a failed versions read is shown', async () => {
      fixture = TestBed.createComponent(ScenarioChecksComponent);
      fixture.componentRef.setInput('scenario', adminRow('alpha'));
      fixture.componentRef.setInput('role', 'author');
      root = fixture.nativeElement;
      fixture.detectChanges();
      http.expectOne('/api/scenarios/alpha/versions').flush({ error: 'Помилка сервера' }, { status: 500, statusText: 'err' });
      await settle(fixture);
      expect(q('.banner-error').textContent).toContain('Помилка сервера');
    });
  });

  describe('the test run against the norms', () => {
    it('DW-6.2 shows each figure with its norm, marking the one outside it', async () => {
      await open('moderator', [versionRow(1, 'current', { testRun: GOOD_RUN })]);
      expect(normRows()).toEqual([
        ['Час до першого кадру', '3,8 с — у нормі', 'до 5 с'],
        ['Середній FPS', '58 — у нормі', 'від 30'],
        ['Памʼять GPU', '1,4 ГБ — поза нормою', 'до 1 ГБ'],
        ['Помилки в консолі', '0 — у нормі', '0'],
      ]);
      expect(qa('[data-role="norms"] td.bad').map(td => td.closest('tr')!.dataset['key'])).toEqual(['gpu']);
      expect(qa('[data-role="norms"] td.ok').length).toBe(3);
    });

    it('DW-6.2 shows who ran it and when, and the user agent as text', async () => {
      await open('moderator', [versionRow(1, 'current', { testRun: GOOD_RUN })]);
      expect(q('.meta').textContent).toContain('виконав(ла) Марія');
      expect(root.textContent).toContain('Mozilla/5.0 <b>x</b>');
      expect(root.querySelector('b')).toBeNull();
    });

    it('DW-6.2 a failed run shows its error and no figures', async () => {
      await open('moderator', [versionRow(1, 'current', { testRun: { error: 'WebGL 2.0 недоступний <script>', ranBy: 'Марія' } })]);
      expect(q('[data-role="run-error"]').textContent).toContain('WebGL 2.0 недоступний <script>');
      expect(root.querySelector('[data-role="norms"]')).toBeNull();
      expect(root.querySelector('script')).toBeNull();
    });

    it('DW-6.2 no run yet: an author is told a moderator does it, a moderator is not', async () => {
      await open('author', [versionRow(1, 'current')]);
      expect(q('[data-role="no-run"]').textContent).toContain('Його виконує модератор');
      fixture.destroy();
      await open('moderator', [versionRow(1, 'current')]);
      expect(q('[data-role="no-run"]').textContent).not.toContain('Його виконує модератор');
    });

    it('DW-6.2 an author sees the results but has no button to run a test', async () => {
      await open('author', [versionRow(1, 'current', { testRun: GOOD_RUN })]);
      expect(normRows().length).toBe(4);
      expect(root.querySelector('[data-action="run-test"]')).toBeNull();
    });
  });

  describe('(runTest)', () => {
    it('DW-6.2 the moderator\'s button is inert until the host enables it', async () => {
      await open('moderator', [versionRow(1, 'current')]);
      const button = q<HTMLButtonElement>('[data-action="run-test"]');
      expect(button.disabled).toBe(true);
      expect(button.getAttribute('title')).toContain('наступних оновлень');
      button.click();
      expect(ran).toEqual([]);
    });

    it('DW-6.2 when enabled it raises runTest with the version on screen', async () => {
      const current = versionRow(1, 'current');
      await open('moderator', [current], adminRow('alpha'), true);
      q<HTMLButtonElement>('[data-action="run-test"]').click();
      expect(ran).toEqual([current]);
    });
  });

  describe('a pending proposal', () => {
    const versions = [versionRow(2, 'pending', { checks: { ok: false, items: [{ level: 'error', label: 'Нова проблема', note: '' }] } }),
      versionRow(1, 'current', { checks: { ok: true, items: [{ level: 'ok', label: 'Стара гаразд', note: '' }] } })];

    it('DW-6.2 offers both versions, starting on the current one, and switches', async () => {
      await open('moderator', versions);
      expect(qa('[data-choice]').map(b => b.dataset['choice'])).toEqual(['current', 'pending']);
      expect(root.textContent).toContain('Стара гаразд');

      q<HTMLButtonElement>('[data-choice="pending"]').click();
      await settle(fixture, 2);
      expect(root.textContent).toContain('Нова проблема');
      expect(root.textContent).not.toContain('Стара гаразд');
    });

    it('DW-6.2 re-running while the pending one is shown targets the pending version', async () => {
      await open('moderator', versions);
      q<HTMLButtonElement>('[data-choice="pending"]').click();
      await settle(fixture, 2);
      q<HTMLButtonElement>('[data-action="rerun"]').click();
      http.expectOne('/api/scenarios/alpha/versions/2/checks').flush({ ok: true, items: [{ level: 'ok', label: 'Тепер гаразд', note: '' }] });
      await settle(fixture);
      expect(root.textContent).toContain('Тепер гаразд');
    });

    it('with no pending version there is no switch', async () => {
      await open('moderator', [versionRow(1, 'current')]);
      expect(root.querySelector('[data-choice]')).toBeNull();
    });
  });

  describe('switching to another scenario', () => {
    it('DW-6.2 a response for the scenario the user left is ignored', async () => {
      fixture = TestBed.createComponent(ScenarioChecksComponent);
      fixture.componentRef.setInput('scenario', adminRow('alpha'));
      fixture.componentRef.setInput('role', 'moderator');
      root = fixture.nativeElement;
      fixture.detectChanges();
      const late = http.expectOne('/api/scenarios/alpha/versions');

      fixture.componentRef.setInput('scenario', adminRow('beta'));
      fixture.detectChanges();
      await settle(fixture, 2);
      const beta = http.expectOne('/api/scenarios/beta/versions');

      late.flush({ versions: [versionRow(9, 'current', { checks: { ok: true, items: [{ level: 'ok', label: 'Чужа перевірка', note: '' }] } })] });
      await settle(fixture, 3);
      expect(root.textContent).not.toContain('Чужа перевірка');

      beta.flush({ versions: [versionRow(1, 'current', { checks: { ok: true, items: [{ level: 'ok', label: 'Моя перевірка', note: '' }] } })] });
      await settle(fixture, 3);
      expect(root.textContent).toContain('Моя перевірка');
    });
  });
});
