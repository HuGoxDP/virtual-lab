// path: src/app/pages/viewer/viewer.component.spec.ts
//
// Release 1, phase 5 - DW-5.3 (unit part): the viewer shuts the profiler gate before anything can
// load, even with `?diag=1`, and `?diag=1` shows only the build stamp. jsdom has no WebGL2, so the
// component stops at its "unsupported" screen - which is exactly the earliest point a load could
// have started from; the e2e suite covers the running scenario.

import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { BehaviorSubject } from 'rxjs';
import { MemoryProfiler } from 'WebEngineTS';

import { ViewerComponent } from './viewer.component';

async function render(query: Record<string, string>) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      {
        provide: ActivatedRoute,
        useValue: {
          snapshot: { queryParamMap: convertToParamMap(query) },
          paramMap: new BehaviorSubject(convertToParamMap({ id: 'solar-system' })),
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(ViewerComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges(); // the flag is read in ngAfterViewInit, after the first check
  return fixture;
}

describe('ViewerComponent profiler policy', () => {
  beforeEach(() => {
    MemoryProfiler.diagnosticsAllowed = true; // the engine default: open
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    MemoryProfiler.diagnosticsAllowed = true;
  });

  it('DW-5.3 sets diagnosticsAllowed = false on init without ?diag=1', async () => {
    const fixture = await render({});
    expect(MemoryProfiler.diagnosticsAllowed).toBe(false);
    expect((fixture.nativeElement as HTMLElement).querySelector('.build-badge')).toBeNull();
  });

  it('DW-5.3 sets diagnosticsAllowed = false on init even with ?diag=1', async () => {
    await render({ diag: '1' });
    expect(MemoryProfiler.diagnosticsAllowed).toBe(false);
  });

  it('DW-5.3 ?diag=1 shows the build stamp and nothing else', async () => {
    const fixture = await render({ diag: '1' });
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.build-badge')!.textContent).toMatch(/engine/);
    expect(MemoryProfiler.isOverlayVisible).toBe(false);
  });

  it('DW-5.3 the viewer exposes no diagnostics toggle', async () => {
    const viewer = (await render({ diag: '1' })).componentInstance as unknown as Record<string, unknown>;
    expect(viewer['toggleDiagnostics']).toBeUndefined();
    expect(viewer['diagnosticsVisible']).toBeUndefined();
    expect(viewer['enforceDiagnosticsPolicy']).toBeUndefined();
  });

  it('DW-5.3 destroying the viewer leaves the gate shut and the overlay closed', async () => {
    const fixture = await render({ diag: '1' });
    fixture.destroy();
    expect(MemoryProfiler.diagnosticsAllowed).toBe(false);
    expect(MemoryProfiler.isOverlayVisible).toBe(false);
  });
});
