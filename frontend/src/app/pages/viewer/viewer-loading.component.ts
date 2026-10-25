// path: src/app/pages/viewer/viewer-loading.component.ts

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { IconComponent } from '../../ui/icon/icon.component';
import { byteLabel } from './viewer-format';

/** Circumference of the progress ring (r = 42 in a 100-unit viewBox). */
const RING_CIRCUMFERENCE = 264;

/**
 * Loading screen (prototype 2c): ring with percent, title, byte line, bar, stage, and a cancel
 * button. Presentational: it is fed only by inputs, so the page (today) and the isolated player host
 * (player-isolation phase 5) can both drive it.
 */
@Component({
  selector: 'vl-viewer-loading',
  standalone: true,
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './viewer-loading.component.html',
  styleUrl: './viewer-loading.component.scss',
})
export class ViewerLoadingComponent {
  readonly title = input('');
  /** 0-100; clamped. */
  readonly percent = input(0);
  /** Bytes received; `null` hides the byte line (no archive download on this path). */
  readonly loadedBytes = input<number | null>(null);
  /** Archive size; 0 / `null` when the server did not say. */
  readonly totalBytes = input<number | null>(null);
  readonly stage = input('');
  readonly cancel = output<void>();

  protected readonly shownPercent = computed(() => {
    const p = this.percent();
    return Number.isFinite(p) ? Math.min(100, Math.max(0, Math.round(p))) : 0;
  });
  protected readonly ringOffset = computed(() => RING_CIRCUMFERENCE - (RING_CIRCUMFERENCE * this.shownPercent()) / 100);
  protected readonly bytes = computed(() => byteLabel(this.loadedBytes(), this.totalBytes()));
}
