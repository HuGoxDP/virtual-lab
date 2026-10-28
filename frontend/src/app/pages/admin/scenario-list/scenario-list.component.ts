// path: src/app/pages/admin/scenario-list/scenario-list.component.ts

import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AdminCategory, BulkAction, BulkResult } from '../../../models/admin.model';
import { AdminScenario, ScenarioStatus } from '../../../models/scenario.model';
import { AdminApi } from '../../../services/admin-api.service';
import { AdminSession } from '../../../services/admin-session.service';
import { AdminService } from '../../../services/admin.service';
import { formatBytes, pluralUk } from '../../../ui/format';
import { IconComponent } from '../../../ui/icon/icon.component';
import { StatusPillComponent } from '../../../ui/status-pill/status-pill.component';
import { STATUS_META, STATUS_ORDER } from '../scenario-rules';

type StatusFilter = 'all' | ScenarioStatus;

interface BulkReport {
  /** What was asked, for the heading. */
  label: string;
  results: BulkResult[];
}

const BULK_LABELS: Readonly<Record<BulkAction, string>> = {
  approve: 'Опублікування',
  unpublish: 'Зняття з публікації',
  'set-category': 'Зміна категорії',
  delete: 'Видалення',
};

/**
 * `/admin/scenarios` (prototype 2f): status chips with counts, a category filter and the table. The list
 * is unpaged, so both filters run here (the server-side-filter rule is about the paged public catalog).
 * A moderator can select rows and act on them at once; the server answers per scenario and each answer is shown.
 */
