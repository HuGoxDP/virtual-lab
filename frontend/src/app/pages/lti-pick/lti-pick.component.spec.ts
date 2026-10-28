// path: src/app/pages/lti-pick/lti-pick.component.spec.ts
//
// /lti/pick: only a deep-linking (instructor) session sees the catalog; choosing a scenario fills a
// native form that posts to /api/lti/deep-link as a top-level navigation. DW-6.1.

import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { LtiSession } from '../../models/lti.model';
import { LtiRequestError, LtiService } from '../../services/lti.service';
import { ScenarioService } from '../../services/scenario.service';
import { LtiPickComponent } from './lti-pick.component';

const DEEP_LINK: LtiSession = { scenarioId: null, role: 'instructor', messageType: 'deep-link', graded: false, submitted: null };

function setup(session: LtiSession | LtiRequestError, scenarios = [
  { id: 'electric-circuits', title: 'Електричні кола', categoryLabel: 'Фізика' },
  { id: 'solar-system', title: 'Сонячна система', categoryLabel: 'Астрономія' },
]) {
  const lti = {
    getSession: vi.fn(async () => {
      if (session instanceof LtiRequestError) throw session;
      return session;
    }),
  };
  const catalog = {
    scenarios: signal(scenarios),
    loading: signal(false),
    loaded: signal(true),
    error: signal<string | null>(null),
    loadCatalog: vi.fn(async (_filter: unknown) => undefined),
  };
  TestBed.configureTestingModule({
    providers: [{ provide: LtiService, useValue: lti }, { provide: ScenarioService, useValue: catalog }],
  });
  const fixture = TestBed.createComponent(LtiPickComponent);
  fixture.detectChanges();
  return { fixture, lti, catalog };
}

async function settle(fixture: ComponentFixture<LtiPickComponent>) {
  await fixture.whenStable();
  await Promise.resolve();
  fixture.detectChanges();
}
const el = (f: ComponentFixture<LtiPickComponent>) => f.nativeElement as HTMLElement;

describe('LtiPickComponent', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  it('a deep-linking instructor session loads and lists the catalog', async () => {
    const { fixture, catalog } = setup(DEEP_LINK);
    await settle(fixture);
    expect(catalog.loadCatalog).toHaveBeenCalledTimes(1);
    expect(el(fixture).querySelectorAll('.pick-row')).toHaveLength(2);
    expect(el(fixture).textContent).toContain('Електричні кола');
  });

  it('shows the picker only when messageType is deep-link: a resource launch gets a message and no catalog', async () => {
    const { fixture, catalog } = setup({ ...DEEP_LINK, messageType: 'resource', scenarioId: 'x' });
    await settle(fixture);
    expect(el(fixture).querySelector('.pick-row')).toBeNull();
    expect(el(fixture).querySelector('form')).toBeNull();
    expect(el(fixture).querySelector('[role=alert]')!.textContent).toContain('відкривається з Moodle');
    expect(catalog.loadCatalog).not.toHaveBeenCalled();
  });

  it('a learner is refused even on a deep-link message', async () => {
    const { fixture } = setup({ ...DEEP_LINK, role: 'learner' });
    await settle(fixture);
    expect(el(fixture).querySelector('form')).toBeNull();
  });

  it('a missing session (401) says the session ended', async () => {
    const { fixture } = setup(new LtiRequestError('x', 401));
    await settle(fixture);
    expect(el(fixture).querySelector('[role=alert]')!.textContent).toContain('Сесію Moodle завершено');
    expect(el(fixture).querySelector('form')).toBeNull();
  });

  it('another session failure says it could not be read', async () => {
    const { fixture } = setup(new LtiRequestError('x', 500));
    await settle(fixture);
    expect(el(fixture).querySelector('[role=alert]')!.textContent).toContain('Не вдалося отримати дані сесії');
  });

  it('DW-6.1 the form posts natively to /api/lti/deep-link and carries only the chosen scenarioId', async () => {
    const { fixture } = setup(DEEP_LINK);
    await settle(fixture);
    const form = el(fixture).querySelector<HTMLFormElement>('form#pick-form')!;
    expect(form.getAttribute('method')).toBe('post');
    expect(form.getAttribute('action')).toBe('/api/lti/deep-link');
    expect(form.getAttribute('target')).toBeNull(); // top-level navigation

    const submit = el(fixture).querySelector<HTMLButtonElement>('.pick-submit')!;
    expect(submit.disabled).toBe(true); // nothing chosen yet

    el(fixture).querySelectorAll<HTMLInputElement>('input[type=radio]')[1].click();
    fixture.detectChanges();

    expect(submit.disabled).toBe(false);
    expect(submit.getAttribute('form')).toBe('pick-form');
    const fields = Array.from(new FormData(form).entries());
    expect(fields).toEqual([['scenarioId', 'solar-system']]);
    expect(el(fixture).querySelectorAll('.is-selected')).toHaveLength(1);
  });

  it('searching reloads the catalog after the debounce and clears the choice', async () => {
    vi.useFakeTimers();
    const { fixture, catalog } = setup(DEEP_LINK);
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    el(fixture).querySelector<HTMLInputElement>('input[type=radio]')!.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.selectedId()).toBe('electric-circuits');

    const search = el(fixture).querySelector<HTMLInputElement>('.pick-search')!;
    search.value = 'коло';
    search.dispatchEvent(new Event('input'));
    search.value = 'коло2';
    search.dispatchEvent(new Event('input'));
    expect(catalog.loadCatalog).toHaveBeenCalledTimes(1); // only the initial load so far

    await vi.advanceTimersByTimeAsync(300);
    expect(catalog.loadCatalog).toHaveBeenCalledTimes(2);
    expect(catalog.loadCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'коло2' }));
    expect(fixture.componentInstance.selectedId()).toBeNull();
  });

  it('an empty result and a catalog error are stated', async () => {
    const { fixture, catalog } = setup(DEEP_LINK, []);
    await settle(fixture);
    expect(el(fixture).textContent).toContain('Нічого не знайдено');

    catalog.error.set('Не вдалося завантажити каталог');
    fixture.detectChanges();
    expect(el(fixture).querySelector('[role=alert]')!.textContent).toContain('Не вдалося завантажити каталог');
  });

  it('destroying it cancels a pending search', async () => {
    vi.useFakeTimers();
    const { fixture, catalog } = setup(DEEP_LINK);
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    const search = el(fixture).querySelector<HTMLInputElement>('.pick-search')!;
    search.value = 'x';
    search.dispatchEvent(new Event('input'));
    fixture.destroy();
    await vi.advanceTimersByTimeAsync(500);
    expect(catalog.loadCatalog).toHaveBeenCalledTimes(1);
  });
});
