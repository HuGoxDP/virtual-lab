// path: src/app/pages/admin/scenario-files/scenario-files.component.ts

import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AdminRole, ArchiveEntry, ScenarioVersion, VersionAction } from '../../../models/admin.model';
import { AdminScenario } from '../../../models/scenario.model';
import { AdminApi } from '../../../services/admin-api.service';
import { AdminService } from '../../../services/admin.service';
import { formatBytes, formatDate, pluralUk } from '../../../ui/format';
import { IconComponent } from '../../../ui/icon/icon.component';
import { ToastService } from '../../../ui/toast/toast.service';
import { ArchiveUploadComponent, ArchiveSender } from '../archive-upload/archive-upload.component';
import { LARGE_ARCHIVE_BYTES } from '../scenario-rules';

export { LARGE_ARCHIVE_BYTES };
const MAX_LISTED_FILES = 500;

const STATE_TEXT: Readonly<Record<string, string>> = { current: 'Поточна', pending: 'Очікує розгляду', archived: 'Архівна' };
const ARCHIVE_URL = /^\/scenarios\/[0-9a-f]{64}\.zip$/;
const SHA = /^[0-9a-f]{64}$/;

export interface TreeRow {
  name: string;
  dir: boolean;
  /** Files below a directory; 1 for a file. */
  count: number;
}

/** The archive's top level: loose files first, then each directory with the number of files under it. */
export function topLevel(entries: ArchiveEntry[]): TreeRow[] {
  const files: TreeRow[] = [];
  const dirs = new Map<string, number>();
  for (const entry of entries) {
    const slash = entry.path.indexOf('/');
    if (slash === -1) {
      if (entry.dir) dirs.set(entry.path, dirs.get(entry.path) ?? 0);
      else files.push({ name: entry.path, dir: false, count: 1 });
    } else {
      const top = entry.path.slice(0, slash);
      dirs.set(top, (dirs.get(top) ?? 0) + (entry.dir ? 0 : 1));
    }
  }
  return [...files, ...[...dirs].map(([name, count]) => ({ name, dir: true, count }))];
}

/**
 * The Файл tab (prototype 2h): the current archive, a drop zone for a new one, the pending proposal with
 * its actions, the version history and the archive's contents. Which actions exist follows the role; the
 * server decides whether one works and its refusal is shown as sent. Every name, path and note from an
 * archive is untrusted text and only ever interpolated.
 */
