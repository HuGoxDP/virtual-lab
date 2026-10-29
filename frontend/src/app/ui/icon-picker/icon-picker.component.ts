// path: src/app/ui/icon-picker/icon-picker.component.ts

import { ChangeDetectionStrategy, Component, ElementRef, HostListener, inject, input, output, signal } from '@angular/core';

import { ICON_NAMES, IconComponent } from '../icon/icon.component';

/**
 * Picks one of the hosted icons (`ICON_NAMES`): a button showing the current icon opens a grid of all
 * of them. Choosing one emits `valueChange` and closes the grid; Escape, a click outside, or the
 * button again closes it without a change. A `value` the set does not contain is shown as the
 * fallback icon by `<vl-icon>` and selects nothing in the grid.
 */
@Component({
  selector: 'vl-icon-picker',
  standalone: true,
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host { position: relative; display: inline-block; }
    .trigger {
      display: inline-grid; place-items: center; width: 36px; height: 36px; padding: 0; font-size: 18px;
      color: var(--color-text); background: var(--color-surface); cursor: pointer;
      border: 1px solid var(--color-divider); border-radius: var(--radius-md);
    }
    .trigger:hover { border-color: color-mix(in srgb, var(--color-text) 45%, transparent); }
    .trigger:focus-visible, .option:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 1px; }
    .grid {
      position: absolute; z-index: 30; top: calc(100% + 6px); left: 0; width: 264px; max-height: 240px; overflow-y: auto;
      display: grid; grid-template-columns: repeat(6, 1fr); gap: 4px; padding: var(--space-3);
      background: var(--color-surface); border-radius: var(--radius-md); box-shadow: var(--shadow-lg);
    }
    .option {
      display: grid; place-items: center; height: 34px; padding: 0; font-size: 18px; color: var(--color-text);
      background: transparent; border: 1px solid transparent; border-radius: var(--radius-sm); cursor: pointer;
    }
    .option:hover { background: color-mix(in srgb, var(--color-text) 8%, transparent); }
    .option[aria-pressed='true'] { color: var(--color-accent); border-color: var(--color-accent); }
  `,
  template: `
    <button type="button" class="trigger" aria-haspopup="true" [attr.aria-expanded]="open()"
            [attr.aria-label]="label() + ': ' + (value() || 'не вибрано')" (click)="open.set(!open())">
      <vl-icon [name]="value()" />
    </button>
    @if (open()) {
      <div class="grid" role="group" [attr.aria-label]="label()">
        @for (name of names; track name) {
          <button type="button" class="option" [attr.aria-pressed]="name === value()" [attr.aria-label]="name"
                  [attr.title]="name" (click)="choose(name)">
            <vl-icon [name]="name" />
          </button>
        }
      </div>
    }
  `,
})
export class IconPickerComponent {
  /** The chosen icon name. */
  readonly value = input<string | null | undefined>();
  /** Accessible name of the control, e.g. "Іконка пункту 2". */
  readonly label = input('Іконка');
  readonly valueChange = output<string>();

  protected readonly names = ICON_NAMES;
  protected readonly open = signal(false);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected choose(name: string): void {
    this.open.set(false);
    this.valueChange.emit(name);
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.open.set(false);
  }

  @HostListener('document:click', ['$event'])
  protected onDocumentClick(event: Event): void {
    if (this.open() && !this.host.nativeElement.contains(event.target as Node)) this.open.set(false);
  }
}
