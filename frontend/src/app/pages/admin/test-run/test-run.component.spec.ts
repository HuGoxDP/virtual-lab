// path: src/app/pages/admin/test-run/test-run.component.spec.ts
//
// Test-plan scenario 228 (DW-7.5): one test run in this browser, on its own: the archive goes to the player, the
// measurement becomes the report, a failure becomes an error report, and the host is disposed on every way out.

import { ComponentFixture, TestBed } from '@angular/core/testing';

import { TestRun } from '../../../models/admin.model';
import { PLAYER_HOST_FACTORY } from '../../../player/player-config';
import { settle } from '../admin-testing';
import { TestRunComponent } from './test-run.component';

const METRICS = { timeToFirstFrameMs: 1200, avgFps: 60, gpuMemoryBytes: 1000, consoleErrors: 2, engineBuild: 'b1' };

describe('TestRunComponent', () => {
  let fixture: ComponentFixture<TestRunComponent>;
  let host: { load: ReturnType<typeof vi.fn>; measure: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> };
  let finished: TestRun[];
  let cancelled: number;
  let made: number;

  function setup(hostOverrides: Partial<typeof host> = {}, response: Response = new Response(new Blob(['zip']))): void {
    made = 0;
    host = { load: vi.fn().mockResolvedValue(undefined), measure: vi.fn().mockResolvedValue(METRICS), dispose: vi.fn(), ...hostOverrides };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    TestBed.configureTestingModule({ providers: [{ provide: PLAYER_HOST_FACTORY, useValue: () => { made++; return host; } }] });
    fixture = TestBed.createComponent(TestRunComponent);
    finished = [];
    cancelled = 0;
    fixture.componentInstance.finished.subscribe(r => finished.push(r));
    fixture.componentInstance.cancelled.subscribe(() => cancelled++);
    fixture.componentRef.setInput('url', '/scenarios/abc.zip');
    fixture.detectChanges();
  }

  afterEach(() => vi.unstubAllGlobals());

  const status = () => (fixture.nativeElement as HTMLElement).querySelector('[data-role="status"]')?.textContent;

  it('DW-7.5 downloads the archive, runs it in the player, measures 10 s and emits the report once', async () => {
    setup();
    await settle(fixture, 12);
    expect(fetch).toHaveBeenCalledWith('/scenarios/abc.zip', expect.objectContaining({ signal: expect.anything() }));
    expect(host.load).toHaveBeenCalledWith({ kind: 'blob', blob: expect.any(Blob) }, { diag: false });
    expect(host.measure).toHaveBeenCalledWith(10);
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ timeToFirstFrameMs: 1200, avgFps: 60, consoleErrors: 2, engineBuild: 'b1' });
    expect(finished[0].userAgent).toBeTruthy();
    expect(host.dispose).toHaveBeenCalled();
  });

  it('says what it is doing while it waits', async () => {
    setup({ measure: vi.fn().mockReturnValue(new Promise(() => undefined)) });
    expect(status()).toContain('Завантаження');
    await settle(fixture, 12);
    expect(status()).toContain('Вимірювання');
    expect(finished).toHaveLength(0);
  });

  it('DW-7.5 an archive that answers 404 is reported as an error and no player is made', async () => {
    setup({}, new Response('', { status: 404 }));
    await settle(fixture, 12);
    expect(finished).toHaveLength(1);
    expect(finished[0].error).toContain('404');
    expect(finished[0].avgFps).toBeUndefined();
    expect(made).toBe(0);
  });

  it('DW-7.5 a player that fails to load is reported as an error and still disposed', async () => {
    setup({ load: vi.fn().mockRejectedValue(new Error('boom')) });
    await settle(fixture, 12);
    expect(finished).toEqual([expect.objectContaining({ error: 'boom' })]);
    expect(host.measure).not.toHaveBeenCalled();
    expect(host.dispose).toHaveBeenCalled();
  });

  it('a rejection that is not an Error is still reported as text', async () => {
    setup({ load: vi.fn().mockRejectedValue('plain') });
    await settle(fixture, 12);
    expect(finished[0].error).toBe('plain');
  });

  it('cancel disposes the host, emits cancelled once and never emits a report', async () => {
    setup({ measure: vi.fn().mockReturnValue(new Promise(() => undefined)) });
    await settle(fixture, 12);
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-action="cancel-run"]')!.click();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-action="cancel-run"]')!.click();
    await settle(fixture, 4);
    expect(cancelled).toBe(1);
    expect(host.dispose).toHaveBeenCalledTimes(1);
    expect(finished).toHaveLength(0);
  });

  it('cancelling during the download aborts it and starts no player', async () => {
    setup();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-action="cancel-run"]')!.click();
    await settle(fixture, 12);
    expect(made).toBe(0);
    expect(finished).toHaveLength(0);
  });

  it('destroying the component mid-run disposes the host and emits nothing', async () => {
    setup({ measure: vi.fn().mockReturnValue(new Promise(() => undefined)) });
    await settle(fixture, 12);
    fixture.destroy();
    expect(host.dispose).toHaveBeenCalled();
    expect(finished).toHaveLength(0);
    expect(cancelled).toBe(0);
  });
});
