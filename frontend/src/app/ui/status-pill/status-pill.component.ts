// path: src/app/ui/status-pill/status-pill.component.ts

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { statusMeta } from './status-meta';
import { IconComponent } from '../icon/icon.component';

/** A scenario's workflow status as the prototype's coloured pill: icon and label, never colour alone. */
@Component({
  selector: 'vl-status-pill',
  standalone: true,
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host { display: inline-flex; max-width: 100%; }
    .pill {
      display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px 2px 7px; border-radius: 999px;
      font-size: 12px; line-height: 1.5; white-space: nowrap;
    }
    .label { overflow: hidden; text-overflow: ellipsis; }
  `,
  template: `
    <span class="pill status-pill" [style.color]="meta().fg" [style.background]="meta().bg">
      <vl-icon [name]="meta().icon" size="13" /><span class="label">{{ meta().label }}</span>
    </span>
  `,
})
export class StatusPillComponent {
  readonly status = input.required<string>();

  protected readonly meta = computed(() => statusMeta(this.status()));
}

