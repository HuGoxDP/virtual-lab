// path: src/app/pages/viewer/viewer.component.ts

import { Component, ElementRef, ViewChild, AfterViewInit, OnDestroy, NgZone, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { Router, ActivatedRoute, RouterModule } from '@angular/router';
import { CommonModule } from '@angular/common';
import { Subject, takeUntil } from 'rxjs';

// Engine imports — from the WebEngineTS npm package
import { Application } from 'WebEngineTS';
import type { IScenarioLoadProgress } from 'WebEngineTS';

import { ScenarioService, DownloadProgress } from '../../services/scenario.service';

/**
 * Viewer states for the loading UI.
 */
type ViewerState = 'idle' | 'downloading' | 'loading-engine' | 'running' | 'error';

@Component({
  selector: 'app-viewer',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './viewer.component.html',
  styleUrls: ['./viewer.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ViewerComponent implements AfterViewInit, OnDestroy {

  @ViewChild('webglCanvas', { static: true })
  canvasRef!: ElementRef<HTMLCanvasElement>;

  private readonly destroy$ = new Subject<void>();
  private app: Application | null = null;

  // UI state
  state: ViewerState = 'idle';
  progressPercent = 0;
  progressLabel = '';
  errorMessage: string | null = null;
  scenarioTitle = '';

  constructor(
    private readonly router: Router,
    private readonly route: ActivatedRoute,
    private readonly ngZone: NgZone,
    private readonly scenarioService: ScenarioService,
    private readonly cdr: ChangeDetectorRef,
  ) {}

  // ==================== LIFECYCLE ====================

  ngAfterViewInit(): void {
    // Initialize engine OUTSIDE Angular zone — the game loop
    // uses requestAnimationFrame which would trigger change detection
    // on every frame if run inside the zone.
    this.ngZone.runOutsideAngular(() => {
      this.app = new Application(this.canvasRef.nativeElement);
    });

    // Read route params and start loading
    this.route.queryParams
      .pipe(takeUntil(this.destroy$))
      .subscribe(params => {
        const url = params['url'];
        if (url) {
          this.startLoading(url);
        } else {
          this.showError('URL сценарію не вказано.');
        }
      });

    // Resolve scenario title from catalog
    this.route.paramMap
      .pipe(takeUntil(this.destroy$))
      .subscribe(params => {
        const id = params.get('id');
        if (id) {
          const item = this.scenarioService.getScenarioById(id);
          this.scenarioTitle = item?.title ?? '';
        }
      });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();

    // Full cleanup: scenario → engine → WebGL context
    if (this.app) {
      this.app.dispose();
      this.app = null;
    }
  }

  // ==================== LOADING PIPELINE ====================

  /**
   * Full loading pipeline:
   * 1. Download ZIP from URL (with progress)
   * 2. Pass ArrayBuffer to engine (with progress)
   * 3. Engine parses ZIP, validates manifest, executes entry point
   */
  private async startLoading(url: string): Promise<void> {
    this.setState('downloading', 0, 'Завантаження архіву...');

    try {
      // Step 1: Download the ZIP
      const zipBuffer = await this.scenarioService.downloadScenarioZip(
        url,
        (progress: DownloadProgress) => {
          this.ngZone.run(() => {
            this.progressPercent = progress.percent >= 0 ? progress.percent : 0;
            const mb = (progress.loaded / (1024 * 1024)).toFixed(1);
            this.progressLabel = `Завантаження: ${mb} MB`;
          });
        }
      );

      // Step 2: Pass to engine
      this.setState('loading-engine', 0, 'Ініціалізація сцени...');

      await this.ngZone.runOutsideAngular(async () => {
        if (!this.app) throw new Error('Engine not initialized');

        await this.app.loadScenarioFromBuffer(
          zipBuffer,
          (progress: IScenarioLoadProgress) => {
            this.ngZone.run(() => {
              this.progressPercent = Math.round(progress.progress * 100);
              this.progressLabel = progress.currentOperation;
            });
          }
        );
      });

      // Step 3: Running!
      this.setState('running', 100, '');

    } catch (err) {
      const message = err instanceof Error
        ? err.message
        : 'Невідома помилка при завантаженні сценарію';
      console.error('[ViewerComponent] Load failed:', err);
      this.showError(message);
    }
  }

  // ==================== UI HELPERS ====================

  private setState(state: ViewerState, percent: number, label: string): void {
    // Ensure Angular picks up changes even if called from outside zone
    this.ngZone.run(() => {
      this.state = state;
      this.progressPercent = percent;
      this.progressLabel = label;
      this.errorMessage = null;
      this.cdr.markForCheck();
    });
  }

  private showError(message: string): void {
    this.ngZone.run(() => {
      this.state = 'error';
      this.errorMessage = message;
      this.cdr.markForCheck();
    });
  }

  get isLoading(): boolean {
    return this.state === 'downloading' || this.state === 'loading-engine';
  }

  goBack(): void {
    this.router.navigate(['/catalog']);
  }
}
