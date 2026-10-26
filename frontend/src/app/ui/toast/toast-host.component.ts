// path: src/app/ui/toast/toast-host.component.ts

import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { IconComponent } from '../icon/icon.component';
import { ToastService } from './toast.service';

/**
 * Renders `ToastService`'s message. Mount once, in the app shell. The live region is always in the
 * DOM — a region that appears together with its text is not announced by screen readers.
 */
@Component({
  selector: 'vl-toast-host',
  standalone: true,
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    .toast {
      position: fixed; left: 50%; bottom: 26px; z-index: 90; pointer-events: none;
      display: flex; align-items: center; gap: 9px; padding: 10px 17px;
      background: var(--color-surface); border-radius: var(--radius-md); box-shadow: var(--shadow-lg);
      font-size: 13.5px; white-space: nowrap; animation: vl-toast 0.2s ease both;
    }
    .toast vl-icon { font-size: 17px; color: #7ed6a6; }
  `,
  template: `
    <div class="toast-region" role="status" aria-live="polite">
      @if (toast.message(); as text) {
        <div class="toast"><vl-icon name="check-circle" />{{ text }}</div>
      }
    </div>
  `,
})
export class ToastHostComponent {
  protected readonly toast = inject(ToastService);
}
