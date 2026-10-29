// path: src/app/pages/admin/scenario-checks/scenario-checks.component.spec.ts
//
// Test-plan scenarios 219 (DW-6.2) and 228 (DW-7.5, the test run): the Перевірка tab shows the stored static checks, re-runs them, and reads the
// stored test run against the norms (<= 5 s, >= 30 FPS, <= 1 GB, 0 errors). The test run itself is Phase 7's:
// a moderator's test run (Phase 7) goes through a fake player host.

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { AdminRole, ScenarioVersion, TestRun } from '../../../models/admin.model';
import { AdminScenario } from '../../../models/scenario.model';
import { AdminService } from '../../../services/admin.service';
import { PLAYER_HOST_FACTORY } from '../../../player/player-config';
import { ToastService } from '../../../ui/toast/toast.service';
import { adminRow, settle, versionRow } from '../admin-testing';
import { ScenarioChecksComponent } from './scenario-checks.component';

const GIB = 1024 ** 3;
const GOOD_RUN: TestRun = { timeToFirstFrameMs: 3800, avgFps: 58, gpuMemoryBytes: 1.4 * GIB, consoleErrors: 0, ranAt: '2026-03-12T09:14:00Z', ranBy: 'Марія', engineBuild: '0.1.0-local.1', userAgent: 'Mozilla/5.0 <b>x</b>' };

