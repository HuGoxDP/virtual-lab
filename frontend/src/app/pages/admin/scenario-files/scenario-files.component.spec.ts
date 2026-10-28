// path: src/app/pages/admin/scenario-files/scenario-files.component.spec.ts
//
// Test-plan scenario 218 (DW-6.1): the Файл tab replaces the archive with progress and cancel, lists the
// versions with the actions the role may take, and shows the pending proposal with its preview link and
// its accept / reject (moderator) or retract (author) actions.

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';

import { AdminRole, ArchiveEntry, ScenarioVersion } from '../../../models/admin.model';
import { AdminScenario } from '../../../models/scenario.model';
import { AdminService } from '../../../services/admin.service';
import { ToastService } from '../../../ui/toast/toast.service';
import { adminRow, settle, versionRow } from '../admin-testing';
import { LARGE_ARCHIVE_BYTES, ScenarioFilesComponent, topLevel } from './scenario-files.component';

const MIB = 1024 * 1024;
const entries = (...paths: string[]): ArchiveEntry[] => paths.map(path => ({ path, bytes: path.endsWith('/') ? 0 : 10, dir: path.endsWith('/') }));

describe('topLevel', () => {
  it('DW-6.1 lists loose files first, then each directory with the number of files under it', () => {
    const rows = topLevel(entries('manifest.json', 'main.js', 'models/', 'models/a.glb', 'models/b.glb', 'textures/', 'textures/x/', 'textures/x/t.png'));
    expect(rows).toEqual([
      { name: 'manifest.json', dir: false, count: 1 },
      { name: 'main.js', dir: false, count: 1 },
      { name: 'models', dir: true, count: 2 },
      { name: 'textures', dir: true, count: 1 },
    ]);
  });

  it('an empty archive and a directory entry with nothing in it', () => {
    expect(topLevel([])).toEqual([]);
    expect(topLevel(entries('empty/'))).toEqual([{ name: 'empty', dir: true, count: 0 }]);
  });
});

