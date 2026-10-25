// path: src/app/ui/toast/toast.spec.ts
//
// Covers test-plan scenario 117.
//
// Release 1, phase 2 - DW-2.4: a toast shows, hides by itself, and is announced (aria-live).

import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ToastHostComponent } from './toast-host.component';
import { TOAST_DURATION_MS, ToastService } from './toast.service';

describe('Toast', () => {
  let service: ToastService;
  let fixture: ComponentFixture<ToastHostComponent>;

  const host = (): HTMLElement => fixture.nativeElement;
  const toastText = (): string | undefined => host().querySelector('.toast')?.textContent?.trim();

  beforeEach(() => {
    vi.useFakeTimers();
    service = TestBed.inject(ToastService);
    fixture = TestBed.createComponent(ToastHostComponent);
    fixture.detectChanges();
  });

  afterEach(() => vi.useRealTimers());

  it('DW-2.4 shows the text, then hides it after the duration', () => {
    service.show('Посилання скопійовано');
    fixture.detectChanges();
    expect(toastText()).toBe('Посилання скопійовано');

    vi.advanceTimersByTime(TOAST_DURATION_MS - 1);
    fixture.detectChanges();
    expect(toastText()).toBe('Посилання скопійовано');

    vi.advanceTimersByTime(1);
    fixture.detectChanges();
    expect(toastText()).toBeUndefined();
    expect(service.message()).toBe('');
  });

  it('DW-2.4 has a polite live region that exists before any toast does', () => {
    const region = host().querySelector('[aria-live]')!;
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.getAttribute('role')).toBe('status');
    expect(region.textContent?.trim()).toBe('');
  });

  it('DW-2.4 announces inside the same live region', () => {
    service.show('Зміни збережено');
    fixture.detectChanges();
    expect(host().querySelector('[aria-live] .toast')).not.toBeNull();
  });

  it('a newer toast replaces the older one and restarts the clock', () => {
    service.show('перший');
    vi.advanceTimersByTime(2000);
    service.show('другий');
    fixture.detectChanges();
    expect(toastText()).toBe('другий');

    vi.advanceTimersByTime(2000); // 4000 ms after the first, 2000 after the second
    fixture.detectChanges();
    expect(toastText()).toBe('другий');

    vi.advanceTimersByTime(TOAST_DURATION_MS - 2000);
    fixture.detectChanges();
    expect(toastText()).toBeUndefined();
  });

  it('ignores an empty message', () => {
    service.show('');
    fixture.detectChanges();
    expect(toastText()).toBeUndefined();
  });

  it('releases its pending timer when the injector is destroyed', () => {
    service.show('x');
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    TestBed.resetTestingModule();
    expect(clear).toHaveBeenCalled();
  });
});