@Component({
  selector: 'vl-scenario-list',
  standalone: true,
  imports: [IconComponent, RouterLink, StatusPillComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './scenario-list.component.scss',
  template: `
    <header class="page-head">
      <div>
        <h1>{{ session.isModerator() ? 'Усі сценарії' : 'Мої сценарії' }}</h1>
        <p class="sub">{{ summary() }}</p>
      </div>
      <a class="btn btn-primary" routerLink="/admin/upload"><vl-icon name="plus" size="16" />Новий сценарій</a>
    </header>

    @if (error(); as message) {
      <p class="banner banner-error" role="alert">{{ message }}</p>
    }

    <div class="filters">
      <div class="chips" role="group" aria-label="Статус">
        @for (chip of chips(); track chip.key) {
          <button type="button" class="chip status-chip" [class.on]="statusFilter() === chip.key"
                  [attr.aria-pressed]="statusFilter() === chip.key" (click)="setStatus(chip.key)">
            {{ chip.label }} <span class="count">{{ chip.count }}</span>
          </button>
        }
      </div>
      <div class="field category-filter">
        <label for="category-filter">Категорія</label>
        <select id="category-filter" class="input" [value]="categoryFilter()" (change)="setCategory($event)">
          <option value="">Усі категорії</option>
          @for (option of categoryOptions(); track option.slug) {
            <option [value]="option.slug" [selected]="option.slug === categoryFilter()">{{ option.label }}</option>
          }
        </select>
      </div>
    </div>

    @if (session.isModerator() && selected().size > 0) {
      <div class="bulk-bar" role="region" aria-label="Масові дії">
        <span class="bulk-count">Вибрано {{ selected().size }} {{ selectedNoun() }}</span>
        <button type="button" class="btn btn-primary" [disabled]="busy()" (click)="runBulk('approve')">Опублікувати</button>
        <button type="button" class="btn btn-secondary" [disabled]="busy()" (click)="runBulk('unpublish')">Зняти з публікації</button>
        <span class="bulk-category">
          <select class="input" aria-label="Нова категорія" [value]="bulkCategory()" (change)="onBulkCategory($event)">
            <option value="">Категорія…</option>
            @for (category of categories(); track category.slug) {
              <option [value]="category.slug">{{ category.label }}</option>
            }
          </select>
          <button type="button" class="btn btn-secondary" [disabled]="busy() || !bulkCategory()" (click)="runBulk('set-category')">
            Змінити категорію
          </button>
        </span>
        <button type="button" class="btn btn-secondary danger" [disabled]="busy()" (click)="runBulk('delete')">Видалити</button>
        <button type="button" class="btn btn-ghost" (click)="clearSelection()">Зняти виділення</button>
      </div>
    }

    @if (report(); as result) {
      <section class="bulk-results" aria-label="Результат масової дії">
        <div class="bulk-results-head">
          <strong>{{ result.label }}: {{ okCount(result) }} з {{ result.results.length }}</strong>
          <button type="button" class="btn btn-ghost" (click)="report.set(null)">Закрити</button>
        </div>
        <ul>
          @for (item of result.results; track item.id) {
            <li [class.failed]="!item.ok">
              <vl-icon [name]="item.ok ? 'check-circle' : 'warning-circle'" size="16" />
              <span class="result-id">{{ titleOf(item.id) }}</span>
              @if (!item.ok) { <span class="result-error">{{ item.error }}</span> }
            </li>
          }
        </ul>
      </section>
    }

    @if (loading()) {
      <p class="muted">Завантаження…</p>
    } @else if (rows().length === 0) {
      <p class="muted">Сценаріїв ще немає.</p>
    } @else if (visible().length === 0) {
      <p class="muted">За цими фільтрами нічого немає. <button type="button" class="btn btn-ghost" (click)="resetFilters()">Скинути фільтри</button></p>
    } @else {
      <div class="table-wrap">
        <table class="table scenario-table">
          <thead>
            <tr>
              @if (session.isModerator()) {
                <th class="select-col">
                  <input type="checkbox" aria-label="Вибрати всі" [checked]="allSelected()" (change)="toggleAll()" />
                </th>
              }
              <th>Сценарій</th>
              <th>Категорія</th>
              <th>Версія</th>
              <th>Автор</th>
              <th>Архів</th>
              <th>Статус</th>
              <th><span class="visually-hidden">Дії</span></th>
            </tr>
          </thead>
          <tbody>
            @for (row of visible(); track row.id) {
              <tr class="row" [class.selected]="selected().has(row.id)">
                @if (session.isModerator()) {
                  <td class="select-col">
                    <input type="checkbox" [attr.aria-label]="'Вибрати ' + (row.title || row.id)"
                           [checked]="selected().has(row.id)" (change)="toggle(row.id)" />
                  </td>
                }
                <td class="title-cell">
                  <a class="row-title" [routerLink]="['/admin/scenarios', row.id, 'meta']">{{ row.title || '—' }}</a>
                  <code class="row-id">{{ row.id }}</code>
                </td>
                <td class="wrap">{{ row.categoryLabel }}</td>
                <td class="nowrap">{{ row.version || '—' }}</td>
                <td class="wrap author">{{ row.author || '—' }}</td>
                <td class="nowrap">{{ archiveLabel(row) }}</td>
                <td>
                  <vl-status-pill [status]="row.status" />
                  @if (row.pendingVersionId) { <span class="tag tag-accent pending">Нова версія</span> }
                </td>
                <td class="actions">
                  <a class="btn btn-ghost" [routerLink]="['/admin/scenarios', row.id, 'meta']">Редагувати</a>
                  @if (row.status === 'published') {
                    <a class="btn btn-ghost" [routerLink]="['/scenario', row.id]">Переглянути</a>
                  } @else if (row.currentVersion; as version) {
                    <a class="btn btn-ghost" [routerLink]="['/play', row.id]"
                       [queryParams]="{ draft: version.sha256, returnTo: '/admin/scenarios' }">Переглянути</a>
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
})
export class ScenarioListComponent implements OnInit {
  private readonly api = inject(AdminApi);
  protected readonly session = inject(AdminSession);

  protected readonly rows = signal<AdminScenario[]>([]);
  protected readonly categories = signal<AdminCategory[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected readonly statusFilter = signal<StatusFilter>('all');
  protected readonly categoryFilter = signal('');
  protected readonly selected = signal<ReadonlySet<string>>(new Set());
  protected readonly bulkCategory = signal('');
  protected readonly report = signal<BulkReport | null>(null);

  protected readonly chips = computed(() => {
    const rows = this.rows();
    return [
      { key: 'all' as StatusFilter, label: 'Усі', count: rows.length },
      ...STATUS_ORDER.map(key => ({
        key: key as StatusFilter, label: STATUS_META[key].label, count: rows.filter(row => row.status === key).length,
      })),
    ];
  });

  /** Categories the visible rows actually use, so an author's filter never offers an empty one. */
  protected readonly categoryOptions = computed(() => {
    const seen = new Map<string, string>();
    for (const row of this.rows()) if (!seen.has(row.category)) seen.set(row.category, row.categoryLabel || row.category);
    return [...seen].map(([slug, label]) => ({ slug, label }));
  });

  protected readonly visible = computed(() => {
    const status = this.statusFilter();
    const category = this.categoryFilter();
    return this.rows().filter(row => (status === 'all' || row.status === status) && (!category || row.category === category));
  });

  protected readonly allSelected = computed(() => {
    const visible = this.visible();
    return visible.length > 0 && visible.every(row => this.selected().has(row.id));
  });

  protected readonly summary = computed(() => {
    const rows = this.rows();
    const count = (status: ScenarioStatus) => rows.filter(row => row.status === status).length;
    const noun = pluralUk(rows.length, ['запис', 'записи', 'записів']);
    return `${rows.length} ${noun} · ${count('published')} опубліковано · ${count('review')} на перевірці`;
  });

  protected readonly selectedNoun = computed(() => pluralUk(this.selected().size, ['сценарій', 'сценарії', 'сценаріїв']));

  ngOnInit(): void {
    void this.load();
    if (this.session.isModerator()) void this.loadCategories();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.rows.set(await this.api.listScenarios());
    } catch (err) {
      this.rows.set([]);
      this.error.set(AdminService.describeError(err));
    } finally {
      this.loading.set(false);
    }
  }

  private async loadCategories(): Promise<void> {
    try {
      this.categories.set(await this.api.categories());
    } catch (err) {
      this.error.set(AdminService.describeError(err));
    }
  }

  // ==================== FILTERS ====================

  protected setStatus(status: StatusFilter): void {
    this.statusFilter.set(status);
    this.clearSelection();
  }

  protected setCategory(event: Event): void {
    this.categoryFilter.set((event.target as HTMLSelectElement).value);
    this.clearSelection();
  }

  protected resetFilters(): void {
    this.statusFilter.set('all');
    this.categoryFilter.set('');
    this.clearSelection();
  }

  // ==================== SELECTION ====================

  protected toggle(id: string): void {
    this.selected.update(current => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  protected toggleAll(): void {
    this.selected.set(this.allSelected() ? new Set() : new Set(this.visible().map(row => row.id)));
  }

  protected clearSelection(): void {
    this.selected.set(new Set());
  }

  // ==================== BULK ====================

  protected onBulkCategory(event: Event): void {
    this.bulkCategory.set((event.target as HTMLSelectElement).value);
  }

  protected async runBulk(action: BulkAction): Promise<void> {
    const ids = [...this.selected()];
    if (this.busy() || ids.length === 0) return;
    if (action === 'delete' && !confirm(`Видалити вибрані сценарії (${ids.length})? Записи каталогу буде видалено без відновлення.`)) return;

    this.busy.set(true);
    this.error.set(null);
    try {
      const results = await this.api.bulk(ids, action, action === 'set-category' ? this.bulkCategory() : undefined);
      this.report.set({ label: BULK_LABELS[action], results });
      this.clearSelection();
      await this.load();
    } catch (err) {
      // A malformed request (400) refuses the whole batch; nothing ran, so the selection stays.
      this.error.set(AdminService.describeError(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected okCount(report: BulkReport): number {
    return report.results.filter(result => result.ok).length;
  }

  /** The title a result line is about; the id when the row is gone (deleted) or unknown. */
  protected titleOf(id: string): string {
    return this.rows().find(row => row.id === id)?.title || id;
  }

  // ==================== ROW ====================

  protected archiveLabel(row: AdminScenario): string {
    return formatBytes(row.archiveBytes) || 'Немає архіву';
  }
}
