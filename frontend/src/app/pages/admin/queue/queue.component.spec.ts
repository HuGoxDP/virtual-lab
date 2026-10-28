// path: src/app/pages/admin/queue/queue.component.spec.ts
//
// Test-plan scenario 226 (DW-7.1): the moderation queue lists what waits for a decision with its check summary,
// decides inline (publish; return with a note; accept or reject an author's new archive) and shows the
// recent decisions from the journal.

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';

import { AdminSession } from '../../../services/admin-session.service';
import { adminRow, auditRow, settle } from '../admin-testing';
import { QueueComponent } from './queue.component';

const REVIEW_OLD = adminRow('mitosis', {
  title: 'Мітоз клітини', status: 'review', submittedAt: '2026-03-11T17:40:00Z', ownerLabel: 'Н. Гриценко', category: 'biology', categoryLabel: 'Біологія',
});
const REVIEW_NEW = adminRow('complex', {
  title: 'Сцена <b>складна</b>', status: 'review', submittedAt: '2026-03-12T14:22:00Z', ownerLabel: 'HuGox', description: '', imageUrl: '',
  archiveBytes: 96_700_000, currentVersion: { id: 2, sha256: 'c'.repeat(64), bytes: 96_700_000, checked: true, checks: { errors: 0, warnings: 1 } },
});
const PROPOSAL = adminRow('solar', { title: 'Сонячна система', status: 'published', isPublished: true, pendingVersionId: 77, ownerLabel: 'Олена' });
const RETURNED = adminRow('rome', { title: 'Давній Рим', status: 'rejected', moderatorNote: 'Немає опису', ownerLabel: 'Н. Гриценко' });
const DRAFT = adminRow('draft', { title: 'Чернетка', status: 'draft' });
const PUBLISHED = adminRow('plain', { title: 'Просто опублікований', status: 'published', isPublished: true });
const ROWS = [REVIEW_NEW, DRAFT, PROPOSAL, REVIEW_OLD, RETURNED, PUBLISHED];

const ACTIVITY = [
  auditRow('scenario.approve', { id: 1, scenarioId: 'crystal', scenarioTitle: 'Кристалічні ґратки', actorLabel: 'О. Мельник', createdAt: '2026-03-05T10:00:00Z' }),
  auditRow('scenario.reject', { id: 2, scenarioId: 'rome', scenarioTitle: 'Давній Рим', actorLabel: 'О. Мельник', details: { note: 'Немає опису' } }),
  auditRow('scenario.update', { id: 3, scenarioId: 'x', scenarioTitle: 'Не рішення' }),
  auditRow('version.accept', { id: 4, scenarioId: null, scenarioTitle: null, actorLabel: 'І. Ковальчук' }),
];

