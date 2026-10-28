// path: src/app/ui/modal/modal.component.ts

import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, HostListener, OnDestroy, inject, input, output, viewChild } from '@angular/core';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal dialog: a scrim and a panel with `role="dialog"`. Focus moves into the panel when it opens,
 * Tab stays inside it, Escape and a click on the scrim ask to close (`closed`), and focus returns to
 * whatever had it before. The parent owns whether it exists (`@if`); content is projected. A dialog that
 * must not be dismissed by accident (`dismissible=false`) ignores both Escape and the scrim.
 */
@Component({
  selector: 'vl-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    .scrim { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; padding: var(--space-4);
             background: rgba(0, 0, 0, 0.6); }
    .panel { width: min(560px, 100%); max-height: calc(100dvh - 2 * var(--space-4)); overflow-y: auto; padding: var(--space-6);
             background: var(--color-surface); border-radius: var(--radius-md); box-shadow: var(--shadow-lg); }
    h2 { margin: 0 0 var(--space-4); font-size: 18px; overflow-wrap: anywhere; }
    .panel:focus { outline: none; }
  `,
  template: `
    <div class="scrim" (mousedown)="onScrim($event)">
      <div class="panel" #panel role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1">
        <h2 id="modal-title">{{ heading() }}</h2>
        <ng-content />
      </div>
    </div>
  `,
})
export class ModalComponent implements AfterViewInit, OnDestroy {
  readonly heading = input.required<string>();
  /** Whether Escape and the scrim close it. */
  readonly dismissible = input(true);
  /** The user asked to close (Escape or the scrim); the parent removes the dialog. */
  readonly closed = output<void>();

  private readonly panel = viewChild.required<ElementRef<HTMLElement>>('panel');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private previous: Element | null = null;

  ngAfterViewInit(): void {
    this.previous = document.activeElement;
    const panel = this.panel().nativeElement;
    (panel.querySelector<HTMLElement>('[data-autofocus]') ?? panel).focus();
  }

  ngOnDestroy(): void {
    if (this.previous instanceof HTMLElement && this.previous.isConnected) this.previous.focus();
  }

  protected onScrim(event: MouseEvent): void {
    if (this.dismissible() && event.target === event.currentTarget) this.closed.emit();
  }

  @HostListener('document:keydown', ['$event'])
  protected onKeydown(event: KeyboardEvent): void {
    if (!this.host.nativeElement.isConnected) return;
    if (event.key === 'Escape' && this.dismissible()) {
      event.preventDefault();
      this.closed.emit();
    } else if (event.key === 'Tab') {
      this.trap(event);
    }
  }

  private trap(event: KeyboardEvent): void {
    const panel = this.panel().nativeElement;
    const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) { event.preventDefault(); panel.focus(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (!panel.contains(active) || (event.shiftKey && (active === first || active === panel))) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }
}