@Component({
  selector: 'vl-scenario-files',
  standalone: true,
  imports: [ArchiveUploadComponent, IconComponent, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './scenario-files.component.scss',
  template: `
    @if (error(); as message) {
      <p class="banner banner-error" role="alert">{{ message }}</p>
    }
    @if (versionsError(); as message) {
      <p class="banner banner-error" role="alert">{{ message }}</p>
    }

    @if (pending(); as proposal) {
      <section class="banner-pending" data-role="pending-banner" aria-labelledby="pending-title">
        <div class="pending-text">
          <h2 id="pending-title">Нова версія чекає на розгляд</h2>
          <p>
            Версія {{ proposal.manifestVersion || '—' }} · {{ size(proposal) }} · надіслав(ла)
            {{ proposal.uploadedByLabel || 'невідомий автор' }}, {{ date(proposal) }}.
            Студенти й далі отримують поточну версію.
          </p>
        </div>
        <div class="pending-actions">
          @if (previewable(proposal)) {
            <a class="btn btn-secondary" data-action="preview-pending" [routerLink]="['/play', scenario().id]"
               [queryParams]="{ draft: proposal.sha256, returnTo: returnTo() }">
              <vl-icon name="play" size="14" />Переглянути у viewer
            </a>
          }
          @if (role() === 'moderator') {
            <button type="button" class="btn btn-primary" data-action="accept" [disabled]="busy()" (click)="decide(proposal, 'accept')">Прийняти</button>
            <button type="button" class="btn btn-secondary" data-action="reject" [disabled]="busy()" (click)="decide(proposal, 'reject')">Відхилити</button>
          } @else {
            <button type="button" class="btn btn-secondary" data-action="retract" [disabled]="busy()" (click)="retract(proposal)">Відкликати версію</button>
          }
        </div>
      </section>
    }

    <div class="files-grid">
      <section class="panel" aria-labelledby="current-title">
        <h2 id="current-title">Поточний архів</h2>
        @if (current(); as version) {
          <p class="archive-line" data-role="current-archive">
            <vl-icon name="file-zip" size="20" />
            <span class="archive-text">
              <span class="archive-name">Версія {{ version.manifestVersion || '—' }} · {{ shortHash(version) }}</span>
              <span class="muted">{{ size(version) }} · завантажено {{ date(version) }}{{ version.uploadedByLabel ? ' · ' + version.uploadedByLabel : '' }}</span>
            </span>
            @if (downloadUrl(version); as url) {
              <a class="btn btn-secondary" [href]="url" download data-action="download"><vl-icon name="download-simple" size="14" />Завантажити</a>
            }
          </p>
          @if (isLarge()) {
            <div class="banner banner-warn" data-role="large-archive">
              <strong>Великий архів.</strong> {{ size(version) }} — перше завантаження у студента триватиме довго.
              Стисніть текстури до .basis або .ktx2, або розділіть сцену на кілька.
            </div>
          }
        } @else if (!loading()) {
          <p class="muted">Архів ще не завантажено.</p>
        }

        <h2 class="sub-h">Нова версія</h2>
        <vl-archive-upload [send]="sendArchive" [maxBytes]="maxBytes()" [disabledReason]="uploadBlocked()"
                           (done)="uploaded()" />
      </section>

      <section class="panel" aria-labelledby="contents-title">
        <h2 id="contents-title">Вміст архіву</h2>
        @if (contentsError(); as message) {
          <p class="banner banner-error" role="alert">{{ message }}</p>
        }
        @if (tree().length === 0 && !contentsError()) {
          <p class="muted">{{ current() ? 'Архів порожній.' : 'Немає архіву.' }}</p>
        }
        <ul class="tree" data-role="contents">
          @for (row of tree(); track row.name) {
            <li>
              <vl-icon [name]="row.dir ? 'folder' : 'file'" size="16" />
              <span class="path">{{ row.name }}{{ row.dir ? '/' : '' }}</span>
              @if (row.dir) { <span class="muted">— {{ row.count }} {{ filesWord(row.count) }}</span> }
            </li>
          }
        </ul>
        @if (contents().length > 0) {
          <details class="all-files">
            <summary>Усі записи ({{ contents().length }})</summary>
            <ul>
              @for (entry of listed(); track entry.path) {
                <li><span class="path">{{ entry.path }}</span> <span class="muted">{{ entry.dir ? '' : size(entry) }}</span></li>
              }
            </ul>
            @if (contents().length > maxListed) { <p class="muted">Показано перші {{ maxListed }}.</p> }
          </details>
        }
      </section>
    </div>

    <section class="panel history" aria-labelledby="history-title">
      <h2 id="history-title">Історія версій</h2>
      @if (versions().length === 0 && !loading()) {
        <p class="muted">Версій ще немає.</p>
      } @else {
        <div class="table-wrap">
          <table class="table" data-role="versions">
            <thead><tr><th>Версія</th><th>Архів</th><th>Розмір</th><th>Завантажено</th><th>Стан</th><th><span class="visually-hidden">Дії</span></th></tr></thead>
            <tbody>
              @for (version of versions(); track version.id) {
                <tr [attr.data-state]="version.state">
                  <td>{{ version.manifestVersion || '—' }}</td>
                  <td class="hash">{{ shortHash(version) }}</td>
                  <td>{{ size(version) }}</td>
                  <td>{{ date(version) }}{{ version.uploadedByLabel ? ' · ' + version.uploadedByLabel : '' }}</td>
                  <td><span class="state" [attr.data-state]="version.state">{{ stateText(version) }}</span></td>
                  <td class="row-actions">
                    @if (canRestore(version)) {
                      <button type="button" class="btn btn-ghost" data-action="restore" [disabled]="busy()" (click)="restore(version)">Відкотити</button>
                    }
                    @if (canDelete(version)) {
                      <button type="button" class="btn btn-ghost" data-action="delete" [disabled]="busy()" (click)="remove(version)">Видалити</button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>
  `,
})
export class ScenarioFilesComponent {
  readonly scenario = input.required<AdminScenario>();
  readonly role = input.required<AdminRole>();
  /** The archive or its versions changed: refetch the row. */
  readonly changed = output<void>();

  private readonly api = inject(AdminApi);
  private readonly toast = inject(ToastService);

  protected readonly maxListed = MAX_LISTED_FILES;
  protected readonly versions = signal<ScenarioVersion[]>([]);
  protected readonly contents = signal<ArchiveEntry[]>([]);
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly versionsError = signal<string | null>(null);
  protected readonly contentsError = signal<string | null>(null);
  protected readonly maxBytes = signal<number | null>(null);

  protected readonly current = computed(() => this.versions().find(v => v.state === 'current') ?? null);
  /** The backend keeps at most one pending proposal per scenario. */
  protected readonly pending = computed(() => this.versions().find(v => v.state === 'pending') ?? null);
  protected readonly isLarge = computed(() => (this.current()?.bytes ?? 0) > LARGE_ARCHIVE_BYTES);
  protected readonly tree = computed(() => topLevel(this.contents()));
  protected readonly listed = computed(() => this.contents().slice(0, MAX_LISTED_FILES));
  protected readonly returnTo = computed(() => `/admin/scenarios/${encodeURIComponent(this.scenario().id)}/files`);

  protected readonly uploadBlocked = computed(() =>
    this.scenario().status === 'review'
      ? 'Сценарій на перевірці: відкличте його з перевірки на вкладці «Публікація», щоб завантажити новий архів.'
      : null
  );

  /** The upload closure keeps what the server said about where the file landed, for the toast. */
  private lastState: string | undefined;
  protected readonly sendArchive: ArchiveSender = async (file, onProgress, signal) => {
    const result = await this.api.uploadArchive(this.scenario().id, file, onProgress, signal);
    this.lastState = result.version?.state;
    return result;
  };

  constructor() {
    void this.api.config().then(config => this.maxBytes.set(config.maxArchiveBytes)).catch(() => this.maxBytes.set(null));

    effect(() => {
      void this.scenario().id;
      untracked(() => {
        this.versions.set([]);
        this.contents.set([]);
        this.error.set(null);
        this.versionsError.set(null);
        this.contentsError.set(null);
        this.loading.set(true);
        void this.loadVersions();
      });
    });

    // The contents follow the current version, whichever way it changed (upload, accept, restore).
    effect(() => {
      const versionId = this.current()?.id ?? null;
      void this.scenario().id;
      untracked(() => void this.loadContents(versionId));
    });
  }

  protected filesWord(count: number): string { return pluralUk(count, ['файл', 'файли', 'файлів']); }
  protected size(item: { bytes: number }): string { return formatBytes(item.bytes); }
  protected date(version: ScenarioVersion): string { return formatDate(version.uploadedAt); }
  protected shortHash(version: ScenarioVersion): string { return version.sha256.slice(0, 8); }
  protected stateText(version: ScenarioVersion): string { return STATE_TEXT[version.state] ?? version.state; }
  protected previewable(version: ScenarioVersion): boolean { return SHA.test(version.sha256); }
  protected downloadUrl(version: ScenarioVersion): string | null { return ARCHIVE_URL.test(version.url) ? version.url : null; }

  protected canRestore(version: ScenarioVersion): boolean { return this.role() === 'moderator' && version.state === 'archived'; }
  /** Archived history is a moderator's; a pending proposal is withdrawn from its banner. */
  protected canDelete(version: ScenarioVersion): boolean { return this.role() === 'moderator' && version.state === 'archived'; }

  protected uploaded(): void {
    this.toast.show(this.lastState === 'pending' ? 'Нову версію надіслано модератору' : 'Архів завантажено');
    this.lastState = undefined;
    void this.loadVersions();
    this.changed.emit();
  }

  protected decide(version: ScenarioVersion, decision: 'accept' | 'reject'): Promise<void> {
    return decision === 'accept'
      ? this.act(() => this.api.versionAction(this.scenario().id, version.id, 'accept'), 'Версію прийнято: вона стала поточною',
          'Прийняти нову версію? Студенти одразу почнуть отримувати її.')
      : this.act(() => this.api.versionAction(this.scenario().id, version.id, 'reject'), 'Версію відхилено',
          'Відхилити нову версію? Її буде видалено з історії.');
  }

  protected retract(version: ScenarioVersion): Promise<void> {
    return this.act(() => this.api.deleteVersion(this.scenario().id, version.id), 'Версію відкликано',
      'Відкликати нову версію? Її буде видалено, студенти й далі бачать поточну.');
  }

  protected restore(version: ScenarioVersion): Promise<void> {
    const action: VersionAction = 'restore';
    return this.act(() => this.api.versionAction(this.scenario().id, version.id, action), 'Версію відновлено',
      `Відкотитися до версії ${version.manifestVersion || version.sha256.slice(0, 8)}? Поточна стане архівною.`);
  }

  protected remove(version: ScenarioVersion): Promise<void> {
    return this.act(() => this.api.deleteVersion(this.scenario().id, version.id), 'Версію видалено',
      `Видалити версію ${version.manifestVersion || version.sha256.slice(0, 8)} з історії? Це незворотно.`);
  }

  /** Confirm, run, report, refetch. A refusal is shown as the server sent it and nothing else changes. */
  private async act(run: () => Promise<unknown>, done: string, question: string): Promise<void> {
    if (this.busy() || !confirm(question)) return;
    const id = this.scenario().id;
    this.busy.set(true);
    this.error.set(null);
    try {
      await run();
      this.toast.show(done);
      await this.loadVersions();
      if (id === this.scenario().id) this.changed.emit();
    } catch (err) {
      if (id === this.scenario().id) this.error.set(AdminService.describeError(err));
    } finally {
      this.busy.set(false);
    }
  }

  /** Counts version requests: only the newest may write state, so an older answer never replaces a newer one. */
  private versionsRequest = 0;

  private async loadVersions(): Promise<void> {
    const request = ++this.versionsRequest;
    const id = this.scenario().id;
    const current = () => request === this.versionsRequest && id === this.scenario().id;
    try {
      const list = await this.api.versions(id);
      if (!current()) return; // another scenario, or a newer reload, took over while this was in flight
      this.versions.set(list);
      this.versionsError.set(null);
    } catch (err) {
      if (!current()) return;
      this.versionsError.set(AdminService.describeError(err));
    } finally {
      if (current()) this.loading.set(false);
    }
  }

  private async loadContents(versionId: number | null): Promise<void> {
    const id = this.scenario().id;
    this.contents.set([]);
    this.contentsError.set(null);
    if (versionId === null) return;
    try {
      const list = await this.api.versionContents(id, versionId);
      if (id !== this.scenario().id || versionId !== this.current()?.id) return;
      this.contents.set(list);
    } catch (err) {
      if (id !== this.scenario().id || versionId !== this.current()?.id) return;
      this.contentsError.set(AdminService.describeError(err));
    }
  }
}
