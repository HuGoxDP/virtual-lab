// path: src/app/pages/scenario/scenario.component.ts

import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Title } from '@angular/platform-browser';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { RelatedScenario, ScenarioDetail } from '../../models/scenario.model';
import { SITE } from '../../site.config';
import { toCatalogQuery } from '../../services/catalog-query';
import { ScenarioService } from '../../services/scenario.service';
import { categoryGradient } from '../../ui/category-gradient';
import { formatBytes, formatDate } from '../../ui/format';
import { IconComponent } from '../../ui/icon/icon.component';
import { SiteFooterComponent } from '../../ui/site-footer/site-footer.component';
import { SiteHeaderComponent } from '../../ui/site-header/site-header.component';
import { ToastService } from '../../ui/toast/toast.service';

export type ScenarioPageStatus = 'loading' | 'ready' | 'not-found' | 'error';

/** One row of the sidebar's meta table; rows without a value are not built at all. */
export interface MetaRow {
  label: string;
  value: string;
  mono?: boolean;
}

/**
 * The scenario page (prototype screen 2b, replacing the old details modal). The id comes from the
 * route; the scenario always comes from the API, so a hard reload or a shared link works the same
 * as a click from the catalog.
 */
@Component({
  selector: 'app-scenario',
  standalone: true,
  imports: [RouterLink, IconComponent, SiteHeaderComponent, SiteFooterComponent],
  templateUrl: './scenario.component.html',
  styleUrls: ['./scenario.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ScenarioComponent {

  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly scenarioService = inject(ScenarioService);
  private readonly toast = inject(ToastService);
  private readonly titleService = inject(Title);
  private readonly injector = inject(Injector);

  private readonly params = toSignal(this.route.paramMap, { requireSync: true });

  readonly status = signal<ScenarioPageStatus>('loading');
  readonly scenario = signal<ScenarioDetail | null>(null);

  /** Set when the clipboard is unavailable or refused: the link is then offered to select. */
  readonly manualLink = signal<string | null>(null);

  /** The preview URLs that failed to load; they fall back to the category gradient. */
  private readonly failedImages = signal<ReadonlySet<string>>(new Set());

  private latestRequest = 0;
  private readonly initialTitle = this.titleService.getTitle();

  /** The catalog filter the visitor came from, so "Каталог" returns to the same list. */
  readonly backQuery = computed(() => toCatalogQuery(this.scenarioService.filter()));

  readonly gradient = computed(() => categoryGradient(this.scenario()?.category ?? ''));
  readonly bannerImage = computed(() => this.usableImage(this.scenario()?.imageUrl));
  readonly canLaunch = computed(() => !!this.scenario()?.scenarioUrl);
  readonly description = computed(() => {
    const s = this.scenario();
    return s ? s.fullDescription || s.description : '';
  });
  readonly updated = computed(() => formatDate(this.scenario()?.updatedAt));
  readonly size = computed(() => formatBytes(this.scenario()?.archiveBytes));

  readonly meta = computed<MetaRow[]>(() => {
    const s = this.scenario();
    if (!s) return [];
    const rows: Array<MetaRow & { show: boolean }> = [
      { label: 'Версія', value: s.version ?? '', show: !!s.version },
      { label: 'Автор', value: s.author ?? '', show: !!s.author },
      { label: 'Розмір архіву', value: this.size(), show: !!this.size() },
      { label: 'Оновлено', value: this.updated(), show: !!this.updated() },
      { label: 'Ідентифікатор', value: s.id, mono: true, show: true },
    ];
    return rows.filter(r => r.show).map(({ label, value, mono }) => ({ label, value, mono }));
  });

  constructor() {
    effect(() => {
      const id = this.params().get('id') ?? '';
      untracked(() => void this.load(id));
    });
    inject(DestroyRef).onDestroy(() => this.titleService.setTitle(this.initialTitle));
  }

  /** Fetches the scenario; an answer for an id the visitor has already left is dropped. */
  async load(id: string): Promise<void> {
    const request = ++this.latestRequest;
    this.status.set('loading');
    this.manualLink.set(null);
    this.titleService.setTitle(SITE.name);

    try {
      const scenario = await this.scenarioService.fetchScenarioById(id);
      if (request !== this.latestRequest) return;
      this.scenario.set(scenario);
      this.status.set('ready');
      this.titleService.setTitle(`${scenario.title} — ${SITE.name}`);
    } catch (err) {
      if (request !== this.latestRequest) return;
      this.scenario.set(null);
      if (err instanceof HttpErrorResponse && err.status === 404) {
        this.status.set('not-found');
        this.titleService.setTitle(`Сценарій не знайдено — ${SITE.name}`);
      } else {
        console.error('[ScenarioComponent] Scenario load failed:', err);
        this.status.set('error');
      }
    }
  }

  retry(): void {
    void this.load(this.params().get('id') ?? '');
  }

  // ==================== ACTIONS ====================

  launch(): void {
    const scenario = this.scenario();
    if (scenario?.scenarioUrl) void this.router.navigate(['/play', scenario.id]);
  }

  /** The absolute URL of this page, as a visitor would paste it. */
  pageUrl(): string {
    const path = this.router.serializeUrl(this.router.createUrlTree(['/scenario', this.scenario()?.id ?? '']));
    return new URL(path, location.origin).href;
  }

  /**
   * Copies the page link. The Clipboard API is absent on a plain-HTTP deployment and can be refused
   * by the browser; either way the link is shown selected so it can still be copied by hand.
   */
  async copyLink(): Promise<void> {
    const url = this.pageUrl();
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API is not available');
      await navigator.clipboard.writeText(url);
      this.manualLink.set(null);
      this.toast.show('Посилання скопійовано');
    } catch {
      this.manualLink.set(url);
      afterNextRender(
        () => (document.querySelector('.manual-link') as HTMLInputElement | null)?.select(),
        { injector: this.injector },
      );
    }
  }

  // ==================== IMAGES ====================

  private usableImage(url: string | null | undefined): string {
    return url && !this.failedImages().has(url) ? url : '';
  }

  imageFailed(url: string): void {
    this.failedImages.update(set => new Set(set).add(url));
  }

  relatedImage(related: RelatedScenario): string {
    return this.usableImage(related.imageUrl);
  }

  relatedGradient(related: RelatedScenario): string {
    return categoryGradient(related.category);
  }
}
