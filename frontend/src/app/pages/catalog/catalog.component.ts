// path: src/app/pages/catalog/catalog.component.ts

import {
  Component,
  OnInit,
  OnDestroy,
  ChangeDetectorRef,        // ← ДОБАВЛЕНО
  ChangeDetectionStrategy,  // ← ДОБАВЛЕНО
} from '@angular/core';
import { Router, RouterModule } from '@angular/router';
import { CommonModule } from '@angular/common';
import { Subject, takeUntil } from 'rxjs';

import { ScenarioCatalogItem, CategoryFilter } from '../../models/scenario.model';
import { ScenarioService } from '../../services/scenario.service';

@Component({
  selector: 'app-catalog',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './catalog.component.html',
  styleUrls: ['./catalog.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,  // ← ДОБАВЛЕНО: явное управление
})
export class CatalogComponent implements OnInit, OnDestroy {

  private readonly destroy$ = new Subject<void>();

  // Theme
  isDarkMode = false;

  // Data
  allScenarios: ScenarioCatalogItem[] = [];
  displayedScenarios: ScenarioCatalogItem[] = [];
  categories: CategoryFilter[] = [];
  isLoading = true;
  errorMessage: string | null = null;

  // Filters
  selectedCategory = 'all';
  searchQuery = '';

  // Modal
  isModalOpen = false;
  activeScenario: ScenarioCatalogItem | null = null;

  constructor(
    private readonly router: Router,
    private readonly scenarioService: ScenarioService,
    private readonly cdr: ChangeDetectorRef,  // ← ДОБАВЛЕНО
  ) {}

  reloadCatalog(): void {
    this.scenarioService.loadCatalog();
  }

  ngOnInit(): void {
    this.categories = this.scenarioService.categories;
    this.isDarkMode = localStorage.getItem('theme') === 'dark';

    // Subscribe to scenarios stream
    this.scenarioService.scenarios$
      .pipe(takeUntil(this.destroy$))
      .subscribe(scenarios => {
        this.allScenarios = scenarios;
        this.applyFilters();
        this.cdr.markForCheck();  // ← ФИКС: говорим Angular перерисовать
      });

    // Subscribe to loading state
    this.scenarioService.loading$
      .pipe(takeUntil(this.destroy$))
      .subscribe(loading => {
        this.isLoading = loading;
        this.cdr.markForCheck();  // ← ФИКС
      });

    // Subscribe to errors
    this.scenarioService.error$
      .pipe(takeUntil(this.destroy$))
      .subscribe(err => {
        this.errorMessage = err;
        this.cdr.markForCheck();  // ← ФИКС
      });

    // Fetch catalog from remote
    this.scenarioService.loadCatalog();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  // ==================== THEME ====================

  toggleTheme(): void {
    this.isDarkMode = !this.isDarkMode;
    localStorage.setItem('theme', this.isDarkMode ? 'dark' : 'light');
  }

  // ==================== FILTERS ====================

  selectCategory(id: string): void {
    this.selectedCategory = id;
    this.applyFilters();
  }

  onSearch(event: Event): void {
    this.searchQuery = (event.target as HTMLInputElement).value;
    this.applyFilters();
  }

  private applyFilters(): void {
    this.displayedScenarios = this.scenarioService.filterScenarios(
      this.selectedCategory,
      this.searchQuery,
    );
  }

  // ==================== MODAL ====================

  openModal(scenario: ScenarioCatalogItem): void {
    this.activeScenario = scenario;
    this.isModalOpen = true;
  }

  closeModal(): void {
    this.isModalOpen = false;
    setTimeout(() => {
      this.activeScenario = null;
      this.cdr.markForCheck();  // ← ФИКС: setTimeout тоже за пределами зоны
    }, 250);
  }

  onOverlayClick(event: MouseEvent): void {
    if ((event.target as HTMLElement).classList.contains('modal-overlay')) {
      this.closeModal();
    }
  }

  // ==================== LAUNCH ====================

  launchScenario(): void {
    if (!this.activeScenario) return;

    const { id, scenarioUrl } = this.activeScenario;

    if (!scenarioUrl) {
      return;
    }

    this.router.navigate(['/play', id], {
      queryParams: { url: scenarioUrl },
    });
  }

  // ==================== HELPERS ====================

  handleImageError(event: Event): void {
    const img = event.target as HTMLImageElement;
    img.src = 'https://placehold.co/600x400/1e1e36/9ca3af?text=No+Image';
  }

  hasScenarioUrl(scenario: ScenarioCatalogItem): boolean {
    return !!scenario.scenarioUrl;
  }
}
