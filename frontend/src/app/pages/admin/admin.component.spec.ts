// path: src/app/pages/admin/admin.component.spec.ts
//
// Release 1, phase 3. Covers test-plan scenario 131 (DW-3.8): the old /admin edits up to six
// "Що всередині" entries (icon from ICON_NAMES) and shows the server's own 400 message.

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { AdminComponent, MAX_FEATURES } from './admin.component';
import { AdminScenario } from '../../models/scenario.model';
import { AdminService } from '../../services/admin.service';
import { ICON_NAMES } from '../../ui/icon/icon.component';

function row(id: string, overrides: Partial<AdminScenario> = {}): AdminScenario {
  return {
    id, title: `T ${id}`, description: '', fullDescription: '', category: 'physics', categoryLabel: 'Фізика',
    imageUrl: '', scenarioUrl: '', version: '1.0.0', author: 'A', archiveBytes: null, updatedAt: '2026-10-01T00:00:00Z',
    features: [], status: 'published', isPublished: true, moderatorNote: null, submittedAt: null, storageKind: 'local', archiveSha256: null, manifestId: null,
    manifestVersion: null, manifestEngineVersion: null,
    ...overrides,
  };
}

describe('AdminComponent - "Що всередині" editor', () => {
  let fixture: ComponentFixture<AdminComponent>;
  let component: AdminComponent;
  let http: HttpTestingController;
  let root: HTMLElement;

  beforeEach(async () => {
    sessionStorage.clear();
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()] });
    TestBed.inject(AdminService).setToken('t');
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(AdminComponent);
    component = fixture.componentInstance;
    root = fixture.nativeElement;
    fixture.detectChanges();
  });

  afterEach(() => http.verify());

  async function settle(): Promise<void> {
    for (let i = 0; i < 4; i++) await Promise.resolve();
    fixture.detectChanges();
  }

  async function listWith(...rows: AdminScenario[]): Promise<void> {
    http.expectOne('/api/admin/scenarios').flush({ scenarios: rows });
    await settle();
  }

  const qa = (selector: string) => [...root.querySelectorAll<HTMLElement>(selector)];
  const featureRows = () => qa('.feature-row');

  function type(el: HTMLElement | Element, value: string): void {
    (el as HTMLInputElement).value = value;
    el.dispatchEvent(new Event('input'));
  }

  function pick(select: HTMLSelectElement, value: string): void {
    select.value = value;
    select.dispatchEvent(new Event('change'));
  }

  async function startCreate(): Promise<void> {
    await listWith();
    component.startCreate();
    fixture.detectChanges();
  }

  it('DW-3.8 a new scenario starts with no entries and an enabled "Додати пункт"', async () => {
    await startCreate();
    expect(featureRows().length).toBe(0);
    expect(qa('.add-feature')[0].hasAttribute('disabled')).toBe(false);
    expect(qa('legend')[0].textContent).toContain('0/6');
  });

  it('DW-3.8 the icon picker offers exactly the hosted icons', async () => {
    await startCreate();
    component.addFeature();
    fixture.detectChanges();
    const options = [...root.querySelectorAll<HTMLOptionElement>('.feature-icon option')].map(o => o.value);
    expect(options).toEqual([...ICON_NAMES]);
  });

  it('DW-3.8 six entries can be added; the button then disables and a seventh is refused', async () => {
    await startCreate();
    for (let i = 0; i < MAX_FEATURES; i++) {
      qa('.add-feature')[0].click();
      fixture.detectChanges();
    }
    expect(featureRows().length).toBe(6);
    expect(qa('.add-feature')[0].hasAttribute('disabled')).toBe(true);

    component.addFeature(); // even if the click got through, the draft refuses
    fixture.detectChanges();
    expect(featureRows().length).toBe(6);
    expect(component.draft()!.features.length).toBe(6);
  });

  it('DW-3.8 an entry can be edited and removed', async () => {
    await startCreate();
    component.addFeature();
    component.addFeature();
    fixture.detectChanges();

    pick(root.querySelector('.feature-icon') as HTMLSelectElement, 'atom');
    type(root.querySelector('.feature-title')!, 'Атоми');
    type(root.querySelector('.feature-subtitle')!, 'Будова');
    expect(component.draft()!.features[0]).toEqual({ icon: 'atom', title: 'Атоми', subtitle: 'Будова' });

    root.querySelector<HTMLButtonElement>('.feature-row .feature-remove')!.click();
    fixture.detectChanges();
    expect(featureRows().length).toBe(1);
    expect(component.draft()!.features[0].title).toBe('');
  });

  it('DW-3.8 saving sends the entries, dropping an empty subtitle', async () => {
    await startCreate();
    const draft = component.draft()!;
    component.draft.set({ ...draft, id: 'new-one', title: 'T', category: 'physics', categoryLabel: 'Фізика' });
    component.addFeature();
    component.addFeature();
    fixture.detectChanges();
    const titles = qa('.feature-title');
    type(titles[0], 'Перший');
    type(qa('.feature-subtitle')[0], 'Підпис');
    type(titles[1], 'Другий');

    void component.saveDraft();
    const post = http.expectOne(r => r.method === 'POST' && r.url === '/api/catalog');
    expect(post.request.body.features).toEqual([
      { icon: 'cube', title: 'Перший', subtitle: 'Підпис' },
      { icon: 'cube', title: 'Другий' },
    ]);
    post.flush({});
    await settle();
    http.expectOne('/api/admin/scenarios').flush({ scenarios: [] });
  });

  it('DW-3.8 editing an existing scenario loads its entries as a copy and PUTs the changes', async () => {
    const stored = [{ icon: 'flask', title: 'Колби', subtitle: 'Хімія' }];
    await listWith(row('x', { features: stored }));
    component.startEdit(component.scenarios()[0]);
    fixture.detectChanges();

    expect(featureRows().length).toBe(1);
    expect((root.querySelector('.feature-title') as HTMLInputElement).value).toBe('Колби');
    expect((root.querySelector('.feature-icon') as HTMLSelectElement).value).toBe('flask');

    type(root.querySelector('.feature-title')!, 'Пробірки');
    expect(stored[0].title).toBe('Колби'); // the list's own object is untouched

    void component.saveDraft();
    const put = http.expectOne(r => r.method === 'PUT' && r.url === '/api/catalog/x');
    expect(put.request.body.features).toEqual([{ icon: 'flask', title: 'Пробірки', subtitle: 'Хімія' }]);
    put.flush({});
    await settle();
    http.expectOne('/api/admin/scenarios').flush({ scenarios: [] });
  });

  it('a scenario row without features (older answer) opens with an empty list', async () => {
    const bare = row('y') as Partial<AdminScenario>;
    delete bare.features;
    await listWith(bare as AdminScenario);
    component.startEdit(component.scenarios()[0]);
    expect(component.draft()!.features).toEqual([]);
  });

  it('DW-3.8 a server 400 on the entries is shown in the banner with the server\'s own message', async () => {
    await startCreate();
    component.draft.set({ ...component.draft()!, id: 'bad', title: 'T', category: 'c', categoryLabel: 'C' });
    component.addFeature();
    void component.saveDraft();

    http.expectOne(r => r.method === 'POST').flush(
      { error: 'features[0].title: від 1 до 60 символів' },
      { status: 400, statusText: 'Bad Request' },
    );
    await settle();

    expect(root.querySelector('.banner-error')!.textContent).toContain('features[0].title: від 1 до 60 символів');
    expect(component.draft()).not.toBeNull(); // the editor stays open so the input is not lost
  });

  it('cancelling and starting again does not carry the old entries over', async () => {
    await startCreate();
    component.addFeature();
    component.cancelEdit();
    component.startCreate();
    expect(component.draft()!.features).toEqual([]);
  });
});
