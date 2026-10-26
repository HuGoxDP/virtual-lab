// path: src/app/pages/viewer/viewer-hud.component.spec.ts
//
// Covers test-plan scenario 140 (DW-4.2, DW-4.4, DW-4.7).
//
// The HUD is presentational: inputs decide what renders, buttons emit outputs. Nothing is faked —
// the FPS slot and the pause button exist only when their inputs are supplied.

import { TestBed } from '@angular/core/testing';

import { ViewerHudComponent } from './viewer-hud.component';

async function render(inputs: Record<string, unknown> = {}) {
  const fixture = TestBed.createComponent(ViewerHudComponent);
  const emitted: string[] = [];
  const c = fixture.componentInstance;
  c.exit.subscribe(() => emitted.push('exit'));
  c.togglePause.subscribe(() => emitted.push('togglePause'));
  c.restart.subscribe(() => emitted.push('restart'));
  c.fullscreen.subscribe(() => emitted.push('fullscreen'));
  for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
  fixture.detectChanges();
  await fixture.whenStable();
  return { root: fixture.nativeElement as HTMLElement, emitted, fixture };
}

const label = (root: HTMLElement, aria: string) => root.querySelector<HTMLButtonElement>(`button[aria-label="${aria}"]`);

describe('ViewerHudComponent', () => {
  it('DW-4.2 renders exit, the title, and restart / fullscreen with Ukrainian aria-labels', async () => {
    const { root } = await render({ title: 'Сонячна система', canRestart: true });
    expect(root.querySelector('button.exit')?.textContent?.trim()).toBe('Вийти');
    expect(root.querySelector('.title-text')?.textContent?.trim()).toBe('Сонячна система');
    expect(label(root, 'Спочатку')).not.toBeNull();
    expect(label(root, 'На весь екран')).not.toBeNull();
    expect(root.querySelector('.viewer-controls')).not.toBeNull();
  });

  it('DW-4.2 hides the FPS slot when fps is null', async () => {
    const { root } = await render({ title: 'T', fps: null });
    expect(root.querySelector('.fps')).toBeNull();
    expect(root.querySelector('.divider')).toBeNull();
  });

  it('DW-4.2 shows a rounded FPS when it is supplied (0 counts as supplied)', async () => {
    const { root, fixture } = await render({ title: 'T', fps: 59.6 });
    expect(root.querySelector('.fps')?.textContent?.trim()).toBe('60 FPS');
    fixture.componentRef.setInput('fps', 0);
    fixture.detectChanges();
    expect(root.querySelector('.fps')?.textContent?.trim()).toBe('0 FPS');
  });

  it('DW-4.2 hides the pause button (and the Space hint) when canPause is false', async () => {
    const { root } = await render({ title: 'T', canPause: false });
    expect(label(root, 'Пауза')).toBeNull();
    expect(label(root, 'Продовжити')).toBeNull();
    expect(root.querySelector('.hints')?.textContent).not.toContain('Space');
  });

  it('DW-4.2 shows pause when canPause is true, and swaps its label while paused', async () => {
    const { root, fixture } = await render({ title: 'T', canPause: true });
    expect(label(root, 'Пауза')).not.toBeNull();
    expect(root.querySelector('.hints')?.textContent).toContain('Space — пауза');

    fixture.componentRef.setInput('paused', true);
    fixture.detectChanges();
    expect(label(root, 'Продовжити')).not.toBeNull();
    expect(label(root, 'Пауза')).toBeNull();
  });

  it('DW-4.2 every button fires its output', async () => {
    const { root, emitted } = await render({ title: 'T', canPause: true, canRestart: true });
    root.querySelector<HTMLButtonElement>('button.exit')!.click();
    label(root, 'Пауза')!.click();
    label(root, 'Спочатку')!.click();
    label(root, 'На весь екран')!.click();
    expect(emitted).toEqual(['exit', 'togglePause', 'restart', 'fullscreen']);
  });

  it('DW-4.4 restart is disabled (not hidden) unless canRestart, and a disabled click emits nothing', async () => {
    const { root, emitted, fixture } = await render({ title: 'T', canRestart: false });
    expect(label(root, 'Спочатку')!.disabled).toBe(true);
    label(root, 'Спочатку')!.click();
    expect(emitted).toEqual([]);

    fixture.componentRef.setInput('canRestart', true);
    fixture.detectChanges();
    expect(label(root, 'Спочатку')!.disabled).toBe(false);
  });

  it('DW-4.2 Space does nothing: no key handling in the page, with or without canPause', async () => {
    const { root, emitted } = await render({ title: 'T', canPause: true });
    for (const target of [root, document.body, document]) {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
    }
    expect(emitted).toEqual([]);
  });

  it('renders no title badge for an empty title', async () => {
    const { root } = await render({ title: '' });
    expect(root.querySelector('.title-badge')).toBeNull();
  });

  it('DW-5.3 has no diagnostics output or control, whatever else is on', async () => {
    const { root } = await render({ title: 'T', fps: 60, canPause: true, canRestart: true });
    expect(root.querySelector('button[aria-label*="іагностик"]')).toBeNull();
    expect(root.querySelector('.control-btn[aria-label="Показати діагностику"]')).toBeNull();
    expect(root.querySelectorAll('.viewer-controls button').length).toBe(3); // pause, restart, fullscreen
    expect((root.querySelector('.viewer-controls') as HTMLElement).textContent).not.toMatch(/діагност|VRAM|profil/i);
    expect(Object.keys((TestBed.createComponent(ViewerHudComponent).componentInstance as object))).not.toContain('toggleDiagnostics');
  });
});
