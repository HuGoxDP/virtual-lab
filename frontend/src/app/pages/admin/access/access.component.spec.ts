// path: src/app/pages/admin/access/access.component.spec.ts
//
// Test-plan scenario 230 (DW-7.4): a moderator issues a code (shown once, copyable), sees the last use and revokes;
// revoking one's own code signs out. window.confirm and the clipboard are stubbed (jsdom has neither).

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { KeyRow } from '../../../models/admin.model';
import { AdminService } from '../../../services/admin.service';
import { AdminSession } from '../../../services/admin-session.service';
import { settle } from '../admin-testing';
import { AccessComponent } from './access.component';

const key = (id: number, overrides: Partial<KeyRow> = {}): KeyRow => ({
  id, label: `Ключ ${id}`, role: 'author', createdAt: '2026-03-01T10:00:00Z', lastUsedAt: null, revokedAt: null, ...overrides,
});
const KEYS = [key(1, { role: 'moderator', label: 'Я', lastUsedAt: '2026-03-12T12:22:00Z' }), key(2, { label: '<b>Олена</b>' }), key(3, { revokedAt: '2026-03-05T10:00:00Z' })];

describe('AccessComponent', () => {
  let fixture: ComponentFixture<AccessComponent>;
  let root: HTMLElement;
  let http: HttpTestingController;
  let session: AdminSession;

  beforeEach(async () => {
    sessionStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    session = TestBed.inject(AdminSession);
    const signedIn = session.signIn('my-code');
    http.expectOne('/api/auth/me').flush({ role: 'moderator', label: 'Я', keyId: 1 });
    await signedIn;
    fixture = TestBed.createComponent(AccessComponent);
    root = fixture.nativeElement;
    document.body.appendChild(root);
    fixture.detectChanges();
    http.expectOne('/api/keys').flush({ keys: KEYS });
    await settle(fixture);
  });

  afterEach(() => {
    http.verify();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  const qa = (selector: string) => [...root.querySelectorAll<HTMLElement>(selector)];
  const row = (id: number) => root.querySelector<HTMLElement>(`tr[data-key="${id}"]`)!;
  const token = () => root.querySelector<HTMLInputElement>('[data-role="token"]');
  async function click(el: HTMLElement): Promise<void> { el.click(); await settle(fixture, 2); }

  async function issue(label: string, role = 'author', answer: object = { id: 9, label, role, token: 'TOKEN-ONCE-123' }): Promise<void> {
    const input = root.querySelector<HTMLInputElement>('#key-label')!;
    input.value = label;
    input.dispatchEvent(new Event('input'));
    const select = root.querySelector<HTMLSelectElement>('#key-role')!;
    select.value = role;
    select.dispatchEvent(new Event('change'));
    root.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    http.expectOne({ method: 'POST', url: '/api/keys' }).flush(answer);
    await settle(fixture, 2);
    http.expectOne('/api/keys').flush({ keys: [...KEYS, key(9, { label })] });
    await settle(fixture);
  }

  it('DW-7.4 lists the keys with role, state and last use, and marks the one in use', () => {
    expect(row(1).querySelector('[data-role="last-used"]')?.textContent).toContain('2026');
    expect(row(2).querySelector('[data-role="last-used"]')?.textContent).toBe('ще не використовувався');
    expect(row(1).textContent).toContain('це ви');
    expect(row(2).textContent).not.toContain('це ви');
    expect(row(3).textContent).toContain('Відкликано');
    expect(row(3).querySelector('[data-action="revoke"]')).toBeNull();
  });

  it('renders a key name as text, never markup', () => {
    expect(row(2).querySelector('b')).toBeNull();
    expect(row(2).textContent).toContain('<b>Олена</b>');
  });

  it('DW-7.4 issuing posts the trimmed name and role, then shows the code in a dialog', async () => {
    const input = root.querySelector<HTMLInputElement>('#key-label')!;
    input.value = '  Нова людина ';
    input.dispatchEvent(new Event('input'));
    const select = root.querySelector<HTMLSelectElement>('#key-role')!;
    select.value = 'moderator';
    select.dispatchEvent(new Event('change'));
    root.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    const req = http.expectOne({ method: 'POST', url: '/api/keys' });
    expect(req.request.body).toEqual({ label: 'Нова людина', role: 'moderator' });
    req.flush({ id: 9, label: 'Нова людина', role: 'moderator', token: 'TOKEN-ONCE-123' });
    await settle(fixture, 2);
    http.expectOne('/api/keys').flush({ keys: KEYS });
    await settle(fixture);
    expect(root.querySelector('[role="dialog"]')).not.toBeNull();
    expect(token()!.value).toBe('TOKEN-ONCE-123');
    expect(root.querySelector('[data-role="issued-label"]')?.textContent).toBe('Нова людина');
  });

  it('DW-7.4 once the dialog is closed the code is nowhere in the page and never comes back', async () => {
    await issue('Ірина');
    await click(root.querySelector<HTMLElement>('[data-action="close"]')!);
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    expect(root.textContent).not.toContain('TOKEN-ONCE-123');
    expect(root.innerHTML).not.toContain('TOKEN-ONCE-123');
    // The table (refetched) carries no code either, and nothing in storage has it.
    expect(JSON.stringify(sessionStorage)).not.toContain('TOKEN-ONCE-123');
    fixture.detectChanges();
    expect(token()).toBeNull();
  });

  it('the dialog cannot be dismissed by Escape or a stray click: only the buttons close it', async () => {
    await issue('Ірина');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    root.querySelector<HTMLElement>('.scrim')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await settle(fixture, 2);
    expect(token()!.value).toBe('TOKEN-ONCE-123');
  });

  it('DW-7.4 copy writes the code to the clipboard and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await issue('Ірина');
    await click(root.querySelector<HTMLElement>('[data-action="copy"]')!);
    expect(writeText).toHaveBeenCalledWith('TOKEN-ONCE-123');
    expect(root.querySelector('[data-role="copy-note"]')?.textContent).toBe('Скопійовано.');
  });

  it('a clipboard that is missing or refuses leaves the field to copy by hand, with a note', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    await issue('Ірина');
    await click(root.querySelector<HTMLElement>('[data-action="copy"]')!);
    expect(root.querySelector('[data-role="copy-note"]')?.textContent).toContain('вручну');
    expect(token()!.readOnly).toBe(true);
  });

  it('an empty name is refused before any request', async () => {
    root.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle(fixture, 2);
    expect(root.querySelector('[data-role="form-error"]')?.textContent).toContain('імʼя');
    http.expectNone({ method: 'POST', url: '/api/keys' });
  });

  it('a refused issue shows the server\'s message and no dialog', async () => {
    const input = root.querySelector<HTMLInputElement>('#key-label')!;
    input.value = 'X';
    input.dispatchEvent(new Event('input'));
    root.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    http.expectOne({ method: 'POST', url: '/api/keys' }).flush({ error: 'label: від 1 до 100 символів' }, { status: 400, statusText: 'x' });
    await settle(fixture);
    expect(root.querySelector('[data-role="form-error"]')?.textContent).toContain('від 1 до 100');
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });

  it('DW-7.4 revoking another key asks first, posts the revoke and re-reads the list; the session stays', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await click(row(2).querySelector<HTMLElement>('[data-action="revoke"]')!);
    http.expectOne({ method: 'POST', url: '/api/keys/2/revoke' }).flush(key(2, { revokedAt: '2026-03-12T00:00:00Z' }));
    await settle(fixture, 2);
    http.expectOne('/api/keys').flush({ keys: [KEYS[0], key(2, { revokedAt: '2026-03-12T00:00:00Z' }), KEYS[2]] });
    await settle(fixture);
    expect(row(2).textContent).toContain('Відкликано');
    expect(TestBed.inject(AdminService).isAuthenticated()).toBe(true);
  });

  it('declining the confirmation revokes nothing', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    await click(row(2).querySelector<HTMLElement>('[data-action="revoke"]')!);
    http.expectNone('/api/keys/2/revoke');
  });

  it('DW-7.4 revoking one\'s own key warns, then signs the user out', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await click(row(1).querySelector<HTMLElement>('[data-action="revoke"]')!);
    expect(confirmSpy.mock.calls[0][0]).toContain('вас буде виведено');
    http.expectOne({ method: 'POST', url: '/api/keys/1/revoke' }).flush(key(1, { revokedAt: '2026-03-12T00:00:00Z' }));
    await settle(fixture, 2);
    expect(TestBed.inject(AdminService).isAuthenticated()).toBe(false);
    expect(session.user()).toBeNull();
  });

  it('a failed revoke shows the message and keeps the session', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await click(row(1).querySelector<HTMLElement>('[data-action="revoke"]')!);
    http.expectOne('/api/keys/1/revoke').flush({ error: 'Ключ не знайдено' }, { status: 404, statusText: 'x' });
    await settle(fixture);
    expect(root.querySelector('[data-role="error"]')?.textContent).toContain('Ключ не знайдено');
    expect(TestBed.inject(AdminService).isAuthenticated()).toBe(true);
  });

  it('destroying the page with the dialog open drops the code', async () => {
    await issue('Ірина');
    fixture.destroy();
    expect(document.body.innerHTML).not.toContain('TOKEN-ONCE-123');
  });
});
