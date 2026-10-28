// path: src/app/pages/admin/dashboard/dashboard.component.ts

import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { Dashboard } from '../../../models/admin.model';
import { AdminApi } from '../../../services/admin-api.service';
import { AdminSession } from '../../../services/admin-session.service';
import { AdminService } from '../../../services/admin.service';
import { formatDateTime, pluralUk } from '../../../ui/format';
import { IconComponent } from '../../../ui/icon/icon.component';
import { StatusPillComponent } from '../../../ui/status-pill/status-pill.component';
import { STATUS_META, STATUS_ORDER, describeEvent } from '../scenario-rules';

interface QuickAction {
  label: string;
  link: string;
  icon: string;
  primary?: boolean;
}

/**
 * `/admin`, the landing page: a greeting, the counts by status, the latest journal rows and quick actions.
 * The server scopes the counts and the activity to the caller (an author sees only their own scenarios),
 * so this page only draws what it is given; the quick actions follow the role. A moderator also sees the
 * queue size, linking to the queue.
 */
@Component({
  selector: 'vl-dashboard',
  standalone: true,
  imports: [IconComponent, RouterLink, StatusPillComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './dashboard.component.scss',
  template: `
    <header class="page-head">
      <div>
        <h1 data-role="greeting">Вітаємо{{ session.user() ? ', ' + session.user()!.label : '' }}</h1>
        <p class="sub">{{ session.isModerator() ? 'Усі сценарії каталогу' : 'Ваші сценарії' }}</p>
      </div>
    </header>

    @if (error(); as message) {
      <p class="banner banner-error" role="alert">{{ message }}</p>
    }

    @if (!loaded()) {
      <p class="muted">Завантаження…</p>
    } @else if (data(); as dashboard) {
      <section class="counters" aria-label="Сценарії за статусами">
        @for (item of counters(); track item.status) {
          <div class="counter panel" [attr.data-status]="item.status">
            <vl-status-pill [status]="item.status" />
            <span class="number" data-role="count">{{ item.count }}</span>
          </div>
        }
      </section>

      @if (session.isModerator()) {
        <a class="queue-link panel" routerLink="/admin/queue" data-role="queue">
          <vl-icon name="seal-check" size="20" />
          <span>
            @if (dashboard.queueSize > 0) {
              <strong>{{ dashboard.queueSize }}</strong> {{ queueNoun() }} рішення
            } @else { Черга модерації порожня }
          </span>
          <vl-icon name="arrow-right" size="16" />
        </a>
      }

      <div class="dash-grid">
        <section class="panel" aria-labelledby="activity-title">
          <h2 id="activity-title">Остання активність</h2>
          @if (activity().length === 0) {
            <p class="muted" data-role="no-activity">Подій ще немає.</p>
          } @else {
            <ul class="activity">
              @for (item of activity(); track item.id) {
                <li data-role="activity-row">
                  <vl-icon [name]="item.view.icon" size="16" />
                  <div class="event">
                    <span class="event-text">
                      {{ item.view.text }}@if (item.scenarioId) {: <a [routerLink]="['/admin/scenarios', item.scenarioId, 'publish']">{{ item.title }}</a>}
                    </span>
                    @if (item.view.note) { <span class="event-note">«{{ item.view.note }}»</span> }
                    <span class="event-meta">{{ item.actor }} · {{ item.when }}</span>
                  </div>
                </li>
              }
            </ul>
          }
        </section>

        <section class="panel" aria-labelledby="actions-title">
          <h2 id="actions-title">Швидкі дії</h2>
          <div class="quick">
            @for (action of actions(); track action.link) {
              <a class="btn" [class.btn-primary]="action.primary" [class.btn-secondary]="!action.primary" [routerLink]="action.link">
                <vl-icon [name]="action.icon" size="16" />{{ action.label }}
              </a>
            }
          </div>
        </section>
      </div>
    }
  `,
})
export class DashboardComponent implements OnInit {
  private readonly api = inject(AdminApi);
  protected readonly session = inject(AdminSession);

  protected readonly data = signal<Dashboard | null>(null);
  protected readonly loaded = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly counters = computed(() => {
    const counts = this.data()?.counts;
    return STATUS_ORDER.map(status => ({ status, label: STATUS_META[status].label, count: counts?.[status] ?? 0 }));
  });

  protected readonly queueNoun = computed(() =>
    pluralUk(this.data()?.queueSize ?? 0, ['сценарій очікує', 'сценарії очікують', 'сценаріїв очікують']));

  protected readonly activity = computed(() =>
    (this.data()?.activity ?? []).map(row => ({
      id: row.id,
      view: describeEvent(row),
      scenarioId: row.scenarioId,
      title: row.scenarioTitle ?? row.scenarioId,
      actor: row.actorLabel,
      when: formatDateTime(row.createdAt),
    })));

  protected readonly actions = computed<QuickAction[]>(() => [
    { label: 'Новий сценарій', link: '/admin/upload', icon: 'upload-simple', primary: true },
    { label: this.session.isModerator() ? 'Усі сценарії' : 'Мої сценарії', link: '/admin/scenarios', icon: 'stack' },
    ...(this.session.isModerator()
      ? [
        { label: 'Черга модерації', link: '/admin/queue', icon: 'seal-check' },
        { label: 'Напрями', link: '/admin/categories', icon: 'folders' },
        { label: 'Доступ', link: '/admin/access', icon: 'shield-check' },
      ]
      : []),
  ]);

  ngOnInit(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.data.set(await this.api.dashboard());
    } catch (err) {
      this.error.set(AdminService.describeError(err));
    } finally {
      this.loaded.set(true);
    }
  }
}
