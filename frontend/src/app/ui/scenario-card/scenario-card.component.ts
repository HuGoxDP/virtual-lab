// path: src/app/ui/scenario-card/scenario-card.component.ts

import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

import { categoryGradient } from '../category-gradient';
import { formatBytes } from '../format';
import { IconComponent } from '../icon/icon.component';

/** What a card needs of a scenario: a subset of the catalog item, plus a resolved preview URL. */
export interface ScenarioCardData {
  id: string;
  title: string;
  description: string;
  /** Category slug: picks the cover gradient. */
  category: string;
  /** Category display name, shown as the kicker. */
  categoryLabel: string;
  version?: string | null;
  author?: string | null;
  /** Preview image URL; `''` means none and the category gradient is shown. */
  imageUrl: string;
  archiveBytes?: number | null;
}

/**
 * A catalog card. Clicking anywhere on it (or pressing the title, which is a real button for the
 * keyboard) emits `open`; the "Запустити" button emits `launch` only. Both carry the scenario id.
 * A missing or broken preview falls back to the category gradient.
 */
@Component({
  selector: 'vl-scenario-card',
  standalone: true,
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './scenario-card.component.scss',
  template: `
    <article class="scenario-card" (click)="open.emit(scenario().id)">
      <div class="cover" [style.background]="gradient()">
        @if (showImage()) {
          <img [src]="scenario().imageUrl" alt="" loading="lazy" (error)="failedUrl.set(scenario().imageUrl)" />
        }
        <span class="badge-webgl"><vl-icon name="cube" size="11" />WebGL</span>
        @if (size(); as label) {
          <span class="badge-size">{{ label }}</span>
        }
      </div>

      <div class="body">
        <div class="kicker-row">
          <span class="card-kicker">{{ scenario().categoryLabel }}</span>
          @if (scenario().version) {
            <span class="text-muted version">{{ scenario().version }}</span>
          }
        </div>
        <h3 class="card-title title">
          <button type="button" class="open-button" [attr.title]="scenario().title">{{ scenario().title }}</button>
        </h3>
        <p class="card-body description">{{ scenario().description }}</p>

        <div class="actions">
          @if (scenario().author) {
            <span class="card-meta author">
              <vl-icon name="user" size="12" /><span class="author-name">{{ scenario().author }}</span>
            </span>
          }
          <button
            type="button"
            class="btn btn-primary launch"
            [attr.aria-label]="'Запустити: ' + scenario().title"
            (click)="onLaunch($event)"
          >
            <vl-icon name="play" size="14" />Запустити
          </button>
        </div>
      </div>
    </article>
  `,
})
export class ScenarioCardComponent {
  readonly scenario = input.required<ScenarioCardData>();
  readonly open = output<string>();
  readonly launch = output<string>();

  /** The preview URL that failed to load; a different URL gets its own chance. */
  protected readonly failedUrl = signal<string | null>(null);

  protected readonly showImage = computed(() => {
    const url = this.scenario().imageUrl;
    return !!url && url !== this.failedUrl();
  });
  protected readonly gradient = computed(() => categoryGradient(this.scenario().category));
  protected readonly size = computed(() => formatBytes(this.scenario().archiveBytes));

  protected onLaunch(event: Event): void {
    event.stopPropagation(); // the card's own click would also open the scenario page
    this.launch.emit(this.scenario().id);
  }
}
