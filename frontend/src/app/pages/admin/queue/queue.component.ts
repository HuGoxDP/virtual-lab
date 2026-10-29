// path: src/app/pages/admin/queue/queue.component.ts

import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AuditRow } from '../../../models/admin.model';
import { AdminScenario } from '../../../models/scenario.model';
import { AdminApi } from '../../../services/admin-api.service';
import { AdminService } from '../../../services/admin.service';
import { formatBytes, formatDate, formatDateTime, pluralUk } from '../../../ui/format';
import { IconComponent } from '../../../ui/icon/icon.component';
import { ToastService } from '../../../ui/toast/toast.service';
import { ReviewChip, describeEvent, reviewChips } from '../scenario-rules';

type QueueTab = 'pending' | 'returned' | 'done';

const TABS: ReadonlyArray<{ key: QueueTab; label: string }> = [
  { key: 'pending', label: 'Очікують' },
  { key: 'returned', label: 'Повернуті' },
  { key: 'done', label: 'Опрацьовані' },
];

/** The journal actions that are a moderator's decision, for «Нещодавні рішення». */
const DECISION_ACTIONS: ReadonlySet<string> = new Set(['scenario.approve', 'scenario.reject', 'version.accept', 'version.reject']);

const MAX_NOTE = 2000;

/** Newest decisions on the "done" tab; the others show a handful beneath the cards. */
const RECENT_BESIDE_CARDS = 5;

type Decision = 'approve' | 'reject';

interface QueueCard {
  row: AdminScenario;
  /** A published scenario with an author's new archive waiting. */
  proposal: boolean;
  chips: ReviewChip[];
  when: string;
  size: string;
}

/**
 * `/admin/queue` (prototype 2k), a moderator's page. A card per scenario that waits for a decision: one
 * submitted for review, or a published one with an author's new archive waiting. Each card carries the
 * check summary the moderator needs and decides inline: publish (or accept the new version), or return
 * with a note. The journal's recent decisions sit below. Lists are filtered here: the admin list is unpaged.
 * All author-supplied text (titles, descriptions, notes, owner names) is interpolated, never `innerHTML`.
 */