describe('ScenarioFilesComponent', () => {
  let fixture: ComponentFixture<ScenarioFilesComponent>;
  let root: HTMLElement;
  let http: HttpTestingController;
  let changed: number;
  let confirmAnswer: boolean;

  beforeEach(() => {
    sessionStorage.clear();
    confirmAnswer = true;
    vi.stubGlobal('confirm', vi.fn(() => confirmAnswer));
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()] });
    TestBed.inject(AdminService).setToken('code');
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.unstubAllGlobals();
  });

  const defaultVersions = [versionRow(3, 'current'), versionRow(2, 'archived'), versionRow(1, 'archived')];
  const defaultContents = entries('manifest.json', 'main.js', 'models/', 'models/a.glb', 'models/b.glb');

  async function open(
    role: AdminRole,
    scenario: AdminScenario = adminRow('alpha', { status: 'draft' }),
    versions: ScenarioVersion[] = defaultVersions,
    opts: { maxArchiveBytes?: number; contents?: ArchiveEntry[] } = {},
  ): Promise<void> {
    fixture = TestBed.createComponent(ScenarioFilesComponent);
    changed = 0;
    fixture.componentInstance.changed.subscribe(() => changed++);
    fixture.componentRef.setInput('scenario', scenario);
    fixture.componentRef.setInput('role', role);
    root = fixture.nativeElement;
    fixture.detectChanges();
    http.expectOne('/api/config').flush({ maxArchiveBytes: opts.maxArchiveBytes ?? 200 * MIB, preview: { maxBytes: 1, minWidth: 1, aspect: 1 } });
    http.expectOne(`/api/scenarios/${scenario.id}/versions`).flush({ versions });
    await settle(fixture, 3);
    const current = versions.find(v => v.state === 'current');
    if (current) http.expectOne(`/api/scenarios/${scenario.id}/versions/${current.id}/contents`).flush(opts.contents ?? defaultContents);
    await settle(fixture);
  }

  const q = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const qa = (selector: string) => [...root.querySelectorAll<HTMLElement>(selector)];
  const rowActions = () => qa('[data-role="versions"] tbody tr').map(tr => qa('button').filter(b => tr.contains(b)).map(b => b.dataset['action']));

  /** Presses a button, answers its request, then the versions reload that follows (and the contents, when asked). */
  async function press(selector: string, method: string, url: string, answer: object = { message: 'ok' }, after: ScenarioVersion[] = defaultVersions): Promise<TestRequest> {
    q<HTMLButtonElement>(selector).click();
    const req = http.expectOne(url);
    expect(req.request.method).toBe(method);
    req.flush(answer);
    await settle(fixture, 3);
    const scenarioId = url.split('/')[3];
    http.expectOne(`/api/scenarios/${scenarioId}/versions`).flush({ versions: after });
    await settle(fixture, 3);
    const current = after.find(v => v.state === 'current');
    const reloadsContents = http.match(`/api/scenarios/${scenarioId}/versions/${current?.id}/contents`);
    reloadsContents.forEach(r => r.flush(defaultContents));
    await settle(fixture);
    return req;
  }

  function pick(file: File): void {
    const input = q<HTMLInputElement>('[data-role="archive-input"]');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
  }

  describe('the current archive and its contents', () => {
    it('DW-6.1 shows the current version, its size and who uploaded it', async () => {
      await open('author');
      const text = q('[data-role="current-archive"]').textContent!;
      expect(text).toContain('Версія 1.3.0');
      expect(text).toContain('2 МБ');
      expect(text).toContain('Олена');
      expect(q<HTMLAnchorElement>('[data-action="download"]').getAttribute('href')).toBe(defaultVersions[0].url);
    });

    it('DW-6.1 offers no download link for a url that is not a stored archive path', async () => {
      await open('author', adminRow('alpha'), [versionRow(3, 'current', { url: 'javascript:alert(1)' })]);
      expect(root.querySelector('[data-action="download"]')).toBeNull();
    });

    it('DW-6.1 warns about an archive over 50 MB and stays quiet below it', async () => {
      await open('author', adminRow('alpha'), [versionRow(3, 'current', { bytes: LARGE_ARCHIVE_BYTES + 1 })]);
      expect(q('[data-role="large-archive"]').textContent).toContain('Великий архів');
      fixture.destroy();
      await open('author', adminRow('alpha'), [versionRow(3, 'current', { bytes: LARGE_ARCHIVE_BYTES })]);
      expect(root.querySelector('[data-role="large-archive"]')).toBeNull();
    });

    it('DW-6.1 shows the contents tree with directory counts, and hostile paths as text', async () => {
      await open('author', adminRow('alpha'), defaultVersions, { contents: entries('manifest.json', '<img src=x onerror=alert(1)>/', '<img src=x onerror=alert(1)>/a.js', 'models/', 'models/a.glb', 'models/b.glb') });
      const lines = qa('[data-role="contents"] li').map(li => li.textContent!.replace(/\s+/g, ' ').trim());
      expect(lines).toEqual(['manifest.json', '<img src=x onerror=alert(1)>/— 1 файл', 'models/— 2 файли']);
      expect(root.querySelector('img')).toBeNull();
    });

    it('says so when there is no archive yet, and asks for no contents', async () => {
      await open('author', adminRow('alpha', { currentVersion: null }), []);
      expect(root.textContent).toContain('Архів ще не завантажено');
      expect(root.textContent).toContain('Версій ще немає');
      expect(root.textContent).toContain('Немає архіву');
    });

    it('a failed contents read is shown and the rest of the tab still works', async () => {
      fixture = TestBed.createComponent(ScenarioFilesComponent);
      fixture.componentRef.setInput('scenario', adminRow('alpha'));
      fixture.componentRef.setInput('role', 'author');
      root = fixture.nativeElement;
      fixture.detectChanges();
      http.expectOne('/api/config').flush({ maxArchiveBytes: 1, preview: {} });
      http.expectOne('/api/scenarios/alpha/versions').flush({ versions: defaultVersions });
      await settle(fixture, 3);
      http.expectOne('/api/scenarios/alpha/versions/3/contents').flush({ error: 'Архів пошкоджено' }, { status: 400, statusText: 'Bad' });
      await settle(fixture);
      expect(q('#contents-title').parentElement!.querySelector('.banner-error')!.textContent).toContain('Архів пошкоджено');
      expect(qa('[data-role="versions"] tbody tr').length).toBe(3);
    });

    it('a failed versions read is shown', async () => {
      fixture = TestBed.createComponent(ScenarioFilesComponent);
      fixture.componentRef.setInput('scenario', adminRow('alpha'));
      fixture.componentRef.setInput('role', 'author');
      root = fixture.nativeElement;
      fixture.detectChanges();
      http.expectOne('/api/config').flush({ maxArchiveBytes: 1, preview: {} });
      http.expectOne('/api/scenarios/alpha/versions').flush({ error: 'Це не ваш сценарій' }, { status: 403, statusText: 'Forbidden' });
      await settle(fixture);
      expect(q('.banner-error').textContent).toContain('Це не ваш сценарій');
    });
  });

  describe('the version history by role', () => {
    it('DW-6.1 a moderator can restore or delete an archived version, never the current one', async () => {
      await open('moderator');
      expect(qa('[data-role="versions"] tbody tr').map(tr => tr.dataset['state'])).toEqual(['current', 'archived', 'archived']);
      expect(rowActions()).toEqual([[], ['restore', 'delete'], ['restore', 'delete']]);
      expect(qa('.state').map(el => el.textContent)).toEqual(['Поточна', 'Архівна', 'Архівна']);
    });

    it('DW-6.1 an author sees the history but no restore or delete', async () => {
      await open('author');
      expect(qa('[data-role="versions"] tbody tr').length).toBe(3);
      expect(rowActions()).toEqual([[], [], []]);
    });

    it('DW-6.1 restore asks first, posts to the version, reloads and tells the parent', async () => {
      await open('moderator');
      confirmAnswer = false;
      qa('[data-action="restore"]')[0].click();
      http.expectNone('/api/scenarios/alpha/versions/2/restore');
      expect(changed).toBe(0);

      confirmAnswer = true;
      const swapped = [versionRow(3, 'archived'), versionRow(2, 'current'), versionRow(1, 'archived')];
      qa('[data-action="restore"]')[0].click();
      const req = http.expectOne('/api/scenarios/alpha/versions/2/restore');
      expect(req.request.method).toBe('POST');
      expect(req.request.headers.get('Authorization')).toBe('Bearer code');
      req.flush({ message: 'Готово' });
      await settle(fixture, 3);
      http.expectOne('/api/scenarios/alpha/versions').flush({ versions: swapped });
      await settle(fixture, 3);
      http.expectOne('/api/scenarios/alpha/versions/2/contents').flush(defaultContents);
      await settle(fixture);

      expect(changed).toBe(1);
      expect(TestBed.inject(ToastService).message()).toBe('Версію відновлено');
      expect(qa('.state').map(el => el.textContent)).toEqual(['Архівна', 'Поточна', 'Архівна']);
    });

    it('DW-6.1 delete removes an archived version from the history', async () => {
      await open('moderator');
      await press('[data-action="delete"]', 'DELETE', '/api/scenarios/alpha/versions/2', { message: 'Версію видалено' }, [versionRow(3, 'current'), versionRow(1, 'archived')]);
      expect(qa('[data-role="versions"] tbody tr').length).toBe(2);
      expect(changed).toBe(1);
    });

    it('DW-6.1 a refusal is shown as the server sent it, and nothing is reloaded or reported', async () => {
      await open('moderator');
      qa('[data-action="restore"]')[0].click();
      http.expectOne('/api/scenarios/alpha/versions/2/restore').flush({ error: 'Відновити можна лише архівну версію' }, { status: 409, statusText: 'Conflict' });
      await settle(fixture);
      expect(q('.banner-error').textContent).toContain('Відновити можна лише архівну версію');
      expect(changed).toBe(0);
      expect(qa('button[data-action="restore"]').every(b => !(b as HTMLButtonElement).disabled)).toBe(true);
    });
  });

  describe('the pending proposal', () => {
    const withPending = [versionRow(4, 'pending', { uploadedByLabel: '<b>Автор</b>' }), ...defaultVersions];

    it('DW-6.1 a moderator sees the banner, the preview link to the pending bytes and Прийняти / Відхилити', async () => {
      await open('moderator', adminRow('alpha', { status: 'published', pendingVersionId: 4 }), withPending);
      const banner = q('[data-role="pending-banner"]');
      expect(banner.textContent).toContain('Нова версія чекає на розгляд');
      expect(banner.textContent).toContain('<b>Автор</b>');
      expect(banner.querySelector('b')).toBeNull();
      const href = q<HTMLAnchorElement>('[data-action="preview-pending"]').getAttribute('href')!;
      expect(href).toBe(`/play/alpha?draft=${withPending[0].sha256}&returnTo=%2Fadmin%2Fscenarios%2Falpha%2Ffiles`);
      expect(qa('.pending-actions button').map(b => b.dataset['action'])).toEqual(['accept', 'reject']);
    });

    it('DW-6.1 accepting posts accept for the pending version', async () => {
      await open('moderator', adminRow('alpha', { status: 'published', pendingVersionId: 4 }), withPending);
      const accepted = [versionRow(4, 'current'), versionRow(3, 'archived'), ...defaultVersions.slice(1)];
      await press('[data-action="accept"]', 'POST', '/api/scenarios/alpha/versions/4/accept', { message: 'Готово' }, accepted);
      expect(root.querySelector('[data-role="pending-banner"]')).toBeNull();
      expect(changed).toBe(1);
    });

    it('DW-6.1 rejecting posts reject and the banner goes away', async () => {
      await open('moderator', adminRow('alpha', { status: 'published', pendingVersionId: 4 }), withPending);
      await press('[data-action="reject"]', 'POST', '/api/scenarios/alpha/versions/4/reject', { message: 'Готово' }, defaultVersions);
      expect(root.querySelector('[data-role="pending-banner"]')).toBeNull();
    });

    it('DW-6.1 an author can retract the proposal (DELETE) but cannot accept or reject it', async () => {
      await open('author', adminRow('alpha', { status: 'published', pendingVersionId: 4 }), withPending);
      expect(qa('.pending-actions button').map(b => b.dataset['action'])).toEqual(['retract']);
      await press('[data-action="retract"]', 'DELETE', '/api/scenarios/alpha/versions/4', { message: 'Версію видалено' }, defaultVersions);
      expect(root.querySelector('[data-role="pending-banner"]')).toBeNull();
      expect(TestBed.inject(ToastService).message()).toBe('Версію відкликано');
    });

    it('declining the confirmation sends nothing', async () => {
      await open('author', adminRow('alpha', { status: 'published', pendingVersionId: 4 }), withPending);
      confirmAnswer = false;
      q<HTMLButtonElement>('[data-action="retract"]').click();
      await settle(fixture, 2);
      expect(changed).toBe(0);
    });

    it('no pending version, no banner', async () => {
      await open('moderator');
      expect(root.querySelector('[data-role="pending-banner"]')).toBeNull();
    });
  });

  describe('replacing the archive', () => {
    it('DW-6.1 posts the picked ZIP to the scenario, shows progress, then reloads and tells the parent', async () => {
      await open('author');
      pick(new File([new Uint8Array(1000)], 'v2.zip'));
      await settle(fixture, 2);

      const req = http.expectOne('/api/scenarios/alpha/archive');
      expect(req.request.method).toBe('POST');
      expect((req.request.body as FormData).get('archive')).toBeInstanceOf(File);
      req.event({ type: 1, loaded: 500, total: 1000 } as never);
      await settle(fixture, 2);
      expect(q('.progress-card .pct').textContent).toBe('50%');
      expect(q('.progress-card').textContent).toContain('v2.zip');

      req.flush({ id: 'alpha', sha256: 's', bytes: 1000, url: '/x', deduplicated: false, manifestId: 'alpha', warnings: [], version: versionRow(5, 'current') });
      await settle(fixture, 3);
      const after = [versionRow(5, 'current'), ...defaultVersions.map(v => ({ ...v, state: 'archived' as const }))];
      http.expectOne('/api/scenarios/alpha/versions').flush({ versions: after });
      await settle(fixture, 3);
      http.expectOne('/api/scenarios/alpha/versions/5/contents').flush(defaultContents);
      await settle(fixture);

      expect(changed).toBe(1);
      expect(TestBed.inject(ToastService).message()).toBe('Архів завантажено');
      expect(qa('[data-role="versions"] tbody tr').length).toBe(4);
    });

    it('DW-6.1 an author\'s upload to a published scenario is announced as sent to the moderator', async () => {
      await open('author', adminRow('alpha', { status: 'published' }));
      pick(new File([new Uint8Array(10)], 'v2.zip'));
      await settle(fixture, 2);
      http.expectOne('/api/scenarios/alpha/archive').flush({
        id: 'alpha', sha256: 's', bytes: 10, url: '/x', deduplicated: false, manifestId: 'alpha', warnings: [], version: versionRow(6, 'pending'),
      });
      await settle(fixture, 3);
      http.expectOne('/api/scenarios/alpha/versions').flush({ versions: [versionRow(6, 'pending'), ...defaultVersions] });
      await settle(fixture);
      expect(TestBed.inject(ToastService).message()).toBe('Нову версію надіслано модератору');
      expect(q('[data-role="pending-banner"]')).toBeTruthy();
    });

    it('DW-6.1 cancel aborts the request: nothing reloads and the parent is not told', async () => {
      await open('author');
      pick(new File([new Uint8Array(1000)], 'v2.zip'));
      await settle(fixture, 2);
      const req = http.expectOne('/api/scenarios/alpha/archive');

      q<HTMLButtonElement>('[data-action="cancel-upload"]').click();
      await settle(fixture);

      expect(req.cancelled).toBe(true);
      expect(changed).toBe(0);
      expect(q('.banner-warn').textContent).toContain('скасовано');
      expect(root.querySelector('.progress-card')).toBeNull();
    });

    it('DW-6.3 an archive over the cap is refused before upload', async () => {
      await open('author', adminRow('alpha'), defaultVersions, { maxArchiveBytes: 100 * MIB });
      pick({ name: 'big.zip', size: 150 * MIB } as File);
      await settle(fixture);
      http.expectNone('/api/scenarios/alpha/archive');
      expect(q('.banner-error').textContent).toContain('завеликий');
    });

    it('DW-6.3 a scenario in review cannot take an upload and says to withdraw first', async () => {
      await open('author', adminRow('alpha', { status: 'review' }));
      expect(q('[data-role="archive-input"]').hasAttribute('disabled')).toBe(true);
      expect(q('.reason').textContent).toContain('відкличте');
    });

    it('DW-6.3 a 409 that arrives anyway (the status changed meanwhile) explains the withdrawal', async () => {
      await open('author');
      pick(new File([new Uint8Array(10)], 'v2.zip'));
      await settle(fixture, 2);
      http.expectOne('/api/scenarios/alpha/archive').flush(
        { error: 'Сценарій на перевірці: відкличте з перевірки, щоб завантажити новий архів' }, { status: 409, statusText: 'Conflict' });
      await settle(fixture);
      expect(q('.banner-error').textContent).toContain('«Публікація»');
      expect(changed).toBe(0);
    });
  });

  describe('switching to another scenario', () => {
    it('DW-6.1 a versions response for the scenario the user left is ignored', async () => {
      fixture = TestBed.createComponent(ScenarioFilesComponent);
      fixture.componentRef.setInput('scenario', adminRow('alpha'));
      fixture.componentRef.setInput('role', 'moderator');
      root = fixture.nativeElement;
      fixture.detectChanges();
      http.expectOne('/api/config').flush({ maxArchiveBytes: 1, preview: {} });
      const late = http.expectOne('/api/scenarios/alpha/versions');

      fixture.componentRef.setInput('scenario', adminRow('beta'));
      fixture.detectChanges();
      await settle(fixture, 2);
      const beta = http.expectOne('/api/scenarios/beta/versions');

      late.flush({ versions: [versionRow(9, 'current', { manifestVersion: 'alpha-only' })] });
      await settle(fixture, 3);
      expect(root.textContent).not.toContain('alpha-only');
      http.expectNone('/api/scenarios/alpha/versions/9/contents');

      beta.flush({ versions: [versionRow(1, 'current', { manifestVersion: 'beta-only' })] });
      await settle(fixture, 3);
      http.expectOne('/api/scenarios/beta/versions/1/contents').flush([]);
      await settle(fixture);
      expect(root.textContent).toContain('beta-only');
    });

    it('DW-6.1 when two reloads of the same scenario race, the newest answer wins', async () => {
      await open('author');
      pick(new File([new Uint8Array(10)], 'v2.zip'));
      await settle(fixture, 2);
      http.expectOne('/api/scenarios/alpha/archive').flush({ id: 'alpha', sha256: 's', bytes: 10, url: '/x', deduplicated: false, manifestId: 'alpha', warnings: [] });
      await settle(fixture, 3);
      const first = http.expectOne('/api/scenarios/alpha/versions'); // the reload after the upload

      // A second reload (a decision on the same scenario) is issued before the first answers.
      (fixture.componentInstance as unknown as { loadVersions: () => Promise<void> }).loadVersions();
      const second = http.expectOne('/api/scenarios/alpha/versions');

      second.flush({ versions: [versionRow(8, 'current', { manifestVersion: 'newest' })] });
      await settle(fixture, 3);
      http.expectOne('/api/scenarios/alpha/versions/8/contents').flush([]);
      first.flush({ versions: [versionRow(7, 'current', { manifestVersion: 'older' })] });
      await settle(fixture, 3);

      expect(root.textContent).toContain('newest');
      expect(root.textContent).not.toContain('older');
    });

    it('DW-6.1 an error shown for one scenario is not carried over to the next', async () => {
      fixture = TestBed.createComponent(ScenarioFilesComponent);
      fixture.componentRef.setInput('scenario', adminRow('alpha'));
      fixture.componentRef.setInput('role', 'author');
      root = fixture.nativeElement;
      fixture.detectChanges();
      http.expectOne('/api/config').flush({ maxArchiveBytes: 1, preview: {} });
      http.expectOne('/api/scenarios/alpha/versions').flush({ error: 'Помилка Альфи' }, { status: 500, statusText: 'err' });
      await settle(fixture);
      expect(q('.banner-error').textContent).toContain('Помилка Альфи');

      fixture.componentRef.setInput('scenario', adminRow('beta'));
      fixture.detectChanges();
      await settle(fixture, 2);
      expect(root.textContent).not.toContain('Помилка Альфи');
      http.expectOne('/api/scenarios/beta/versions').flush({ versions: [] });
      await settle(fixture, 2);
      expect(root.textContent).not.toContain('Помилка Альфи');
    });

    it('DW-6.1 a late versions error for the scenario the user left is not shown on the new one', async () => {
      fixture = TestBed.createComponent(ScenarioFilesComponent);
      fixture.componentRef.setInput('scenario', adminRow('alpha'));
      fixture.componentRef.setInput('role', 'author');
      root = fixture.nativeElement;
      fixture.detectChanges();
      http.expectOne('/api/config').flush({ maxArchiveBytes: 1, preview: {} });
      const late = http.expectOne('/api/scenarios/alpha/versions');
      fixture.componentRef.setInput('scenario', adminRow('beta'));
      fixture.detectChanges();
      http.expectOne('/api/scenarios/beta/versions').flush({ versions: [] });
      await settle(fixture, 2);
      late.flush({ error: 'Пізня помилка' }, { status: 500, statusText: 'err' });
      await settle(fixture, 2);
      expect(root.textContent).not.toContain('Пізня помилка');
    });

    it('DW-6.1 a contents response for a version that is no longer current is ignored', async () => {
      fixture = TestBed.createComponent(ScenarioFilesComponent);
      fixture.componentRef.setInput('scenario', adminRow('alpha'));
      fixture.componentRef.setInput('role', 'moderator');
      root = fixture.nativeElement;
      fixture.detectChanges();
      http.expectOne('/api/config').flush({ maxArchiveBytes: 1, preview: {} });
      http.expectOne('/api/scenarios/alpha/versions').flush({ versions: [versionRow(3, 'current')] });
      await settle(fixture, 3);
      const stale = http.expectOne('/api/scenarios/alpha/versions/3/contents');

      fixture.componentRef.setInput('scenario', adminRow('beta'));
      fixture.detectChanges();
      await settle(fixture, 2);
      http.expectOne('/api/scenarios/beta/versions').flush({ versions: [] });
      stale.flush(entries('stale-file.txt'));
      await settle(fixture, 3);
      expect(root.textContent).not.toContain('stale-file.txt');
    });
  });
});
