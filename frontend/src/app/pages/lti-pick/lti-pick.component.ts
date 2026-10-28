// path: src/app/pages/lti-pick/lti-pick.component.ts

import { ChangeDetectionStrategy, Component, OnDestroy, computed, inject, signal } from '@angular/core';

import { DEFAULT_CATALOG_FILTER } from '../../services/catalog-query';
import { LtiRequestError, LtiService } from '../../services/lti.service';
import { ScenarioService } from '../../services/scenario.service';

/** Wait after the last keystroke before querying the server. */
const SEARCH_DEBOUNCE_MS = 300;

const NOT_A_PICK = 'Ця сторінка відкривається з Moodle, коли викладач додає лабораторну роботу до курсу.';
const SESSION_ENDED = 'Сесію Moodle завершено. Почніть вибір роботи в Moodle ще раз.';
const SESSION_FAILED = 'Не вдалося отримати дані сесії Moodle. Оновіть сторінку.';

type PickAccess = 'loading' | 'allowed' | 'denied';

/**
 * `/lti/pick`: the teacher's catalog, reached from Moodle's Deep Linking launch. Choosing a scenario
 * is a native form POST to `/api/lti/deep-link`, so the browser navigates to the answer (an
 * auto-submit page with its own CSP that hands the choice back to Moodle) in the frame this page is in
 * (Moodle 5 shows it in a modal iframe, so nginx lets the configured LMS origins frame this route); it is never
 * fetched into the SPA. Shown only for a deep-linking session.
 */
@Component({
  selector: 'app-lti-pick',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './lti-pick.component.html',
  styleUrl: './lti-pick.component.scss',
})
export class LtiPickComponent implements OnDestroy {
  private readonly lti = inject(LtiService);
  private readonly scenarioService = inject(ScenarioService);

  readonly scenarios = this.scenarioService.scenarios;
  readonly isLoading = this.scenarioService.loading;
  readonly isLoaded = this.scenarioService.loaded;
  readonly catalogError = this.scenarioService.error;

  private readonly _access = signal<PickAccess>('loading');
  private readonly _message = signal<string | null>(null);
  readonly access = this._access.asReadonly();
  readonly message = this._message.asReadonly();

  readonly selectedId = signal<string | null>(null);
  readonly canSubmit = computed(() => this.access() === 'allowed' && this.selectedId() !== null);

  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    void this.start();
  }

  ngOnDestroy(): void {
    this.clearSearchTimer();
  }

  private async start(): Promise<void> {
    try {
      const session = await this.lti.getSession();
      if (session.messageType !== 'deep-link' || session.role !== 'instructor') {
        this.deny(NOT_A_PICK);
        return;
      }
    } catch (err) {
      this.deny(err instanceof LtiRequestError && err.status === 401 ? SESSION_ENDED : SESSION_FAILED);
      return;
    }
    this._access.set('allowed');
    await this.scenarioService.loadCatalog(DEFAULT_CATALOG_FILTER);
  }

  private deny(message: string): void {
    this._message.set(message);
    this._access.set('denied');
  }

  select(id: string): void {
    this.selectedId.set(id);
  }

  onSearch(event: Event): void {
    const q = (event.target as HTMLInputElement).value;
    this.clearSearchTimer();
    this.searchTimer = setTimeout(() => {
      this.selectedId.set(null);
      void this.scenarioService.loadCatalog({ ...DEFAULT_CATALOG_FILTER, q });
    }, SEARCH_DEBOUNCE_MS);
  }

  private clearSearchTimer(): void {
    if (this.searchTimer !== null) clearTimeout(this.searchTimer);
    this.searchTimer = null;
  }
}