describe('ScenarioChecksComponent', () => {
  // The player host a test run gets; each test of the run block installs its own fake.
  type FakeHost = { load: ReturnType<typeof vi.fn>; measure: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; restart: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn> };
  let host: FakeHost;
  let fixture: ComponentFixture<ScenarioChecksComponent>;
  let root: HTMLElement;
  let http: HttpTestingController;
  let changed: number;
  let ran: ScenarioVersion[];

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: PLAYER_HOST_FACTORY, useValue: () => host }],
    });
    TestBed.inject(AdminService).setToken('code');
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function open(role: AdminRole, versions: ScenarioVersion[], scenario: AdminScenario = adminRow('alpha'), testEnabled = true): Promise<void> {
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

  describe('the test run (DW-6.2, DW-7.5)', () => {
    const METRICS = { timeToFirstFrameMs: 1800, avgFps: 59, gpuMemoryBytes: 400_000_000, consoleErrors: 0, engineBuild: 'build-7' };
    const UA = () => navigator.userAgent.slice(0, 300);

    function fakeHost(overrides: Partial<FakeHost> = {}): void {
      host = { load: vi.fn().mockResolvedValue(undefined), measure: vi.fn().mockResolvedValue(METRICS), dispose: vi.fn(), restart: vi.fn(), pause: vi.fn(), resume: vi.fn(), ...overrides };
    }

    beforeEach(() => {
      fakeHost();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Blob(['zip']), { status: 200 })));
    });
    afterEach(() => vi.unstubAllGlobals());

    const runButton = () => q<HTMLButtonElement>('[data-action="run-test"]');
    const SAVE = { method: 'POST', url: '/api/scenarios/alpha/versions/1/test-run' };
    async function start(role: AdminRole = 'moderator', current = versionRow(1, 'current')): Promise<void> {
      await open(role, [current]);
      runButton().click();
      await settle(fixture, 12);
    }
    async function answerSave(body: unknown, answer: object): Promise<void> {
      const req = http.expectOne(SAVE);
      expect(req.request.body).toEqual(body);
      req.flush(answer);
      await settle(fixture, 4);
    }

    it('DW-6.2 the moderator button is disabled when the host switches the test off, and does nothing', async () => {
      await open('moderator', [versionRow(1, 'current')], adminRow('alpha'), false);
      expect(runButton().disabled).toBe(true);
      runButton().click();
      expect(ran).toEqual([]);
      expect(root.querySelector('[role="dialog"]')).toBeNull();
    });

    it('the button is enabled by default', async () => {
      await open('moderator', [versionRow(1, 'current')]);
      expect(runButton().disabled).toBe(false);
    });

    it('DW-7.5 runs the archive in the player, measures, saves the report with device and engine build, and shows it', async () => {
      const current = versionRow(1, 'current');
      await open('moderator', [current]);
      runButton().click();
      expect(ran).toEqual([current]);
      await settle(fixture, 12);
      expect(fetch).toHaveBeenCalledWith(current.url, expect.anything());
      expect(host.load).toHaveBeenCalledWith({ kind: 'blob', blob: expect.any(Blob) }, { diag: false });
      expect(host.measure).toHaveBeenCalledWith(10);
      await answerSave(
        { ...METRICS, userAgent: UA() },
        { testRun: { ...METRICS, userAgent: navigator.userAgent, ranBy: 'Марія', ranAt: '2026-03-12T09:14:00Z' } },
      );
      expect(root.querySelector('[role="dialog"]')).toBeNull();
      expect(normRows()[0]).toEqual(['Час до першого кадру', '1,8 с — у нормі', 'до 5 с']);
      expect(root.textContent).toContain('виконав(ла) Марія');
      expect(root.textContent).toContain('Рушій: build-7');
      expect(host.dispose).toHaveBeenCalled();
    });

    it('DW-7.5 a crashing fixture (the player fails to load) stores the error, not numbers', async () => {
      fakeHost({ load: vi.fn().mockRejectedValue(new Error('Сценарій упав під час запуску')) });
      await start();
      await answerSave(
        { error: 'Сценарій упав під час запуску', userAgent: UA() },
        { testRun: { error: 'Сценарій упав під час запуску', ranBy: 'Марія' } },
      );
      expect(q('[data-role="run-error"]').textContent).toContain('Сценарій упав під час запуску');
      expect(host.measure).not.toHaveBeenCalled();
      expect(host.dispose).toHaveBeenCalled();
    });

    it('a measurement that rejects is stored as an error too', async () => {
      fakeHost({ measure: vi.fn().mockRejectedValue(new Error('Сцена не запущена')) });
      await start();
      await answerSave({ error: 'Сцена не запущена', userAgent: UA() }, { testRun: { error: 'Сцена не запущена' } });
      expect(q('[data-role="run-error"]')).not.toBeNull();
    });

    it('a failed archive download is stored as an error without starting a player', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
      await start();
      await answerSave({ error: 'Помилка завантаження архіву: 404', userAgent: UA() }, { testRun: { error: 'Помилка завантаження архіву: 404' } });
      expect(host.load).not.toHaveBeenCalled();
    });

    it('DW-7.5 an engine build of 500 characters is truncated to 100 before it is posted', async () => {
      fakeHost({ measure: vi.fn().mockResolvedValue({ ...METRICS, engineBuild: 'E'.repeat(500) }) });
      await start();
      const req = http.expectOne(SAVE);
      expect(req.request.body.engineBuild).toHaveLength(100);
      req.flush({ testRun: { ...METRICS } });
      await settle(fixture, 4);
    });

    it('a figure from the scenario that is not a number is posted as an error, never as figures', async () => {
      fakeHost({ measure: vi.fn().mockResolvedValue({ ...METRICS, avgFps: 'lots' }) });
      await start();
      const req = http.expectOne(SAVE);
      expect(req.request.body.error).toBeTruthy();
      expect(req.request.body.avgFps).toBeUndefined();
      req.flush({ testRun: { error: 'x' } });
      await settle(fixture, 4);
    });

    it('cancelling disposes the player and posts nothing', async () => {
      fakeHost({ measure: vi.fn().mockReturnValue(new Promise(() => undefined)) });
      await start();
      q<HTMLButtonElement>('[data-action="cancel-run"]').click();
      await settle(fixture, 4);
      expect(host.dispose).toHaveBeenCalled();
      expect(root.querySelector('[role="dialog"]')).toBeNull();
      http.expectNone(SAVE);
    });

    it('leaving the tab mid-run disposes the player', async () => {
      fakeHost({ measure: vi.fn().mockReturnValue(new Promise(() => undefined)) });
      await start();
      fixture.destroy();
      expect(host.dispose).toHaveBeenCalled();
    });

    it('a refused save shows the server message', async () => {
      await start();
      http.expectOne(SAVE).flush({ error: 'avgFps: число від 0 до 1000' }, { status: 400, statusText: 'x' });
      await settle(fixture, 4);
      expect(q('.banner-error').textContent).toContain('avgFps');
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
