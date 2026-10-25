// path: src/app/pages/viewer/viewer-loading.component.spec.ts
//
// Covers test-plan scenario 139 (DW-4.1, DW-4.7).

import { TestBed } from '@angular/core/testing';

import { ViewerLoadingComponent } from './viewer-loading.component';

async function render(inputs: Record<string, unknown>) {
  const fixture = TestBed.createComponent(ViewerLoadingComponent);
  const cancelled: number[] = [];
  fixture.componentInstance.cancel.subscribe(() => cancelled.push(1));
  for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
  fixture.detectChanges();
  await fixture.whenStable();
  return { root: fixture.nativeElement as HTMLElement, cancelled, fixture };
}

const text = (root: HTMLElement, selector: string) => root.querySelector(selector)?.textContent?.trim();

describe('ViewerLoadingComponent', () => {
  it('DW-4.1 shows percent, title, byte line, stage and the cancel button', async () => {
    const MB = 1024 * 1024;
    const { root } = await render({
      title: 'Сонячна система', percent: 42, loadedBytes: 3.2 * MB, totalBytes: 48.2 * MB,
      stage: 'Отримання даних із сервера',
    });
    expect(text(root, '.loader-percent')).toBe('42%');
    expect(text(root, '.loader-title')).toBe('Сонячна система');
    expect(text(root, '.loader-bytes')).toBe('Завантаження архіву — 3,2 з 48,2 МБ');
    expect(text(root, '.loader-stage')).toBe('Отримання даних із сервера');
    expect(text(root, 'button.cancel')).toBe('Скасувати');
  });

  it('DW-4.1 the cancel button emits cancel', async () => {
    const { root, cancelled } = await render({ title: 'x' });
    root.querySelector<HTMLButtonElement>('button.cancel')!.click();
    expect(cancelled).toHaveLength(1);
  });

  it('DW-4.1 unknown total prints the loaded size alone', async () => {
    const { root } = await render({ loadedBytes: 5 * 1024 * 1024, totalBytes: 0 });
    expect(text(root, '.loader-bytes')).toBe('Завантаження архіву — 5,0 МБ');
  });

  it('hides the byte line when no archive is downloaded (streamed path)', async () => {
    const { root } = await render({ percent: 10, loadedBytes: null });
    expect(root.querySelector('.loader-bytes')).toBeNull();
  });

  it('the ring offset follows the percent and the percent is clamped to 0-100', async () => {
    const { root, fixture } = await render({ percent: 50 });
    const offset = () => root.querySelector<SVGCircleElement>('.progress')!.style.strokeDashoffset;
    expect(offset()).toBe('132');

    fixture.componentRef.setInput('percent', 250);
    fixture.detectChanges();
    expect(text(root, '.loader-percent')).toBe('100%');
    expect(offset()).toBe('0');

    fixture.componentRef.setInput('percent', -5);
    fixture.detectChanges();
    expect(text(root, '.loader-percent')).toBe('0%');
    expect(offset()).toBe('264');

    fixture.componentRef.setInput('percent', Number.NaN);
    fixture.detectChanges();
    expect(text(root, '.loader-percent')).toBe('0%');
  });

  it('the bar width follows the percent', async () => {
    const { root } = await render({ percent: 37 });
    expect(root.querySelector<HTMLElement>('.fill')!.style.width).toBe('37%');
  });
});
