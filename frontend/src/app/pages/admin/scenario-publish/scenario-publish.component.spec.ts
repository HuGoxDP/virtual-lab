// path: src/app/pages/admin/scenario-publish/scenario-publish.component.spec.ts
//
// Test-plan scenario 212 (DW-5.4): the Публікація tab offers each transition the role may make, runs it,
// shows a refusal as the server sent it, and lists the decision history from the journal.

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';

import { AdminRole, AuditRow } from '../../../models/admin.model';
import { AdminScenario } from '../../../models/scenario.model';
import { AdminService } from '../../../services/admin.service';
import { ToastService } from '../../../ui/toast/toast.service';
import { adminRow, auditRow, settle } from '../admin-testing';
import { ScenarioPublishComponent } from './scenario-publish.component';

describe('ScenarioPublishComponent', () => {
  let fixture: ComponentFixture<ScenarioPublishComponent>;
  let root: HTMLElement;
  let http: HttpTestingController;
  let changed: number;

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()] });
    TestBed.inject(AdminService).setToken('code');
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.restoreAllMocks();
  });

  async function open(scenario: AdminScenario, role: AdminRole, history: AuditRow[] = []): Promise<void> {
    fixture = TestBed.createComponent(ScenarioPublishComponent);
    changed = 0;
    fixture.componentInstance.changed.subscribe(() => changed++);
    fixture.componentRef.setInput('scenario', scenario);
    fixture.componentRef.setInput('role', role);
    root = fixture.nativeElement;
    fixture.detectChanges();
    http.expectOne('/api/scenarios/alpha/history').flush(history);
    await settle(fixture);
  }

  const qa = (selector: string) => [...root.querySelectorAll<HTMLElement>(selector)];
  const actionButtons = () => qa('.actions button, .actions a').map(b => b.textContent?.trim());
  const action = (name: string) => root.querySelector<HTMLButtonElement>(`[data-action="${name}"]`)!;

  /** Presses a button, answers its POST, then the history reload that follows. */
  async function run(name: string, status = 'review', expectBody: unknown = {}): Promise<TestRequest> {
    action(name).click();
    const req = http.expectOne(`/api/scenarios/alpha/${name}`);
    expect(req.request.body).toEqual(expectBody);
    req.flush({ id: 'alpha', status, isPublished: status === 'published', moderatorNote: null, submittedAt: null });
    await settle(fixture, 2);
    http.expectOne('/api/scenarios/alpha/history').flush([]);
    await settle(fixture);
    return req;
  }

  describe('as an author', () => {
    it('DW-5.4 submits a draft: one POST, the parent told, a toast, the history refetched', async () => {
      await open(adminRow('alpha', { status: 'draft' }), 'author');
      expect(actionButtons()).toEqual(['Подати на перевірку']);

      await run('submit');
      expect(changed).toBe(1);
      expect(TestBed.inject(ToastService).message()).toBe('Надіслано на модерацію');
    });

    it('DW-5.4 withdraws a scenario in review', async () => {
      await open(adminRow('alpha', { status: 'review' }), 'author');
      expect(actionButtons()).toEqual(['Відкликати з перевірки']);
      await run('withdraw', 'draft');
      expect(changed).toBe(1);
    });

    it('DW-5.4 submits a returned scenario again and sees the moderator\'s comment as text', async () => {
      await open(adminRow('alpha', { status: 'rejected', moderatorNote: '<b>Додайте</b> опис' }), 'author');
      expect(root.querySelector('.note-text')?.textContent).toBe('<b>Додайте</b> опис');
      expect(root.querySelector('.note-text b')).toBeNull();
      expect(actionButtons()).toEqual(['Подати на перевірку']);
    });

    it('DW-5.4 has no action on a published scenario, but can open it in the catalog', async () => {
      await open(adminRow('alpha', { status: 'published' }), 'author');
      expect(actionButtons()).toEqual(['Відкрити в каталозі']);
      expect(root.querySelector('.actions a')?.getAttribute('href')).toBe('/scenario/alpha');
      expect(root.querySelector('.hint')?.textContent).toContain('нова версія');
    });

    it('draws submit disabled, with the reason, when there is no archive', async () => {
      await open(adminRow('alpha', { status: 'draft', archiveSha256: null, currentVersion: null }), 'author');
      expect(action('submit').disabled).toBe(true);
      expect(root.querySelector('.hint')?.textContent).toContain('завантажте архів');
      action('submit').click();
      http.expectNone('/api/scenarios/alpha/submit');
    });

    it('never offers a note field or the readiness warning', async () => {
      await open(adminRow('alpha', { status: 'review', description: '' }), 'author');
      expect(root.querySelector('#reject-note')).toBeNull();
      expect(root.querySelector('.not-ready')).toBeNull();
    });
  });

  describe('as a moderator', () => {
    it('DW-5.4 publishes a scenario in review', async () => {
      await open(adminRow('alpha', { status: 'review' }), 'moderator');
      expect(actionButtons()).toEqual(['Опублікувати', 'Повернути на доопрацювання', 'Відкликати з перевірки']);
      await run('approve', 'published');
      expect(TestBed.inject(ToastService).message()).toBe('Опубліковано в каталозі');
      expect(changed).toBe(1);
    });

    it('DW-5.4 returns a scenario with the note they wrote', async () => {
      await open(adminRow('alpha', { status: 'review' }), 'moderator');
      const note = root.querySelector<HTMLTextAreaElement>('#reject-note')!;
      note.value = '  Додайте опис і превʼю  ';
      note.dispatchEvent(new Event('input'));
      await run('reject', 'rejected', { note: 'Додайте опис і превʼю' });
      expect(note.value).toBe(''); // the next scenario starts with an empty note
    });

    it('DW-5.4 returning with no note leaves it to the server\'s default text', async () => {
      await open(adminRow('alpha', { status: 'review' }), 'moderator');
      await run('reject', 'rejected', {});
    });

    it('DW-5.4 unpublishes only after confirming', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
      await open(adminRow('alpha', { status: 'published' }), 'moderator');
      expect(actionButtons()).toEqual(['Зняти з публікації', 'Відкрити в каталозі']);

      action('unpublish').click();
      http.expectNone('/api/scenarios/alpha/unpublish');

      await run('unpublish', 'draft');
      expect(confirm).toHaveBeenCalledTimes(2);
      expect(changed).toBe(1);
    });

    it('DW-5.4 can publish a draft or a returned scenario directly', async () => {
      await open(adminRow('alpha', { status: 'draft' }), 'moderator');
      expect(actionButtons()).toEqual(['Опублікувати', 'Подати на перевірку']);
    });

    it('warns "Не все готово" when publishing something with holes, naming them', async () => {
      await open(adminRow('alpha', { status: 'review', description: '', imageUrl: '' }), 'moderator');
      const warning = root.querySelector('.not-ready')!;
      expect(warning.textContent).toContain('Не все готово');
      expect(warning.textContent).toContain('немає короткого опису');
      expect(warning.textContent).toContain('немає превʼю');
    });

    it('does not warn when everything is in place, or when publishing is impossible anyway', async () => {
      await open(adminRow('alpha', { status: 'review' }), 'moderator');
      expect(root.querySelector('.not-ready')).toBeNull();
      fixture.destroy();

      await open(adminRow('alpha', { status: 'draft', description: '', archiveSha256: null, currentVersion: null }), 'moderator');
      expect(root.querySelector('.not-ready')).toBeNull();
    });
  });

  describe('refusals', () => {
    it('DW-5.4 shows the server\'s own message, does not toast and does not tell the parent', async () => {
      await open(adminRow('alpha', { status: 'review' }), 'moderator');
      action('approve').click();
      http.expectOne('/api/scenarios/alpha/approve').flush({ error: 'Статус уже змінено' }, { status: 409, statusText: 'Conflict' });
      await settle(fixture);

      expect(root.querySelector('.banner-error')?.textContent).toContain('Статус уже змінено');
      expect(changed).toBe(0);
      expect(TestBed.inject(ToastService).message()).toBe('');
      expect(action('approve').disabled).toBe(false); // the user can try again
    });

    it('a second press while one is running is ignored', async () => {
      await open(adminRow('alpha', { status: 'review' }), 'moderator');
      action('approve').click();
      action('approve').click();
      const req = http.expectOne('/api/scenarios/alpha/approve');
      req.flush({ id: 'alpha', status: 'published' });
      await settle(fixture, 2);
      http.expectOne('/api/scenarios/alpha/history').flush([]);
      await settle(fixture);
    });
  });

  describe('history', () => {
    it('DW-5.4 reads the journal as sentences with who and when, newest first as sent', async () => {
      await open(adminRow('alpha'), 'author', [
        auditRow('scenario.reject', { actorLabel: 'О. Мельник', createdAt: '2026-03-06T09:03:00Z', details: { note: 'немає опису' } }),
        auditRow('scenario.submit', { actorLabel: 'Іван', createdAt: '2026-03-12T12:22:00Z' }),
        auditRow('scenario.archive', { actorLabel: 'Іван', createdAt: '2026-02-28T07:41:00Z' }),
      ]);

      expect(qa('.history li .event-text').map(el => el.textContent)).toEqual([
        'Повернуто на доопрацювання', 'Надіслано на модерацію', 'Завантажено архів',
      ]);
      expect(qa('.event-note').map(el => el.textContent)).toEqual(['«немає опису»']);
      expect(qa('.event-meta').map(el => el.textContent)).toEqual([
        'О. Мельник · 6 бер 2026, 11:03', 'Іван · 12 бер 2026, 14:22', 'Іван · 28 лют 2026, 09:41',
      ]);
    });

    it('shows the actor and note as text, never as markup', async () => {
      await open(adminRow('alpha'), 'author', [auditRow('scenario.reject', { actorLabel: '<img src=x onerror=alert(1)>', details: { note: '<script>1</script>' } })]);
      expect(root.querySelectorAll('img, script').length).toBe(0);
      expect(root.querySelector('.event-meta')?.textContent).toContain('<img src=x onerror=alert(1)>');
    });

    it('says so when there are no records', async () => {
      await open(adminRow('alpha'), 'author', []);
      expect(root.querySelector('.history-panel .muted')?.textContent).toBe('Записів ще немає.');
    });

    it('shows the error when the journal cannot be read, instead of an empty list', async () => {
      fixture = TestBed.createComponent(ScenarioPublishComponent);
      fixture.componentRef.setInput('scenario', adminRow('alpha'));
      fixture.componentRef.setInput('role', 'author');
      root = fixture.nativeElement;
      fixture.detectChanges();
      http.expectOne('/api/scenarios/alpha/history').flush({ error: 'Це не ваш сценарій' }, { status: 403, statusText: 'Forbidden' });
      await settle(fixture);
      expect(root.querySelector('.history-panel .banner-error')?.textContent).toContain('Це не ваш сценарій');
      expect(root.querySelector('.history-panel .muted')).toBeNull();
    });

    it('another scenario reloads the history', async () => {
      await open(adminRow('alpha'), 'author');
      fixture.componentRef.setInput('scenario', adminRow('beta'));
      fixture.detectChanges();
      http.expectOne('/api/scenarios/beta/history').flush([]);
      await settle(fixture);
    });

    it('DW-6.2 a late history for the scenario the user left does not overwrite the new one', async () => {
      fixture = TestBed.createComponent(ScenarioPublishComponent);
      fixture.componentRef.setInput('scenario', adminRow('alpha'));
      fixture.componentRef.setInput('role', 'author');
      root = fixture.nativeElement;
      fixture.detectChanges();
      const late = http.expectOne('/api/scenarios/alpha/history');

      fixture.componentRef.setInput('scenario', adminRow('beta'));
      fixture.detectChanges();
      const beta = http.expectOne('/api/scenarios/beta/history');
      beta.flush([auditRow('scenario.submit', { actorLabel: 'Бета-автор' })]);
      await settle(fixture);
      late.flush([auditRow('scenario.approve', { actorLabel: 'Альфа-модератор' })]);
      await settle(fixture);

      expect(root.querySelector('.history')!.textContent).toContain('Бета-автор');
      expect(root.querySelector('.history')!.textContent).not.toContain('Альфа-модератор');
    });

    it('DW-6.2 a late history error for the scenario the user left is not shown on the new one', async () => {
      fixture = TestBed.createComponent(ScenarioPublishComponent);
      fixture.componentRef.setInput('scenario', adminRow('alpha'));
      fixture.componentRef.setInput('role', 'author');
      root = fixture.nativeElement;
      fixture.detectChanges();
      const late = http.expectOne('/api/scenarios/alpha/history');

      fixture.componentRef.setInput('scenario', adminRow('beta'));
      fixture.detectChanges();
      http.expectOne('/api/scenarios/beta/history').flush([auditRow('scenario.submit')]);
      await settle(fixture);
      late.flush({ error: 'Помилка Альфи' }, { status: 500, statusText: 'err' });
      await settle(fixture);

      expect(root.querySelector('.banner-error')).toBeNull();
      expect(root.querySelectorAll('.history li').length).toBe(1);
    });
  });

  it('DW-5.4 the status line names the status in words', async () => {
    await open(adminRow('alpha', { status: 'review' }), 'author');
    expect(root.querySelector('.status-line')?.textContent).toContain('На перевірці');
    expect(root.querySelector('.status-text')?.textContent).toBe('Чекає на рішення модератора.');
  });
});
