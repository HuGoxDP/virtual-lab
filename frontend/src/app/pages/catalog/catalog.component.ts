// path: src/app/pages/catalog/catalog.component.ts

import {
  Component,
  OnInit,
  OnDestroy,
  ChangeDetectionStrategy,
  ElementRef,
  ViewChild,
  inject,
  signal,
} from '@angular/core';
import { Router, RouterModule } from '@angular/router';

import { ScenarioCatalogItem } from '../../models/scenario.model';
import { ScenarioService } from '../../services/scenario.service';

/** Inline placeholder for scenarios without a usable preview image. */
const IMAGE_PLACEHOLDER =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400">' +
    '<rect width="600" height="400" fill="#1e1e36"/>' +
    '<text x="300" y="205" fill="#9ca3af" font-family="sans-serif" font-size="28" ' +
    'text-anchor="middle">Без зображення</text></svg>'
  );

/** Wait after the last keystroke before querying the server. */
const SEARCH_DEBOUNCE_MS = 300;

@Component({
  selector: 'app-catalog',
  standalone: true,
  imports: [RouterModule],
  templateUrl: './catalog.component.html',
  styleUrls: ['./catalog.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CatalogComponent implements OnInit, OnDestroy {

  private readonly router = inject(Router);
  private readonly scenarioService = inject(ScenarioService);

  @ViewChild('modalWindow')
  modalRef?: ElementRef<HTMLElement>;

  // Theme
  readonly isDarkMode = signal(false);

  // Data — read straight off the service's signals; no subscriptions to clean up.
  readonly scenarios = this.scenarioService.scenarios;
  readonly categories = this.scenarioService.categories;
  readonly isLoading = this.scenarioService.loading;
  readonly errorMessage = this.scenarioService.error;
  readonly total = this.scenarioService.total;
  readonly hasMore = this.scenarioService.hasMore;

  // Filters. Both are applied server-side, so paging stays correct.
  readonly selectedCategory = signal('all');
  readonly searchQuery = signal('');

  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  // Modal
  readonly isModalOpen = signal(false);
  readonly activeScenario = signal<ScenarioCatalogItem | null>(null);
  private lastFocused: HTMLElement | null = null;

  ngOnInit(): void {
    this.applyStoredTheme();
    void this.scenarioService.loadCatalog();
  }

  ngOnDestroy(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
  }

  // ==================== THEME ====================

  private applyStoredTheme(): void {
    const dark = localStorage.getItem('theme') === 'dark';
    this.isDarkMode.set(dark);
    this.syncThemeClass(dark);
  }

  toggleTheme(): void {
    const next = !this.isDarkMode();
    this.isDarkMode.set(next);
    localStorage.setItem('theme', next ? 'dark' : 'light');
    this.syncThemeClass(next);
  }

  /** Also on <html>, so the viewer and any future page follow the same theme. */
  private syncThemeClass(dark: boolean): void {
    document.documentElement.classList.toggle('dark-theme', dark);
  }

  // ==================== FILTERS ====================

  selectCategory(id: string): void {
    if (this.selectedCategory() === id) return;
    this.selectedCategory.set(id);
    void this.reload();
  }

  onSearch(event: Event): void {
    this.searchQuery.set((event.target as HTMLInputElement).value);

    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => void this.reload(), SEARCH_DEBOUNCE_MS);
  }

  reload(): Promise<void> {
    return this.scenarioService.loadCatalog(this.selectedCategory(), this.searchQuery());
  }

  loadMore(): Promise<void> {
    return this.scenarioService.loadMore(this.selectedCategory(), this.searchQuery());
  }

  // ==================== MODAL ====================

  openModal(scenario: ScenarioCatalogItem, event: Event): void {
    this.lastFocused = event.currentTarget as HTMLElement;
    this.activeScenario.set(scenario);
    this.isModalOpen.set(true);

    // Move focus into the dialog so keyboard users are not left behind it.
    setTimeout(() => this.modalRef?.nativeElement.focus(), 0);
  }

  closeModal(): void {
    this.isModalOpen.set(false);
    this.lastFocused?.focus();
    this.lastFocused = null;
    // Let the closing transition finish before dropping the content.
    setTimeout(() => this.activeScenario.set(null), 250);
  }

  onOverlayClick(event: MouseEvent): void {
    if ((event.target as HTMLElement).classList.contains('modal-overlay')) {
      this.closeModal();
    }
  }

  onModalKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      this.closeModal();
      return;
    }

    if (event.key !== 'Tab') return;

    // Focus trap: keep Tab cycling inside the dialog while it is open.
    const root = this.modalRef?.nativeElement;
    if (!root) return;

    const focusable = Array.from(
      root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input, textarea, select, [tabindex]:not([tabindex="-1"])'
      )
    ).filter(element => element.offsetParent !== null);

    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement as HTMLElement | null;

    if (event.shiftKey && (active === first || active === root)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  // ==================== LAUNCH ====================

  launchScenario(): void {
    const scenario = this.activeScenario();
    if (!scenario?.scenarioUrl) return;

    // Only the id travels — the viewer resolves the archive URL through the API.
    void this.router.navigate(['/play', scenario.id]);
  }

  // ==================== HELPERS ====================

  handleImageError(event: Event): void {
    const img = event.target as HTMLImageElement;
    if (img.src !== IMAGE_PLACEHOLDER) {
      img.src = IMAGE_PLACEHOLDER;
    }
  }

  hasScenarioUrl(scenario: ScenarioCatalogItem): boolean {
    return !!scenario.scenarioUrl;
  }
}
