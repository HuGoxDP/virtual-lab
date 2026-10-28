// path: src/app/pages/admin/scenario-publish/scenario-publish.component.ts

import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AdminRole, AuditRow, TransitionAction } from '../../../models/admin.model';
import { AdminScenario, ScenarioStatus } from '../../../models/scenario.model';
import { AdminApi } from '../../../services/admin-api.service';
import { AdminService } from '../../../services/admin.service';
import { formatDateTime } from '../../../ui/format';
import { IconComponent } from '../../../ui/icon/icon.component';
import { StatusPillComponent } from '../../../ui/status-pill/status-pill.component';
import { ToastService } from '../../../ui/toast/toast.service';
import { describeEvent, isReady, readiness, TransitionSpec, transitionsFor } from '../scenario-rules';

const MAX_NOTE = 2000;

const STATUS_TEXT: Readonly<Record<ScenarioStatus, string>> = {
  draft: 'Видно лише автору й модераторам.',
  review: 'Чекає на рішення модератора.',
  published: 'Видно всім у каталозі, без входу.',
  rejected: 'Повернено автору на доопрацювання.',
};

const DONE_TOAST: Readonly<Record<TransitionAction, string>> = {
  submit: 'Надіслано на модерацію',
  withdraw: 'Відкликано з перевірки',
  approve: 'Опубліковано в каталозі',
  reject: 'Повернено на доопрацювання',
  unpublish: 'Знято з публікації',
};

/**
 * The Публікація tab (prototype 2j): the status, the transitions the role may make, the moderator's
 * reason, the way into the catalog and the decision history read from the journal. Which buttons exist
 * comes from `transitionsFor`; the server decides whether one works, and its refusal is shown as it is.
 */
