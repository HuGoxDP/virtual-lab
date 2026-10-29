// path: src/app/pages/admin/dashboard/dashboard.component.spec.ts
//
// Test-plan scenario 227 (DW-7.2): the landing page shows the counts and the activity the server scoped to the
// caller, the queue size for a moderator only, and quick actions that follow the role.

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';

import { AdminSession } from '../../../services/admin-session.service';
import { auditRow, settle } from '../admin-testing';
import { DashboardComponent } from './dashboard.component';

const BODY = {
  counts: { draft: 2, review: 3, published: 9, rejected: 1 },
  queueSize: 4,
  activity: [
    auditRow('scenario.approve', { id: 1, scenarioId: 'solar', scenarioTitle: 'Сонячна система <i>X</i>', actorLabel: 'О. Мельник', createdAt: '2026-03-12T12:22:00Z' }),
    auditRow('scenario.reject', { id: 2, scenarioId: 'rome', scenarioTitle: 'Рим', details: { note: 'Немає опису' } }),
    auditRow('key.create', { id: 3, scenarioId: null, scenarioTitle: null, actorLabel: 'bootstrap' }),
  ],
};

describe('DashboardComponent', () => {
  let fixture: ComponentFixture<DashboardComponent>;
  let root: HTMLElement;
  let http: HttpTestingController;

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function openAs(role: 'author' | 'moderator', body: object = BODY, label = 'Олена'): Promise<void> {
    const signedIn = TestBed.inject(AdminSession).signIn('code');
    http.expectOne('/api/auth/me').flush({ role, label, keyId: role === 'author' ? 4 : 1 });
    await signedIn;
    fixture = TestBed.createComponent(DashboardComponent);
    root = fixture.nativeElement;
    fixture.detectChanges();
    http.expectOne('/api/admin/dashboard').flush(body);
    await settle(fixture);
  }

  const qa = (selector: string) => [...root.querySelectorAll<HTMLElement>(selector)];
  const counts = () => Object.fromEntries(qa('.counter').map(el => [el.getAttribute('data-status'), el.querySelector('[data-role="count"]')?.textContent]));
  const links = () => qa('.quick a').map(el => [el.textContent?.trim(), el.getAttribute('href')]);

  it('DW-7.2 greets the user by the name the server reported', async () => {
    await openAs('author');
    expect(root.querySelector('[data-role="greeting"]')?.textContent).toBe('Вітаємо, Олена');
  });

  it('DW-7.2 shows the count of every status, zero included', async () => {
    await openAs('author', { ...BODY, counts: { draft: 0, review: 0, published: 5, rejected: 0 } });
    expect(counts()).toEqual({ published: '5', review: '0', draft: '0', rejected: '0' });
  });

  it('DW-7.2 an author sees their own counts and no queue block', async () => {
    await openAs('author');
    expect(counts()).toEqual({ published: '9', review: '3', draft: '2', rejected: '1' });
    expect(root.querySelector('[data-role="queue"]')).toBeNull();
    expect(root.querySelector('.sub')?.textContent).toBe('Ваші сценарії');
  });

  it('DW-7.2 a moderator sees the queue size, pluralised, linking to the queue', async () => {
    await openAs('moderator');
    const queue = root.querySelector('[data-role="queue"]')!;
    expect(queue.textContent?.replace(/\s+/g, ' ')).toContain('4 сценарії очікують рішення');
    expect(queue.getAttribute('href')).toBe('/admin/queue');
    expect(root.querySelector('.sub')?.textContent).toBe('Усі сценарії каталогу');
  });

  it('a moderator with an empty queue is told so', async () => {
    await openAs('moderator', { ...BODY, queueSize: 0 });
    expect(root.querySelector('[data-role="queue"]')?.textContent).toContain('Черга модерації порожня');
  });

  it('DW-7.2 lists the activity as sentences with the actor and date, linking to the scenario', async () => {
    await openAs('moderator');
    const rows = qa('[data-role="activity-row"]');
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent?.replace(/\s+/g, ' ')).toContain('Опубліковано в каталозі: Сонячна система <i>X</i>');
    expect(rows[0].textContent).toContain('О. Мельник');
    expect(rows[0].querySelector('a')?.getAttribute('href')).toBe('/admin/scenarios/solar/publish');
    expect(rows[1].textContent).toContain('«Немає опису»');
  });

  it('activity text is never interpreted as markup', async () => {
    await openAs('moderator');
    expect(root.querySelector('[data-role="activity-row"] i')).toBeNull();
  });

  it('a journal row without a scenario (a key, a category) has no link', async () => {
    await openAs('moderator');
    const row = qa('[data-role="activity-row"]')[2];
    expect(row.textContent).toContain('Видано код доступу');
    expect(row.querySelector('a')).toBeNull();
  });

  it('no activity shows an empty note', async () => {
    await openAs('author', { ...BODY, activity: [] });
    expect(root.querySelector('[data-role="no-activity"]')).not.toBeNull();
  });

  it('DW-7.2 an author\'s quick actions are the upload and their list', async () => {
    await openAs('author');
    expect(links()).toEqual([['Новий сценарій', '/admin/upload'], ['Мої сценарії', '/admin/scenarios']]);
  });

  it('DW-7.2 a moderator\'s quick actions add the queue, categories and access', async () => {
    await openAs('moderator');
    expect(links()).toEqual([
      ['Новий сценарій', '/admin/upload'], ['Усі сценарії', '/admin/scenarios'], ['Черга модерації', '/admin/queue'],
      ['Напрями', '/admin/categories'], ['Доступ', '/admin/access'],
    ]);
  });

  it('a failed load shows the server\'s message instead of the page', async () => {
    const signedIn = TestBed.inject(AdminSession).signIn('code');
    http.expectOne('/api/auth/me').flush({ role: 'author', label: 'А', keyId: 4 });
    await signedIn;
    fixture = TestBed.createComponent(DashboardComponent);
    root = fixture.nativeElement;
    fixture.detectChanges();
    http.expectOne('/api/admin/dashboard').flush({ error: 'Помилка сервера' }, { status: 500, statusText: 'x' });
    await settle(fixture);
    expect(root.querySelector('.banner-error')?.textContent).toContain('Помилка сервера');
    expect(qa('.counter')).toHaveLength(0);
  });

  it('shows a loading line before the answer', async () => {
    const signedIn = TestBed.inject(AdminSession).signIn('code');
    http.expectOne('/api/auth/me').flush({ role: 'author', label: 'А', keyId: 4 });
    await signedIn;
    fixture = TestBed.createComponent(DashboardComponent);
    root = fixture.nativeElement;
    fixture.detectChanges();
    expect(root.textContent).toContain('Завантаження');
    http.expectOne('/api/admin/dashboard').flush(BODY);
    await settle(fixture);
    expect(root.textContent).not.toContain('Завантаження');
  });
});
