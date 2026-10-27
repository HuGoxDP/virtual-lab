// path: src/app/pages/viewer/viewer.component.spec.ts
//
// Player isolation, phase 5: the viewer created for real (no seams) in jsdom, which has no WebGL2, so it
// stops at the "unsupported" screen - the earliest point a frame could have started from. It proves the
// page creates no player frame there and shows no build stamp. The running paths are covered with a fake
// host in viewer-lifecycle.spec.ts and against a real browser in e2e.

import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { BehaviorSubject } from 'rxjs';

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
  fixture.detectChanges();
  return fixture;
}

describe('ViewerComponent without WebGL2 (jsdom)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('shows the unsupported screen and creates no player frame', async () => {
    const fixture = await render({});
    const root = fixture.nativeElement as HTMLElement;
    expect(fixture.componentInstance.state()).toBe('unsupported');
    expect(root.querySelector('iframe')).toBeNull();
    expect(root.querySelector('.build-badge')).toBeNull();
  });

  it('?diag=1 shows no stamp there: the page holds no engine to ask', async () => {
    const fixture = await render({ diag: '1' });
    expect(fixture.componentInstance.buildStampVisible()).toBe(true);
    expect(fixture.componentInstance.engineBuild()).toBe('');
    expect((fixture.nativeElement as HTMLElement).querySelector('.build-badge')).toBeNull();
  });

  it('destroying it does not throw', async () => {
    const fixture = await render({});
    expect(() => fixture.destroy()).not.toThrow();
  });
});
