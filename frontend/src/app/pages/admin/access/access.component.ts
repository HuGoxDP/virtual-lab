// path: src/app/pages/admin/access/access.component.ts

import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';

import { AdminRole, CreatedKey, KeyRow } from '../../../models/admin.model';
import { AdminApi } from '../../../services/admin-api.service';
import { AdminSession } from '../../../services/admin-session.service';
import { AdminService } from '../../../services/admin.service';
import { formatDateTime } from '../../../ui/format';
import { IconComponent } from '../../../ui/icon/icon.component';
import { ModalComponent } from '../../../ui/modal/modal.component';
import { ToastService } from '../../../ui/toast/toast.service';

const MAX_LABEL = 100;

/**
 * `/admin/access`, a moderator's page: personal access codes. Issue one (name and role), see when each
 * was last used, revoke. The server returns the code once; it lives only in `issued`, which the dialog
 * shows and every way of closing it clears, so it can never be shown again (the server keeps only a hash).
 * Revoking the key this very session signs in with ends the session. Names are author-supplied text:
 * interpolated only.
 */
@Component({
  selector: 'vl-access',
  standalone: true,
  imports: [IconComponent, ModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './access.component.scss',
  template: `
    <header class="page-head">
      <div>
        <h1>Доступ</h1>
        <p class="sub">Особисті коди для авторів і модераторів. Код показується один раз — зберігається лише його хеш.</p>
      </div>
    </header>

    @if (error(); as message) { <p class="banner banner-error" role="alert" data-role="error">{{ message }}</p> }

    <section class="panel issue" aria-labelledby="issue-title">
      <h2 id="issue-title">Видати код</h2>
      <form (submit)="issue($event)" novalidate>
        <div class="field">
          <label for="key-label">Імʼя</label>
          <input id="key-label" class="input" [value]="label()" [maxLength]="maxLabel" placeholder="Наприклад, Олена Мельник" (input)="label.set($any($event.target).value)" />
        </div>
        <div class="field">
          <label for="key-role">Роль</label>
          <select id="key-role" class="input" [value]="role()" (change)="role.set($any($event.target).value)">
            <option value="author">Автор</option>
            <option value="moderator">Модератор</option>
          </select>
        </div>
        <button type="submit" class="btn btn-primary" data-action="issue" [disabled]="busy()"><vl-icon name="plus" size="16" />Видати</button>
      </form>
      @if (formError(); as problem) { <p class="banner banner-error" role="alert" data-role="form-error">{{ problem }}</p> }
    </section>

    @if (!loaded()) {
      <p class="muted">Завантаження…</p>
    } @else {
      <div class="table-wrap">
        <table class="table keys-table" data-role="keys">
          <thead><tr><th>Імʼя</th><th>Роль</th><th>Створено</th><th>Останнє використання</th><th>Стан</th><th><span class="visually-hidden">Дії</span></th></tr></thead>
          <tbody>
            @for (key of rows(); track key.id) {
              <tr [attr.data-key]="key.id" [class.revoked]="key.revokedAt">
                <td class="name">{{ key.label }}@if (key.isMine) { <span class="tag tag-accent mine">це ви</span> }</td>
                <td>{{ key.role === 'moderator' ? 'Модератор' : 'Автор' }}</td>
                <td class="nowrap">{{ key.created }}</td>
                <td class="nowrap" data-role="last-used">{{ key.lastUsed }}</td>
                <td>{{ key.revokedAt ? 'Відкликано' : 'Діє' }}</td>
                <td class="actions">
                  @if (!key.revokedAt) {
                    <button type="button" class="btn btn-ghost danger" data-action="revoke" [disabled]="busy()" (click)="revoke(key)">Відкликати</button>
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      @if (rows().length === 0) { <p class="muted">Особистих кодів ще немає. Бутстрап-код адміністратора тут не показується.</p> }
    }

    @if (issued(); as key) {
      <vl-modal heading="Код доступу видано" [dismissible]="false" (closed)="dismiss()">
        <p>Передайте цей код користувачу <strong data-role="issued-label">{{ key.label }}</strong> ({{ key.role === 'moderator' ? 'модератор' : 'автор' }}).
          <strong>Він показується лише зараз</strong> і більше його не буде видно.</p>
        <input class="input token" readonly data-autofocus data-role="token" aria-label="Код доступу" [value]="key.token" (focus)="$any($event.target).select()" />
        @if (copyNote(); as note) { <p class="muted" data-role="copy-note">{{ note }}</p> }
        <div class="dialog-actions">
          <button type="button" class="btn btn-secondary" data-action="copy" (click)="copy()"><vl-icon name="copy" size="14" />Скопіювати</button>
          <button type="button" class="btn btn-primary" data-action="close" (click)="dismiss()">Готово</button>
        </div>
      </vl-modal>
    }
  `,
})
export class AccessComponent implements OnInit, OnDestroy {
  private readonly api = inject(AdminApi);
  private readonly session = inject(AdminSession);
  private readonly toast = inject(ToastService);

  protected readonly maxLabel = MAX_LABEL;
  private readonly keys = signal<KeyRow[]>([]);
  protected readonly loaded = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly formError = signal<string | null>(null);
  protected readonly label = signal('');
  protected readonly role = signal<AdminRole>('author');
  /** The one-time code. Held nowhere else, cleared by every way of closing the dialog and on destroy. */
  protected readonly issued = signal<CreatedKey | null>(null);
  protected readonly copyNote = signal('');

  protected readonly rows = computed(() => {
    const mine = this.session.user()?.keyId ?? null;
    return this.keys().map(key => ({
      ...key,
      isMine: mine !== null && key.id === mine,
      created: formatDateTime(key.createdAt),
      lastUsed: key.lastUsedAt ? formatDateTime(key.lastUsedAt) : 'ще не використовувався',
    }));
  });

  ngOnInit(): void {
    void this.refresh();
  }

  ngOnDestroy(): void {
    this.issued.set(null);
  }

  private async refresh(): Promise<void> {
    try {
      this.keys.set(await this.api.keys());
    } catch (err) {
      this.error.set(AdminService.describeError(err));
    } finally {
      this.loaded.set(true);
    }
  }

  protected async issue(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    const label = this.label().trim();
    if (!label) return void this.formError.set('Вкажіть імʼя.');
    this.formError.set(null);
    this.busy.set(true);
    try {
      this.issued.set(await this.api.createKey(label, this.role()));
      this.copyNote.set('');
      this.label.set('');
      await this.refresh();
    } catch (err) {
      this.formError.set(AdminService.describeError(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected dismiss(): void {
    this.issued.set(null);
    this.copyNote.set('');
  }

  protected async copy(): Promise<void> {
    const token = this.issued()?.token;
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      this.copyNote.set('Скопійовано.');
    } catch {
      // The server runs plain HTTP in places, where the Clipboard API is missing: the field is selectable.
      this.copyNote.set('Не вдалося скопіювати автоматично — виділіть код і скопіюйте вручну.');
    }
  }

  protected async revoke(key: { id: number; label: string; isMine: boolean }): Promise<void> {
    if (this.busy()) return;
    const warning = key.isMine ? ' Це код, яким ви увійшли: вас буде виведено з панелі.' : '';
    if (!confirm(`Відкликати код «${key.label}»? Він одразу перестане працювати.${warning}`)) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.revokeKey(key.id);
    } catch (err) {
      this.error.set(AdminService.describeError(err));
      this.busy.set(false);
      return;
    }
    this.busy.set(false);
    if (key.isMine) {
      this.session.signOut();
      return;
    }
    this.toast.show('Код відкликано');
    await this.refresh();
  }
}
