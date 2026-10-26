// path: src/app/ui/toast/toast.service.ts

import { DestroyRef, Injectable, inject, signal } from '@angular/core';

/** How long a toast stays: the prototype's 2.6 s. */
export const TOAST_DURATION_MS = 2600;

/** One transient message at a time; a new one replaces the old and restarts the clock. */
@Injectable({ providedIn: 'root' })
export class ToastService {
  private readonly _message = signal('');
  readonly message = this._message.asReadonly();

  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
  }

  show(text: string): void {
    if (!text) return;
    clearTimeout(this.timer);
    this._message.set(text);
    this.timer = setTimeout(() => this._message.set(''), TOAST_DURATION_MS);
  }
}