@Component({
  selector: 'vl-queue',
  standalone: true,
  imports: [IconComponent, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './queue.component.scss',
  template: `
    <header class="page-head">
      <div>
        <h1>Модерація</h1>
        <p class="sub" data-role="summary">{{ summary() }}</p>
      </div>
    </header>

    @if (error(); as message) {
      <p class="banner banner-error" role="alert">{{ message }}</p>
    }

    <div class="seg tabs" role="group" aria-label="Розділ черги">
      @for (item of tabs; track item.key) {
        <button type="button" class="seg-opt tab" [class.on]="tab() === item.key" [attr.data-tab]="item.key"
                [attr.aria-pressed]="tab() === item.key" (click)="tab.set(item.key)">
          {{ item.label }} <span class="count">{{ counts()[item.key] }}</span>
        </button>
      }
    </div>

    @if (!loaded()) {
      <p class="muted">Завантаження…</p>
    }

    @if (tab() !== 'done' && loaded()) {
      @if (cards().length === 0) {
        <div class="empty" data-role="empty">
          <vl-icon name="seal-check" size="28" />
          <p>{{ tab() === 'pending' ? 'Черга порожня: усе розглянуто.' : 'Повернутих сценаріїв немає.' }}</p>
        </div>
      }
      <div class="cards">
        @for (card of cards(); track card.row.id) {
          <article class="card queue-card" [attr.data-id]="card.row.id">
            <header class="card-head">
              <div class="titles">
                <h2 class="card-title">{{ card.row.title || card.row.id }}</h2>
                <span class="card-meta">{{ card.row.categoryLabel || card.row.category }} · {{ card.row.id }}</span>
              </div>
              @if (card.proposal) { <span class="tag tag-accent" data-role="proposal">Нова версія архіву</span> }
            </header>

            <p class="byline">
              {{ card.row.ownerLabel || card.row.author || 'Без автора' }}
              @if (card.when) { · подано {{ card.when }} }
              @if (card.size) { · {{ card.size }} }
              @if (card.row.version) { · v{{ card.row.version }} }
            </p>

            @if (card.row.description) {
              <p class="desc">{{ card.row.description }}</p>
            } @else {
              <p class="desc missing">Немає опису</p>
            }

            @if (card.proposal) {
              <p class="hint" data-role="proposal-hint">
                Автор завантажив новий архів для опублікованого сценарію. Студенти отримують старий, поки ви не приймете новий.
              </p>
            } @else {
              <ul class="chips" aria-label="Підсумок перевірки">
                @for (chip of card.chips; track chip.label) {
                  <li class="check-chip" [attr.data-level]="chip.level">
                    <vl-icon [name]="chip.level === 'ok' ? 'check-circle' : chip.level === 'warn' ? 'warning' : 'warning-circle'" size="14" />
                    {{ chip.label }}
                    <span class="visually-hidden">{{ chip.level === 'ok' ? ' — гаразд' : chip.level === 'warn' ? ' — зауваження' : ' — проблема' }}</span>
                  </li>
                }
              </ul>
            }

            @if (card.row.status === 'rejected' && card.row.moderatorNote) {
              <p class="returned-note" data-role="returned-note">Повернуто: «{{ card.row.moderatorNote }}»</p>
            }

            @if (errors()[card.row.id]; as problem) {
              <p class="banner banner-error" role="alert">{{ problem }}</p>
            }

            @if (noteFor() === card.row.id && !card.proposal) {
              <div class="field">
                <label [for]="'note-' + card.row.id">Коментар автору</label>
                <textarea [id]="'note-' + card.row.id" class="input" rows="3" [maxLength]="maxNote" [value]="note()"
                          placeholder="Що потрібно виправити. Без коментаря автор побачить стандартний текст."
                          (input)="onNote($event)"></textarea>
              </div>
            }

            <footer class="actions">
              @if (tab() === 'pending') {
                @if (noteFor() === card.row.id && !card.proposal) {
                  <button type="button" class="btn btn-primary" data-action="confirm-return" [disabled]="busyId() !== null" (click)="decide(card, 'reject')">
                    Повернути
                  </button>
                  <button type="button" class="btn btn-ghost" data-action="cancel-return" (click)="cancelReturn()">Скасувати</button>
                } @else {
                  <button type="button" class="btn btn-primary" data-action="approve"
                          [disabled]="busyId() !== null || (!card.proposal && !card.row.currentVersion && !card.row.archiveSha256)"
                          (click)="decide(card, 'approve')">
                    {{ card.proposal ? 'Прийняти версію' : 'Публікувати' }}
                  </button>
                  <button type="button" class="btn btn-secondary" data-action="return" [disabled]="busyId() !== null" (click)="card.proposal ? decide(card, 'reject') : startReturn(card.row.id)">
                    {{ card.proposal ? 'Відхилити' : 'Повернути' }}
                  </button>
                }
              }
              @if (!card.proposal && card.row.currentVersion; as version) {
                <a class="btn btn-ghost" data-action="viewer" [routerLink]="['/play', card.row.id]"
                   [queryParams]="{ draft: version.sha256, returnTo: '/admin/queue' }">
                  <vl-icon name="play" size="14" />Переглянути у viewer
                </a>
              }
              <a class="btn btn-ghost" data-action="details" [routerLink]="['/admin/scenarios', card.row.id, card.proposal ? 'files' : 'publish']">Деталі</a>
            </footer>
          </article>
        }
      </div>
    }

    @if (tab() !== 'returned' && loaded()) {
      <section class="panel decisions" aria-labelledby="decisions-title">
        <h2 id="decisions-title">Нещодавні рішення</h2>
        @if (decisions().length === 0) {
          <p class="muted" data-role="no-decisions">Рішень ще немає.</p>
        } @else {
          <div class="table-wrap">
            <table class="table" data-role="decisions">
              <thead><tr><th>Сценарій</th><th>Рішення</th><th>Модератор</th><th>Коли</th></tr></thead>
              <tbody>
                @for (item of decisions(); track item.id) {
                  <tr>
                    <td>
                      @if (item.scenarioId) {
                        <a class="row-title" [routerLink]="['/admin/scenarios', item.scenarioId, 'publish']">{{ item.title }}</a>
                      } @else { {{ item.title }} }
                    </td>
                    <td>
                      <span class="decision"><vl-icon [name]="item.icon" size="14" />{{ item.text }}</span>
                      @if (item.note) { <span class="decision-note">«{{ item.note }}»</span> }
                    </td>
                    <td>{{ item.actor }}</td>
                    <td class="nowrap">{{ item.when }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>
    }
  `,
})
export class QueueComponent implements OnInit {
  private readonly api = inject(AdminApi);
  private readonly toast = inject(ToastService);

  protected readonly tabs = TABS;
  protected readonly maxNote = MAX_NOTE;
  protected readonly tab = signal<QueueTab>('pending');

  private readonly rows = signal<AdminScenario[]>([]);
  private readonly activity = signal<AuditRow[]>([]);
  protected readonly loading = signal(false);
  /** The first answer (or failure) has arrived: until then the page says it is loading; reloads keep the cards on screen. */
  protected readonly loaded = signal(false);
  protected readonly error = signal<string | null>(null);
  /** The card a decision is in flight for (one at a time: a second click on another card waits). */
  protected readonly busyId = signal<string | null>(null);
  /** Per-card refusal, shown as the server sent it. */
  protected readonly errors = signal<Readonly<Record<string, string>>>({});
  /** The card whose "return" note field is open. */
  protected readonly noteFor = signal<string | null>(null);
  protected readonly note = signal('');

  private readonly pending = computed(() =>
    this.rows()
      .filter(row => row.status === 'review' || row.pendingVersionId != null)
      .sort((a, b) => (a.submittedAt ?? '9999').localeCompare(b.submittedAt ?? '9999')));
  private readonly returned = computed(() => this.rows().filter(row => row.status === 'rejected'));

  protected readonly counts = computed<Record<QueueTab, number>>(() => ({
    pending: this.pending().length, returned: this.returned().length, done: this.allDecisions().length,
  }));

  private readonly allDecisions = computed(() =>
    this.activity()
      .filter(row => DECISION_ACTIONS.has(row.action))
      .map(row => ({
        id: row.id, scenarioId: row.scenarioId, title: row.scenarioTitle ?? row.scenarioId ?? 'Видалений сценарій',
        actor: row.actorLabel, when: formatDateTime(row.createdAt), ...describeEvent(row),
      })));

  protected readonly decisions = computed(() => this.allDecisions().slice(0, this.tab() === 'done' ? undefined : RECENT_BESIDE_CARDS));

  protected readonly cards = computed<QueueCard[]>(() => {
    const list = this.tab() === 'returned' ? this.returned() : this.pending();
    return list.map(row => ({
      row,
      proposal: row.status === 'published' && row.pendingVersionId != null,
      chips: reviewChips(row),
      when: formatDateTime(row.submittedAt),
      size: formatBytes(row.archiveBytes),
    }));
  });

  protected readonly summary = computed(() => {
    const waiting = this.pending();
    if (this.loading() && this.rows().length === 0) return '';
    if (waiting.length === 0) return 'Немає сценаріїв, що очікують рішення';
    const noun = pluralUk(waiting.length, ['сценарій очікує', 'сценарії очікують', 'сценаріїв очікують']);
    const oldest = waiting.find(row => row.submittedAt)?.submittedAt;
    return `${waiting.length} ${noun} рішення${oldest ? ` · найстаріший подано ${formatDate(oldest)}` : ''}`;
  });

  /** Counts loads: only the newest answer may write state. */
  private request = 0;

  ngOnInit(): void {
    void this.load();
  }

  protected onNote(event: Event): void {
    this.note.set((event.target as HTMLTextAreaElement).value);
  }

  protected startReturn(id: string): void {
    this.noteFor.set(id);
    this.note.set('');
  }

  protected cancelReturn(): void {
    this.noteFor.set(null);
    this.note.set('');
  }

  /** Publish / accept, or return / reject: one request, then the lists are read again so status and journal agree. */
  protected async decide(card: QueueCard, decision: Decision): Promise<void> {
    const { row, proposal } = card;
    if (this.busyId() !== null) return;
    if (decision === 'approve' && !proposal && card.chips.some(chip => chip.level === 'bad')
        && !confirm('Автоперевірка або заповненість мають проблеми. Опублікувати все одно?')) return;
    if (decision === 'reject' && proposal && !confirm('Відхилити нову версію архіву? Автор побачить, що її не прийнято.')) return;

    this.busyId.set(row.id);
    this.errors.update(current => ({ ...current, [row.id]: '' }));
    try {
      if (proposal) {
        await this.api.versionAction(row.id, row.pendingVersionId!, decision === 'approve' ? 'accept' : 'reject');
      } else {
        await this.api.transition(row.id, decision, decision === 'reject' ? this.note().trim() || undefined : undefined);
      }
      this.toast.show(TOASTS[decision][proposal ? 'version' : 'scenario']);
      this.cancelReturn();
      await this.load();
    } catch (err) {
      // The server is the authority: a refusal (wrong status, no archive) is shown on the card as sent.
      this.errors.update(current => ({ ...current, [row.id]: AdminService.describeError(err) }));
    } finally {
      this.busyId.set(null);
    }
  }

  private async load(): Promise<void> {
    const request = ++this.request;
    this.loading.set(true);
    this.error.set(null);
    try {
      const [rows, dashboard] = await Promise.all([this.api.listScenarios(), this.api.dashboard()]);
      if (request !== this.request) return;
      this.rows.set(rows);
      this.activity.set(dashboard.activity);
    } catch (err) {
      if (request === this.request) this.error.set(AdminService.describeError(err));
    } finally {
      if (request === this.request) { this.loading.set(false); this.loaded.set(true); }
    }
  }
}

const TOASTS: Readonly<Record<Decision, Readonly<Record<'scenario' | 'version', string>>>> = {
  approve: { scenario: 'Опубліковано в каталозі', version: 'Нову версію прийнято' },
  reject: { scenario: 'Повернено на доопрацювання', version: 'Нову версію відхилено' },
};