describe('QueueComponent', () => {
  let fixture: ComponentFixture<QueueComponent>;
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

  async function open(rows = ROWS, activity = ACTIVITY): Promise<void> {
    const signedIn = TestBed.inject(AdminSession).signIn('code');
    http.expectOne('/api/auth/me').flush({ role: 'moderator', label: 'Модер', keyId: 1 });
    await signedIn;
    fixture = TestBed.createComponent(QueueComponent);
    root = fixture.nativeElement;
    fixture.detectChanges();
    answerLists(rows, activity);
    await settle(fixture);
  }

  function answerLists(rows: unknown[], activity: unknown[]): void {
    http.expectOne('/api/admin/scenarios').flush({ scenarios: rows });
    http.expectOne('/api/admin/dashboard').flush({ counts: {}, queueSize: 0, activity });
  }

  const qa = (selector: string) => [...root.querySelectorAll<HTMLElement>(selector)];
  const card = (id: string) => root.querySelector<HTMLElement>(`[data-id="${id}"]`)!;
  const cardIds = () => qa('.queue-card').map(el => el.getAttribute('data-id'));
  const action = (id: string, name: string) => card(id).querySelector<HTMLButtonElement>(`[data-action="${name}"]`)!;
  async function click(el: HTMLElement): Promise<void> { el.click(); await settle(fixture, 2); }

  describe('lists (DW-7.1)', () => {
    beforeEach(() => open());

    it('DW-7.1 the Очікують tab holds reviews and proposals, oldest first, and nothing else', () => {
      expect(cardIds()).toEqual(['mitosis', 'complex', 'solar']); // solar has no submittedAt: last
    });

    it('counts each tab and summarises the waiting ones with the oldest submission', () => {
      expect(qa('.tab').map(el => el.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['Очікують 3', 'Повернуті 1', 'Опрацьовані 3']);
      expect(root.querySelector('[data-role="summary"]')?.textContent).toContain('3 сценарії очікують рішення');
      expect(root.querySelector('[data-role="summary"]')?.textContent).toContain('найстаріший подано 11 бер 2026');
    });

    it('DW-7.1 a card shows the check summary: passes, gaps and a large archive', () => {
      const labels = (id: string) => [...card(id).querySelectorAll('.check-chip')].map(el => el.getAttribute('data-level') + ':' + el.textContent?.replace(/\s+/g, ' ').trim().split(' — ')[0]);
      expect(labels('complex')).toEqual([
        'warn:Архів перевірено: 1 попередження', 'bad:Немає короткого опису', 'bad:Немає превʼю', 'warn:Великий архів',
      ]);
      expect(card('mitosis').querySelectorAll('.check-chip[data-level="ok"]')).toHaveLength(3);
    });

    it('renders author-supplied text as text, never as markup', () => {
      expect(card('complex').querySelector('.card-title')?.textContent).toBe('Сцена <b>складна</b>');
      expect(card('complex').querySelector('b')).toBeNull();
    });

    it('a card without a description says so', () => {
      expect(card('complex').querySelector('.desc.missing')?.textContent).toBe('Немає опису');
    });

    it('a proposal card says the new archive is waiting, links to the Файл tab and hides the chips', () => {
      expect(card('solar').querySelector('[data-role="proposal"]')?.textContent).toContain('Нова версія архіву');
      expect(card('solar').querySelector('[data-role="proposal-hint"]')?.textContent).toContain('Студенти отримують старий');
      expect(card('solar').querySelector('.chips')).toBeNull();
      expect(action('solar', 'details').getAttribute('href')).toBe('/admin/scenarios/solar/files');
      expect(card('solar').querySelector('[data-action="viewer"]')).toBeNull();
      expect(action('solar', 'approve').textContent?.trim()).toBe('Прийняти версію');
    });

    it('a review card links to the draft preview of its current version and to its Публікація tab', () => {
      const href = action('mitosis', 'viewer').getAttribute('href')!;
      expect(href).toContain('/play/mitosis');
      expect(href).toContain(`draft=${'a'.repeat(64)}`);
      expect(href).toContain('returnTo=%2Fadmin%2Fqueue');
      expect(action('mitosis', 'details').getAttribute('href')).toBe('/admin/scenarios/mitosis/publish');
    });

    it('the Повернуті tab lists returned scenarios with the moderator\'s note and no decision buttons', async () => {
      await click(qa('[data-tab="returned"]')[0]);
      expect(cardIds()).toEqual(['rome']);
      expect(card('rome').querySelector('[data-role="returned-note"]')?.textContent).toContain('Немає опису');
      expect(card('rome').querySelector('[data-action="approve"]')).toBeNull();
      expect(root.querySelector('.decisions')).toBeNull();
    });

    it('DW-7.1 recent decisions come from the journal: only decisions, with the note, the actor and the date', () => {
      const rows = qa('[data-role="decisions"] tbody tr').map(tr => tr.textContent?.replace(/\s+/g, ' ').trim());
      expect(rows).toHaveLength(3);
      expect(rows[0]).toContain('Кристалічні ґратки');
      expect(rows[0]).toContain('Опубліковано в каталозі');
      expect(rows[0]).toContain('О. Мельник');
      expect(rows[1]).toContain('Повернуто на доопрацювання');
      expect(rows[1]).toContain('«Немає опису»');
      expect(rows[2]).toContain('Прийнято нову версію архіву');
      expect(rows.join()).not.toContain('Не рішення');
    });

    it('the Опрацьовані tab shows the decisions table and no cards', async () => {
      await click(qa('[data-tab="done"]')[0]);
      expect(qa('.queue-card')).toHaveLength(0);
      expect(qa('[data-role="decisions"] tbody tr')).toHaveLength(3);
    });
  });

  describe('decisions (DW-7.1)', () => {
    beforeEach(() => open());

    async function reload(rows: unknown[], activity: unknown[] = ACTIVITY): Promise<void> {
      await settle(fixture, 2);
      answerLists(rows, activity);
      await settle(fixture);
    }

    it('DW-7.1 «Публікувати» approves the scenario, then the lists are read again so it leaves the queue and the journal gains a row', async () => {
      await click(action('mitosis', 'approve'));
      const req = http.expectOne('/api/scenarios/mitosis/approve');
      expect(req.request.method).toBe('POST');
      req.flush({ id: 'mitosis', status: 'published' });
      await reload(
        ROWS.filter(row => row.id !== 'mitosis').concat([{ ...REVIEW_OLD, status: 'published' }]),
        [auditRow('scenario.approve', { id: 9, scenarioId: 'mitosis', scenarioTitle: 'Мітоз клітини', actorLabel: 'Модер' }), ...ACTIVITY],
      );
      expect(cardIds()).toEqual(['complex', 'solar']);
      expect(qa('[data-role="decisions"] tbody tr')[0].textContent).toContain('Мітоз клітини');
      expect(root.querySelector('[data-role="summary"]')?.textContent).toContain('2 сценарії очікують');
    });

    it('DW-7.1 «Повернути» opens a note field; confirming rejects with the trimmed note', async () => {
      await click(action('complex', 'return'));
      expect(card('complex').querySelector('textarea')).not.toBeNull();
      const area = card('complex').querySelector('textarea')!;
      area.value = '  Додайте опис  ';
      area.dispatchEvent(new Event('input'));
      await click(action('complex', 'confirm-return'));
      const req = http.expectOne('/api/scenarios/complex/reject');
      expect(req.request.body).toEqual({ note: 'Додайте опис' });
      req.flush({ id: 'complex', status: 'rejected' });
      await reload(ROWS.filter(row => row.id !== 'complex'));
      expect(cardIds()).toEqual(['mitosis', 'solar']);
      expect(card('mitosis')).not.toBeNull();
    });

    it('an empty note rejects without one, so the server\'s default text applies', async () => {
      await click(action('mitosis', 'return'));
      await click(action('mitosis', 'confirm-return'));
      const req = http.expectOne('/api/scenarios/mitosis/reject');
      expect(req.request.body).toEqual({});
      req.flush({});
      await reload(ROWS);
    });

    it('cancelling a return closes the note field and sends nothing', async () => {
      await click(action('mitosis', 'return'));
      await click(action('mitosis', 'cancel-return'));
      expect(card('mitosis').querySelector('textarea')).toBeNull();
      http.expectNone('/api/scenarios/mitosis/reject');
    });

    it('DW-7.1 a proposal is accepted through the version route, not the scenario one', async () => {
      await click(action('solar', 'approve'));
      const req = http.expectOne('/api/scenarios/solar/versions/77/accept');
      req.flush({});
      await reload(ROWS.map(row => (row.id === 'solar' ? { ...row, pendingVersionId: null } : row)));
      expect(cardIds()).toEqual(['mitosis', 'complex']);
    });

    it('a proposal is rejected after a confirmation, with no note field', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      await click(action('solar', 'return'));
      expect(confirmSpy).toHaveBeenCalled();
      expect(card('solar').querySelector('textarea')).toBeNull();
      http.expectOne('/api/scenarios/solar/versions/77/reject').flush({});
      await reload(ROWS);
    });

    it('declining the confirmation for a proposal sends nothing', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      await click(action('solar', 'return'));
      http.expectNone('/api/scenarios/solar/versions/77/reject');
    });

    it('publishing a scenario with a problem asks first; declining sends nothing', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
      await click(action('complex', 'approve'));
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      http.expectNone('/api/scenarios/complex/approve');
    });

    it('publishing a scenario with a problem goes ahead when confirmed', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      await click(action('complex', 'approve'));
      http.expectOne('/api/scenarios/complex/approve').flush({});
      await reload(ROWS);
    });

    it('a clean scenario is published without a prompt', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm');
      await click(action('mitosis', 'approve'));
      expect(confirmSpy).not.toHaveBeenCalled();
      http.expectOne('/api/scenarios/mitosis/approve').flush({});
      await reload(ROWS);
    });

    it('the server\'s refusal is shown on that card as sent, and the card stays', async () => {
      await click(action('mitosis', 'approve'));
      http.expectOne('/api/scenarios/mitosis/approve').flush({ error: 'Сценарій уже опубліковано' }, { status: 409, statusText: 'Conflict' });
      await settle(fixture);
      expect(card('mitosis').querySelector('[role="alert"]')?.textContent).toContain('Сценарій уже опубліковано');
      expect(card('complex').querySelector('[role="alert"]')).toBeNull();
      expect(cardIds()).toContain('mitosis');
    });

    it('one decision at a time: other buttons are disabled while one is in flight', async () => {
      await click(action('mitosis', 'approve'));
      expect(action('complex', 'approve').disabled).toBe(true);
      expect(action('mitosis', 'return').disabled).toBe(true);
      http.expectOne('/api/scenarios/mitosis/approve').flush({});
      await reload(ROWS);
      expect(action('complex', 'approve').disabled).toBe(false);
    });
  });

  describe('states', () => {
    it('an empty queue says so, and the summary agrees', async () => {
      await open([DRAFT, PUBLISHED], []);
      expect(root.querySelector('[data-role="empty"]')?.textContent).toContain('Черга порожня');
      expect(root.querySelector('[data-role="summary"]')?.textContent).toContain('Немає сценаріїв, що очікують рішення');
      expect(root.querySelector('[data-role="no-decisions"]')).not.toBeNull();
    });

    it('a review without any archive has its publish button disabled', async () => {
      await open([adminRow('bare', { status: 'review', archiveSha256: null, currentVersion: null, archiveBytes: null })], []);
      expect(action('bare', 'approve').disabled).toBe(true);
    });

    it('a failed load shows the server\'s message and no cards', async () => {
      const signedIn = TestBed.inject(AdminSession).signIn('code');
      http.expectOne('/api/auth/me').flush({ role: 'moderator', label: 'М', keyId: 1 });
      await signedIn;
      fixture = TestBed.createComponent(QueueComponent);
      root = fixture.nativeElement;
      fixture.detectChanges();
      http.expectOne('/api/admin/scenarios').flush({ error: 'База недоступна' }, { status: 500, statusText: 'Server Error' });
      http.expectOne('/api/admin/dashboard').flush({ counts: {}, queueSize: 0, activity: [] });
      await settle(fixture);
      expect(root.querySelector('.banner-error')?.textContent).toContain('База недоступна');
      expect(qa('.queue-card')).toHaveLength(0);
    });

    it('shows a loading line until the first answer', async () => {
      const signedIn = TestBed.inject(AdminSession).signIn('code');
      http.expectOne('/api/auth/me').flush({ role: 'moderator', label: 'М', keyId: 1 });
      await signedIn;
      fixture = TestBed.createComponent(QueueComponent);
      root = fixture.nativeElement;
      fixture.detectChanges();
      expect(root.textContent).toContain('Завантаження');
      answerLists([], []);
      await settle(fixture);
      expect(root.textContent).not.toContain('Завантаження');
    });

    it('a journal row of a deleted scenario still reads as a decision', async () => {
      await open([], [auditRow('scenario.approve', { scenarioId: null, scenarioTitle: null })]);
      expect(root.querySelector('[data-role="decisions"] tbody td')?.textContent).toContain('Видалений сценарій');
    });
  });
});
