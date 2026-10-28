// path: src/app/pages/viewer/viewer-lti.spec.ts
//
// The viewer in LTI mode (`?lti=1`) on the fake PlayerHost seam (same as viewer-lifecycle.spec.ts):
// the scenario's `onResult` reaches the submit controls, even when it arrives before the session
// loaded, and the public viewer shows no LTI controls and never asks the LTI endpoints. DW-6.1, DW-6.2.

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import type { PlayerHostOptions, PlayerLoadSource } from 'WebEngineTS/player-host';

import { LtiSession } from '../../models/lti.model';
import { LtiService } from '../../services/lti.service';
import { ScenarioService } from '../../services/scenario.service';
import { TelemetryService } from '../../services/telemetry.service';
import { ViewerComponent } from './viewer.component';

const ITEM = { id: 'electric-circuits', title: 'Електричні кола', scenarioUrl: '/scenarios/a.zip', manifestUrl: null };
const GRADED: LtiSession = { scenarioId: 'electric-circuits', role: 'learner', messageType: 'resource', graded: true, submitted: null };

type Callbacks = NonNullable<PlayerHostOptions['callbacks']>;

function setup(opts: { query?: Record<string, string>; session?: Promise<LtiSession> | LtiSession } = {}) {
  const host = {
    options: undefined as unknown as PlayerHostOptions,
    load: vi.fn(async (_s: PlayerLoadSource, _o: { diag: boolean }): Promise<void> => undefined),
    restart: vi.fn(async (): Promise<void> => undefined),
    pause: vi.fn(),
    resume: vi.fn(),
    measure: vi.fn(),
    dispose: vi.fn(),
    cb: () => host.options.callbacks as Callbacks,
  };
  const service = {
    fetchScenarioById: vi.fn(async () => ITEM),
    downloadScenarioZip: vi.fn(async () => new ArrayBuffer(8)),
  };
  const lti = {
    getSession: vi.fn(async () => opts.session ?? GRADED),
    submit: vi.fn(async (_score?: number) => ({ score: 0.85 })),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.spyOn(ViewerComponent as any, 'supportsWebGL2').mockReturnValue(true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.spyOn(ViewerComponent.prototype as any, 'createPlayerHost').mockImplementation(((_c: HTMLElement, options: PlayerHostOptions) => {
    host.options = options;
    return host;
  }) as never);

  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: ScenarioService, useValue: service },
      { provide: TelemetryService, useValue: { startSession: vi.fn(async () => undefined), endSession: vi.fn() } },
      { provide: LtiService, useValue: lti },
      {
        provide: ActivatedRoute,
        useValue: {
          snapshot: { queryParamMap: convertToParamMap(opts.query ?? {}) },
          paramMap: new BehaviorSubject(convertToParamMap({ id: ITEM.id })),
        },
      },
    ],
  });
  vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  const fixture = TestBed.createComponent(ViewerComponent);
  fixture.detectChanges();
  return { fixture, host, lti };
}

async function running(fixture: ComponentFixture<ViewerComponent>) {
  await vi.waitFor(() => expect(fixture.componentInstance.state()).toBe('running'));
  fixture.detectChanges();
  await fixture.whenStable();
  await Promise.resolve();
  fixture.detectChanges();
}
const el = (f: ComponentFixture<ViewerComponent>) => f.nativeElement as HTMLElement;
const submitButton = (f: ComponentFixture<ViewerComponent>) => el(f).querySelector<HTMLElement>('.lti-submit');
const text = (f: ComponentFixture<ViewerComponent>) => (el(f).querySelector('vl-lti-submit')?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('ViewerComponent in LTI mode', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  it('DW-6.2 without ?lti=1 there are no LTI controls and no LTI request', async () => {
    const { fixture, lti } = setup();
    await running(fixture);
    expect(fixture.componentInstance.ltiMode()).toBe(false);
    expect(el(fixture).querySelector('vl-lti-submit')).toBeNull();
    expect(lti.getSession).not.toHaveBeenCalled();
  });

  it('DW-6.2 a different ?lti value is not LTI mode either', async () => {
    const { fixture, lti } = setup({ query: { lti: '0' } });
    await running(fixture);
    expect(el(fixture).querySelector('vl-lti-submit')).toBeNull();
    expect(lti.getSession).not.toHaveBeenCalled();
  });

  it('DW-6.1 with ?lti=1 the running viewer shows the submit controls', async () => {
    const { fixture, lti } = setup({ query: { lti: '1' } });
    await running(fixture);
    expect(lti.getSession).toHaveBeenCalledTimes(1);
    expect(submitButton(fixture)!.textContent!.trim()).toBe('Здати');
  });

  it('the controls are not shown while the scenario is still loading', async () => {
    const { fixture, host } = setup({ query: { lti: '1' } });
    host.load.mockReturnValue(new Promise(() => undefined));
    await vi.waitFor(() => expect(fixture.componentInstance.state()).toBe('loading-engine'));
    fixture.detectChanges();
    expect(el(fixture).querySelector('vl-lti-submit')).toBeNull();
  });

  it('DW-6.1 the latest onResult score reaches the confirmation', async () => {
    const { fixture, host, lti } = setup({ query: { lti: '1' } });
    await running(fixture);

    host.cb().onResult!({ score: 0.2, completed: false });
    host.cb().onResult!({ score: 0.85, completed: true });
    fixture.detectChanges();
    submitButton(fixture)!.click();
    fixture.detectChanges();
    expect(text(fixture)).toContain('Ваш результат: 85 з 100');

    el(fixture).querySelector<HTMLElement>('.lti-confirm-yes')!.click();
    await fixture.whenStable();
    expect(lti.submit).toHaveBeenCalledExactlyOnceWith(0.85);
  });

  it('DW-6.1 a result that arrives before the session has loaded is kept', async () => {
    let release!: (s: LtiSession) => void;
    const session = new Promise<LtiSession>(resolve => { release = resolve; });
    const { fixture, host } = setup({ query: { lti: '1' }, session });
    await running(fixture);

    host.cb().onResult!({ score: 0.6, completed: true }); // the session is still pending
    release(GRADED);
    await fixture.whenStable();
    await Promise.resolve();
    fixture.detectChanges();

    submitButton(fixture)!.click();
    fixture.detectChanges();
    expect(text(fixture)).toContain('Ваш результат: 60 з 100');
  });

  it('a restart clears the previous run\'s result', async () => {
    const { fixture, host } = setup({ query: { lti: '1' } });
    await running(fixture);
    host.cb().onResult!({ score: 0.9, completed: true });
    expect(fixture.componentInstance.ltiResult()).toEqual({ score: 0.9, completed: true });

    await fixture.componentInstance.restart();
    expect(fixture.componentInstance.ltiResult()).toBeNull();
  });
});
