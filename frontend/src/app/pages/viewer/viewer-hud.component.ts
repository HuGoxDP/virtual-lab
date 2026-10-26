// path: src/app/pages/viewer/viewer-hud.component.ts

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { IconComponent } from '../../ui/icon/icon.component';

/**
 * Heads-up display of a running scenario (prototype 2d): exit, title with an optional FPS slot, and
 * pause / restart / fullscreen buttons, plus input hints on wide screens. Presentational — inputs in,
 * outputs out. Nothing here is decorative: the FPS slot exists only while `fps` is a number, and the
 * pause button (and the Space hint) only while `canPause` is true, so a student never sees a control
 * or a number that is not backed by something.
 */
@Component({
  selector: 'vl-viewer-hud',
  standalone: true,
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './viewer-hud.component.html',
  styleUrl: './viewer-hud.component.scss',
})
export class ViewerHudComponent {
  readonly title = input('');
  /** Frames per second; `null` hides the slot. */
  readonly fps = input<number | null>(null);
  readonly paused = input(false);
  /** Whether a pause is available at all; drives the pause button and the Space hint. */
  readonly canPause = input(false);
  readonly canRestart = input(false);

  readonly exit = output<void>();
  readonly togglePause = output<void>();
  readonly restart = output<void>();
  readonly fullscreen = output<void>();

  protected readonly fpsLabel = computed(() => {
    const fps = this.fps();
    return fps !== null && Number.isFinite(fps) ? `${Math.round(fps)} FPS` : null;
  });
  protected readonly pauseLabel = computed(() => (this.paused() ? 'Продовжити' : 'Пауза'));
}