@Component({
  selector: 'vl-scenario-publish',
  standalone: true,
  imports: [IconComponent, RouterLink, StatusPillComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './scenario-publish.component.scss',
  template: `
    <div class="publish-grid">
      <section class="panel status-panel">
        <h2>Статус</h2>
        <p class="status-line"><vl-status-pill [status]="scenario().status" /><span class="status-text">{{ statusText() }}</span></p>

        @if (scenario().moderatorNote; as note) {
          <div class="note-box">
            <span class="note-title">Коментар модератора</span>
            <p class="note-text">{{ note }}</p>
          </div>
        }

        @if (error(); as message) {
          <p class="banner banner-error" role="alert">{{ message }}</p>
        }

        @if (needsNote()) {
          <div class="field">
            <label for="reject-note">Коментар автору</label>
            <textarea id="reject-note" class="input" rows="3" [maxLength]="maxNote" [value]="note()"
                      placeholder="Що потрібно виправити. Без коментаря автор побачить стандартний текст."
                      (input)="onNote($event)"></textarea>
          </div>
        }

        <div class="actions">
          @for (spec of specs(); track spec.action) {
            <button type="button" class="btn" [class.btn-primary]="spec.primary" [class.btn-secondary]="!spec.primary"
                    [attr.data-action]="spec.action" [disabled]="busy() || !!spec.disabledReason" (click)="run(spec)">
              {{ spec.label }}
            </button>
          }
          @if (scenario().status === 'published') {
            <a class="btn btn-secondary" [routerLink]="['/scenario', scenario().id]">
              <vl-icon name="arrow-square-out" size="16" />Відкрити в каталозі
            </a>
          }
        </div>

        @for (spec of specs(); track spec.action) {
          @if (spec.disabledReason) { <p class="hint">{{ spec.disabledReason }}</p> }
        }
        @if (specs().length === 0) {
          <p class="hint">{{ idleText() }}</p>
        }

        @if (showReadinessWarning()) {
          <div class="banner banner-warn not-ready">
            <strong>Не все готово.</strong> Публікація можлива, але:
            @for (item of missing(); track item.key; let last = $last) { {{ item.label.toLowerCase() }}{{ last ? '.' : ',' }} }
            Заповніть це на вкладці «Метадані».
          </div>
        }
      </section>

      <section class="panel history-panel">
        <h2>Історія рішень</h2>
        @if (historyError(); as message) {
          <p class="banner banner-error" role="alert">{{ message }}</p>
        }
        @if (history().length === 0 && !historyError()) {
          <p class="muted">Записів ще немає.</p>
        }
        <ul class="history">
          @for (event of events(); track event.id) {
            <li>
              <vl-icon [name]="event.view.icon" size="16" />
              <div class="event">
                <span class="event-text">{{ event.view.text }}</span>
                @if (event.view.note) { <span class="event-note">«{{ event.view.note }}»</span> }
                <span class="event-meta">{{ event.actor }} · {{ event.when }}</span>
              </div>
            </li>
          }
        </ul>
      </section>
    </div>
  `,
})
export class ScenarioPublishComponent {
  readonly scenario = input.required<AdminScenario>();
  readonly role = input.required<AdminRole>();
  /** A transition went through: refetch the row. */
  readonly changed = output<void>();

  private readonly api = inject(AdminApi);
  private readonly toast = inject(ToastService);

  protected readonly maxNote = MAX_NOTE;
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly note = signal('');
  protected readonly history = signal<AuditRow[]>([]);
  protected readonly historyError = signal<string | null>(null);

  protected readonly statusText = computed(() => STATUS_TEXT[this.scenario().status] ?? '');

  protected readonly specs = computed(() => {
    const { status, archiveSha256, currentVersion } = this.scenario();
    return transitionsFor(this.role(), status, !!(currentVersion || archiveSha256));
  });

  protected readonly needsNote = computed(() => this.specs().some(spec => spec.needsNote));

  private readonly readinessItems = computed(() => {
    const { description, imageUrl, currentVersion, archiveSha256 } = this.scenario();
    return readiness({ description, imageUrl, currentVersion, archiveSha256 });
  });
  protected readonly missing = computed(() => this.readinessItems().filter(item => item.level !== 'ok'));
  /** Offered where a moderator is about to publish something with a hole in it. */
  protected readonly showReadinessWarning = computed(
    () => this.specs().some(spec => spec.action === 'approve' && !spec.disabledReason) && !isReady(this.readinessItems())
  );

  protected readonly idleText = computed(() => {
    const { status } = this.scenario();
    if (this.role() === 'author' && status === 'published') {
      return 'Опубліковано. Метадані ви змінюєте напряму; новий архів потрапить до модератора як нова версія.';
    }
    if (status === 'review') return 'Сценарій на перевірці у модератора.';
    return 'Для цього статусу немає доступних дій.';
  });

  protected readonly events = computed(() =>
    this.history().map(row => ({
      id: row.id,
      view: describeEvent(row),
      actor: row.actorLabel,
      when: formatDateTime(row.createdAt),
    }))
  );

  constructor() {
    effect(() => {
      void this.scenario().id;
      untracked(() => {
        this.note.set('');
        this.error.set(null);
        void this.loadHistory();
      });
    });
  }

  protected onNote(event: Event): void {
    this.note.set((event.target as HTMLTextAreaElement).value);
  }

  protected async run(spec: TransitionSpec): Promise<void> {
    if (this.busy() || spec.disabledReason) return;
    if (spec.confirm && !confirm(spec.confirm)) return;

    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.transition(this.scenario().id, spec.action, spec.needsNote ? this.note().trim() || undefined : undefined);
      this.note.set('');
      this.toast.show(DONE_TOAST[spec.action]);
      this.changed.emit();
      await this.loadHistory();
    } catch (err) {
      // The server is the authority: a refusal (wrong status, no archive, not yours) is shown as sent.
      this.error.set(AdminService.describeError(err));
    } finally {
      this.busy.set(false);
    }
  }

  private async loadHistory(): Promise<void> {
    try {
      this.history.set(await this.api.history(this.scenario().id));
      this.historyError.set(null);
    } catch (err) {
      this.historyError.set(AdminService.describeError(err));
    }
  }
}
