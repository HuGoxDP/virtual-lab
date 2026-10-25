// path: src/app/pages/catalog/catalog.component.ts

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';

import { SITE } from '../../site.config';
import { AdminService } from '../../services/admin.service';
import {
  CatalogFilter,
  CatalogSort,
  DEFAULT_CATALOG_FILTER,
  parseCatalogQuery,
  sameCatalogFilter,
  toCatalogQuery,
} from '../../services/catalog-query';
import { PlatformConfigService } from '../../services/platform-config.service';
import { ScenarioService } from '../../services/scenario.service';
import { IconComponent } from '../../ui/icon/icon.component';
import { pluralUk } from '../../ui/format';
import { ScenarioCardComponent } from '../../ui/scenario-card/scenario-card.component';
import { SiteFooterComponent } from '../../ui/site-footer/site-footer.component';
import { SiteHeaderComponent } from '../../ui/site-header/site-header.component';

/** Wait after the last keystroke before querying the server. */
const SEARCH_DEBOUNCE_MS = 300;

const SCENARIO_FORMS = ['сценарій', 'сценарії', 'сценаріїв'] as const;
const DIRECTION_FORMS = ['освітній напрям', 'освітні напрями', 'освітніх напрямів'] as const;

/**
 * The public catalog (prototype screen 2a). The URL's query string (`category`, `q`, `sort`) is the
 * only holder of the filter: controls navigate, the URL change loads from the server, and the
 * browser's Back button restores a filter without any extra bookkeeping.
 */
@Component({
  selector: 'app-catalog',
  standalone: true,
  imports: [
    IconComponent,
    ScenarioCardComponent,
    SiteFooterComponent,
    SiteHeaderComponent,
  ],
  templateUrl: './catalog.component.html',
  styleUrls: ['./catalog.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CatalogComponent implements OnDestroy {

  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly scenarioService = inject(ScenarioService);
  private readonly admin = inject(AdminService);

  protected readonly site = SITE;

  // Data — read straight off the service's signals; no subscriptions to clean up.
  readonly scenarios = this.scenarioService.scenarios;
  readonly categories = this.scenarioService.categories;
  readonly summary = this.scenarioService.summary;
  readonly isLoading = this.scenarioService.loading;
  readonly isLoaded = this.scenarioService.loaded;
  readonly errorMessage = this.scenarioService.error;
  readonly total = this.scenarioService.total;
  readonly hasMore = this.scenarioService.hasMore;
  private readonly platformConfig = inject(PlatformConfigService);
  readonly maxArchiveBytes = this.platformConfig.maxArchiveBytes;

  /** "Панель" once an admin token is in the session, "Увійти" before. */
  readonly accountLabel = computed(() => (this.admin.isAuthenticated() ? 'Панель' : 'Увійти'));
  readonly accountIcon = computed(() => (this.admin.isAuthenticated() ? 'squares-four' : 'sign-in'));

  // Filter, as the URL states it. Equal filters keep the same value, so a redundant emission of the
  // query map never reloads the list.
  private readonly queryParams = toSignal(this.route.queryParamMap, { requireSync: true });
  readonly filter = computed<CatalogFilter>(
    () => {
      const map = this.queryParams();
      return parseCatalogQuery(Object.fromEntries(map.keys.map(key => [key, map.getAll(key)])));
    },
    { equal: sameCatalogFilter },
  );

  /** What the search box shows; runs ahead of the URL while the debounce is pending. */
  readonly searchText = signal(this.filter().q);
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  readonly totalLabel = computed(() => {
    const count = this.summary()?.scenarios;
    return count == null ? '' : `${count} ${pluralUk(count, SCENARIO_FORMS)} у каталозі`;
  });
  readonly directionsLabel = computed(() => {
    const count = this.summary()?.categories;
    return count == null ? '' : `${count} ${pluralUk(count, DIRECTION_FORMS)}`;
  });
  readonly foundLabel = computed(
    () => `Знайдено ${this.total()} ${pluralUk(this.total(), SCENARIO_FORMS)}`,
  );

  readonly isEmpty = computed(
    () => this.isLoaded() && !this.isLoading() && !this.errorMessage() && this.scenarios().length === 0,
  );
  readonly hasError = computed(() => !!this.errorMessage() && !this.isLoading());

  constructor() {
    void this.platformConfig.load();

    // One load per distinct filter: on entry, and whenever the URL's query changes.
    effect(() => {
      const filter = this.filter();
      untracked(() => void this.scenarioService.loadCatalog(filter));
    });

    // The URL changed from outside (Back, a reset, a link): the search box follows it, unless the
    // user is mid-word and the debounce is about to say something newer.
    effect(() => {
      const q = this.filter().q;
      if (this.searchTimer === null) untracked(() => this.searchText.set(q));
    });
  }

  ngOnDestroy(): void {
    this.clearSearchTimer();
  }

  // ==================== FILTERS ====================

  selectCategory(id: string): void {
    this.navigate({ category: id });
  }

  setSort(sort: CatalogSort): void {
    this.navigate({ sort });
  }

  onSearch(event: Event): void {
    this.searchText.set((event.target as HTMLInputElement).value);
    this.clearSearchTimer();
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      // Typing replaces the history entry: Back should leave the page, not undo letters.
      this.navigate({ q: this.searchText().trim() }, true);
    }, SEARCH_DEBOUNCE_MS);
  }

  clearSearch(): void {
    this.clearSearchTimer();
    this.searchText.set('');
    this.navigate({ q: '' });
  }

  resetFilters(): void {
    this.clearSearchTimer();
    this.searchText.set('');
    this.navigate({ ...DEFAULT_CATALOG_FILTER });
  }

  reload(): Promise<void> {
    return this.scenarioService.loadCatalog(this.filter());
  }

  loadMore(): Promise<void> {
    return this.scenarioService.loadMore(this.filter());
  }

  private navigate(change: Partial<CatalogFilter>, replaceUrl = false): void {
    const next = { ...this.filter(), ...change };
    if (sameCatalogFilter(next, this.filter())) return;
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: toCatalogQuery(next),
      replaceUrl,
    });
  }

  private clearSearchTimer(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = null;
  }

  // ==================== NAVIGATION ====================

  openScenario(id: string): void {
    void this.router.navigate(['/scenario', id]);
  }

  /**
   * "Запустити" on a card goes straight to the player. A scenario with no archive cannot run, so it
   * opens its page instead of a viewer that could only fail.
   */
  launchScenario(id: string): void {
    const scenario = this.scenarios().find(s => s.id === id);
    void this.router.navigate(scenario?.scenarioUrl ? ['/play', id] : ['/scenario', id]);
  }

  goAccount(): void {
    void this.router.navigate(['/admin']);
  }
}
