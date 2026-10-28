// path: src/app/ui/modal/modal.component.spec.ts
//
// Test-plan scenario 225 (DW-7.4, DW-7.5 support): the dialog primitive under the one-time token and the test run.

import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { ModalComponent } from './modal.component';

@Component({
  standalone: true,
  imports: [ModalComponent],
  template: `
    <button id="opener">open</button>
    @if (open()) {
      <vl-modal heading="Заголовок" [dismissible]="dismissible()" (closed)="onClosed()">
        <button id="first" data-autofocus>Перша</button>
        <button id="last">Остання</button>
      </vl-modal>
    }
  `,
})
class Host {
  open = signal(false);
  dismissible = signal(true);
  closes = 0;
  onClosed(): void { this.closes++; this.open.set(false); }
}

describe('ModalComponent', () => {
  function mount() {
    const fixture = TestBed.createComponent(Host);
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const open = () => { root.querySelector<HTMLElement>('#opener')!.focus(); fixture.componentInstance.open.set(true); fixture.detectChanges(); };
    return { fixture, root, open, host: fixture.componentInstance };
  }
  const key = (name: string, init: KeyboardEventInit = {}) =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }));

  afterEach(() => document.body.replaceChildren());

  it('is a labelled modal dialog and moves focus to its autofocus element', () => {
    const { root, open } = mount();
    open();
    expect(root.querySelector('[role="dialog"]')!.getAttribute('aria-modal')).toBe('true');
    expect(root.querySelector('#modal-title')?.textContent).toBe('Заголовок');
    expect(document.activeElement?.id).toBe('first');
  });

  it('Escape asks to close, and focus returns to the opener once it is gone', () => {
    const { fixture, root, open, host } = mount();
    open();
    key('Escape');
    fixture.detectChanges();
    expect(host.closes).toBe(1);
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement?.id).toBe('opener');
  });

  it('a click on the scrim closes it, a click inside the panel does not', () => {
    const { fixture, root, open, host } = mount();
    open();
    root.querySelector<HTMLElement>('.panel')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(host.closes).toBe(0);
    root.querySelector<HTMLElement>('.scrim')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    fixture.detectChanges();
    expect(host.closes).toBe(1);
  });

  it('a non-dismissible dialog ignores Escape and the scrim', () => {
    const { root, open, host } = mount();
    host.dismissible.set(false);
    open();
    key('Escape');
    root.querySelector<HTMLElement>('.scrim')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(host.closes).toBe(0);
  });

  it('Tab on the last control wraps to the first, Shift+Tab on the first to the last', () => {
    const { root, open } = mount();
    open();
    root.querySelector<HTMLElement>('#last')!.focus();
    key('Tab');
    expect(document.activeElement?.id).toBe('first');
    key('Tab', { shiftKey: true });
    expect(document.activeElement?.id).toBe('last');
  });

  it('Tab with focus outside the panel pulls it back in', () => {
    const { root, open } = mount();
    open();
    root.querySelector<HTMLElement>('#opener')!.focus();
    key('Tab');
    expect(document.activeElement?.id).toBe('first');
  });
});
