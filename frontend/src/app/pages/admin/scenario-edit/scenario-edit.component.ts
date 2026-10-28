// path: src/app/pages/admin/scenario-edit/scenario-edit.component.ts

import { ChangeDetectionStrategy, Component, HostListener, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { AdminScenario } from '../../../models/scenario.model';
import { AdminApi } from '../../../services/admin-api.service';
import { AdminSession } from '../../../services/admin-session.service';
import { AdminService } from '../../../services/admin.service';
import { formatDate } from '../../../ui/format';
import { IconComponent } from '../../../ui/icon/icon.component';
import { StatusPillComponent } from '../../../ui/status-pill/status-pill.component';
import { HasUnsavedChanges } from '../admin-guards';
import { ScenarioMetaFormComponent } from '../scenario-meta-form/scenario-meta-form.component';
import { ScenarioPublishComponent } from '../scenario-publish/scenario-publish.component';

export const EDIT_TABS = [
  { key: 'meta', label: 'Метадані' },
  { key: 'files', label: 'Файл' },
  { key: 'checks', label: 'Перевірка' },
  { key: 'publish', label: 'Публікація' },
] as const;
type TabKey = (typeof EDIT_TABS)[number]['key'];

type LoadState = 'loading' | 'ready' | 'missing' | 'error';

/**
 * `/admin/scenarios/:id/:tab`: one scenario's header and tabs. The Метадані form is never removed from
 * the page, only hidden, so what was typed there survives a visit to another tab; leaving the page with
 * unsaved edits asks first (`unsavedChangesGuard`, plus the browser's own prompt on a reload or close).
 */
@Component({
  selector: 'vl-scenario-edit',
  standalone: true,
  imports: [IconComponent, RouterLink, ScenarioMetaFormComponent, ScenarioPublishComponent, StatusPillComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './scenario-edit.component.scss',
  template: `
    <a class="back" routerLink="/admin/scenarios"><vl-icon name="arrow-left" size="14" />Сценарії</a>

    @switch (state()) {
      @case ('loading') { <p class="muted">Завантаження…</p> }
      @case ('missing') {
        <h1>Сценарій не знайдено</h1>
        <p class="muted">Такого сценарію немає або він не належить вашому коду.</p>
      }
      @case ('error') {
        <p class="banner banner-error" role="alert">{{ loadError() }}</p>
        <button type="button" class="btn btn-secondary" (click)="refresh()">Спробувати знову</button>
      }
    }

    @if (scenario(); as current) {
      <header class="edit-head">
        <div class="titles">
          <h1>{{ current.title || current.id }}</h1>
          <p class="subline">{{ subline() }}</p>
        </div>
        <vl-status-pill [status]="current.status" />
        @if (current.currentVersion; as version) {
          <a class="btn btn-secondary viewer-preview" [routerLink]="['/play', current.id]"
             [queryParams]="{ draft: version.sha256, returnTo: '/admin/scenarios/' + current.id + '/' + tab() }">
            <vl-icon name="play" size="14" />Превʼю у viewer
          </a>
        }
      </header>

      <nav class="tabs" aria-label="Розділи сценарію">
        @for (item of tabs; track item.key) {
          <a class="tab" [class.on]="tab() === item.key" [attr.aria-current]="tab() === item.key ? 'page' : null"
             [routerLink]="['/admin/scenarios', current.id, item.key]">{{ item.label }}</a>
        }
      </nav>

      <!-- Hidden, not removed: the form keeps its unsaved edits while another tab is open. -->
      <div class="tab-panel" [hidden]="tab() !== 'meta'">
        <vl-scenario-meta-form [scenario]="current" [role]="role()" (saved)="refresh()" />
      </div>

      @switch (tab()) {
        @case ('publish') {
          <vl-scenario-publish [scenario]="current" [role]="role()" (changed)="refresh()" />
        }
        @case ('files') { <p class="muted slot">Керування файлом і версіями зʼявиться в одному з наступних оновлень.</p> }
        @case ('checks') { <p class="muted slot">Перевірка архіву зʼявиться в одному з наступних оновлень.</p> }
      }
    }
  `,
})
export class ScenarioEditComponent implements HasUnsavedChanges {
  private readonly api = inject(AdminApi);
  private readonly session = inject(AdminSession);
  private readonly params = toSignal(inject(ActivatedRoute).paramMap, { requireSync: true });

  protected readonly tabs = EDIT_TABS;
  protected readonly scenario = signal<AdminScenario | null>(null);
  protected readonly state = signal<LoadState>('loading');
  protected readonly loadError = signal('');

  private readonly form = viewChild(ScenarioMetaFormComponent);

  protected readonly id = computed(() => this.params().get('id') ?? '');
  /** An unknown tab segment shows the first tab rather than a blank page. */
  protected readonly tab = computed<TabKey>(() => {
    const requested = this.params().get('tab');
    return EDIT_TABS.find(item => item.key === requested)?.key ?? 'meta';
  });
  protected readonly role = computed(() => this.session.role() ?? 'author');

  protected readonly subline = computed(() => {
    const s = this.scenario();
    if (!s) return '';
    const updated = formatDate(s.updatedAt);
    return [s.author, s.version, updated && `оновлено ${updated}`].filter(Boolean).join(' · ');
  });

  constructor() {
    effect(() => {
      this.id();
      untracked(() => {
        this.scenario.set(null);
        this.state.set('loading');
        void this.refresh();
      });
    });
  }

  hasUnsavedChanges(): boolean {
    return this.form()?.dirty() ?? false;
  }

  /** The browser's own prompt for a reload or a closed tab; the router guard covers in-app navigation. */
  @HostListener('window:beforeunload', ['$event'])
  protected onBeforeUnload(event: BeforeUnloadEvent): void {
    if (this.hasUnsavedChanges()) event.preventDefault();
  }

  /** Refetches the row; the page keeps showing the current one meanwhile. */
  protected async refresh(): Promise<void> {
    const id = this.id();
    try {
      const row = await this.api.scenario(id);
      if (id !== this.id()) return; // the user moved on to another scenario while this was in flight
      this.scenario.set(row);
      this.state.set(row ? 'ready' : 'missing');
    } catch (err) {
      if (id !== this.id()) return;
      this.loadError.set(AdminService.describeError(err));
      // A refresh that fails keeps the row already on screen; only a first load turns into an error page.
      if (!this.scenario()) this.state.set('error');
    }
  }
}
