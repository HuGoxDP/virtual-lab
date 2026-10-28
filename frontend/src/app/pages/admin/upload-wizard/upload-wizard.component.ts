// path: src/app/pages/admin/upload-wizard/upload-wizard.component.ts

import { ChangeDetectionStrategy, Component, HostListener, computed, inject, signal, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { ArchiveManifestSummary, ScenarioVersion } from '../../../models/admin.model';
import { AdminScenario } from '../../../models/scenario.model';
import { AdminApi } from '../../../services/admin-api.service';
import { AdminSession } from '../../../services/admin-session.service';
import { AdminService } from '../../../services/admin.service';
import { formatBytes } from '../../../ui/format';
import { IconComponent } from '../../../ui/icon/icon.component';
import { StatusPillComponent } from '../../../ui/status-pill/status-pill.component';
import { ToastService } from '../../../ui/toast/toast.service';
import { HasUnsavedChanges } from '../admin-guards';
import { ArchiveSender, ArchiveUploadComponent } from '../archive-upload/archive-upload.component';
import { CheckListComponent } from '../check-list/check-list.component';
import { isReady, readiness } from '../scenario-rules';
import { ScenarioMetaFormComponent } from '../scenario-meta-form/scenario-meta-form.component';

export const WIZARD_STEPS = [
  { n: 1, label: 'Файл' },
  { n: 2, label: 'Метадані' },
  { n: 3, label: 'Перевірка' },
  { n: 4, label: 'Публікація' },
] as const;

const UNSAVED_FIRST = 'Спершу збережіть зміни на кроці «Метадані» або скасуйте їх.';

/**
 * `/admin/upload` (prototype 2l): Файл → Метадані → Перевірка → Публікація. The first step posts the ZIP to
 * `from-archive`, which creates a **draft** from the archive's own manifest; from then on the draft exists
 * on the server whatever the user does next, so leaving the wizard keeps it (it is in the list). The
 * Метадані step is the same form as the editor's. Every manifest field is untrusted text, only interpolated.
 */
@Component({
  selector: 'vl-upload-wizard',
  standalone: true,
  imports: [ArchiveUploadComponent, CheckListComponent, IconComponent, RouterLink, ScenarioMetaFormComponent, StatusPillComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './upload-wizard.component.scss',
  template: `
    <a class="back" routerLink="/admin/scenarios"><vl-icon name="arrow-left" size="14" />Сценарії</a>

    <header class="wizard-head">
      <h1>{{ draft() ? (draft()!.title || draft()!.id) : 'Новий сценарій' }}</h1>
      <vl-status-pill [status]="draft()?.status ?? 'draft'" />
    </header>

    <ol class="steps" aria-label="Кроки">
      @for (item of steps; track item.n) {
        <li>
          <button type="button" class="step" [class.on]="step() === item.n" [class.done]="draft() && item.n < step()"
                  [attr.aria-current]="step() === item.n ? 'step' : null" [attr.data-step]="item.n"
                  [disabled]="item.n > 1 && !draft()" (click)="go(item.n)">
            <span class="num">{{ item.n }}</span>{{ item.label }}
          </button>
        </li>
      }
    </ol>

    @if (error(); as message) {
      <p class="banner banner-error" role="alert">{{ message }}</p>
    }

    <!-- Step 1 -->
    <div class="step-panel" [hidden]="step() !== 1">
      <section class="panel">
        <h2>Архів сценарію</h2>
        @if (draft(); as current) {
          <p class="archive-line" data-role="uploaded">
            <vl-icon name="file-zip" size="20" />
            <span><strong>Готово.</strong> {{ sizeText() }} завантажено на сервер — чернетку «{{ current.id }}» створено.</span>
          </p>
        }
        <vl-archive-upload [send]="send" [maxBytes]="maxBytes()" (done)="uploaded()"
                           [title]="draft() ? 'Перетягніть інший ZIP, щоб замінити' : 'Перетягніть ZIP-архів сюди'" />
      </section>

      @if (draft()) {
        <section class="panel" aria-labelledby="manifest-title">
          <h2 id="manifest-title">Прочитано з манифесту</h2>
          <dl class="facts" data-role="manifest">
            @for (fact of facts(); track fact.label) {
              <div><dt>{{ fact.label }}</dt><dd>{{ fact.value }}</dd></div>
            }
          </dl>
          @for (warning of warnings(); track $index) {
            <p class="banner banner-warn">{{ warning }}</p>
          }
        </section>
      }
    </div>

    <!-- Step 2: hidden, not removed, so edits survive a trip to another step. -->
    @if (draft(); as current) {
      <div class="step-panel" [hidden]="step() !== 2">
        <vl-scenario-meta-form [scenario]="current" [role]="role()" (saved)="refreshDraft()" />
      </div>
    }

    <!-- Step 3 -->
    @if (step() === 3 && draft()) {
      <section class="panel step-panel">
        <h2>Автоперевірка архіву</h2>
        @if (version()?.checks; as checks) {
          <vl-check-list [checks]="checks" />
        } @else {
          <p class="muted" data-role="no-checks">Збереженої перевірки для цього архіву немає. Її можна запустити на вкладці «Перевірка» після збереження.</p>
        }
      </section>
    }

    <!-- Step 4 -->
    @if (step() === 4 && draft(); as current) {
      <section class="panel step-panel">
        <h2>Публікація</h2>
        <ul class="ready" data-role="readiness">
          @for (item of readinessItems(); track item.key) {
            <li [class]="item.level"><vl-icon [name]="item.level === 'ok' ? 'check-circle' : 'warning'" size="16" />{{ item.label }}</li>
          }
        </ul>
        <p class="muted">
          Після надсилання архів пройде автоперевірку, а сценарій потрапить у чергу модерації. У каталозі він зʼявиться тільки після публікації.
        </p>
        <div class="actions">
          <button type="button" class="btn btn-secondary" data-action="save-draft" [disabled]="busy()" (click)="saveDraft()">Зберегти чернетку</button>
          <button type="button" class="btn btn-primary" data-action="submit" [disabled]="busy()" (click)="finish('submit')">Надіслати на модерацію</button>
          @if (role() === 'moderator') {
            <button type="button" class="btn btn-secondary" data-action="approve" [disabled]="busy()" (click)="finish('approve')">Опублікувати</button>
          }
        </div>
        @if (current.id && !ready()) {
          <p class="banner banner-warn">Не все готово: заповніть це на кроці «Метадані». Надіслати можна й так.</p>
        }
      </section>
    }

    <div class="nav-row">
      <button type="button" class="btn btn-secondary" data-action="back" [hidden]="step() === 1" (click)="go(step() - 1)">Назад</button>
      <button type="button" class="btn btn-primary" data-action="next" [hidden]="step() === 4" [disabled]="!draft()" (click)="go(step() + 1)">Далі</button>
    </div>
  `,
})
export class UploadWizardComponent implements HasUnsavedChanges {
  private readonly api = inject(AdminApi);
  private readonly session = inject(AdminSession);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);

  protected readonly steps = WIZARD_STEPS;
  protected readonly step = signal<number>(1);
  protected readonly draft = signal<AdminScenario | null>(null);
  protected readonly version = signal<ScenarioVersion | null>(null);
  /** Only the first upload reports the entry point and the file count; a replacement shows the version's own fields. */
  protected readonly manifest = signal<ArchiveManifestSummary | null>(null);
  protected readonly warnings = signal<string[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly maxBytes = signal<number | null>(null);

  private readonly form = viewChild(ScenarioMetaFormComponent);
  private replaced = false;

  protected readonly role = computed(() => this.session.role() ?? 'author');
  protected readonly sizeText = computed(() => formatBytes(this.version()?.bytes ?? this.draft()?.archiveBytes));

  protected readonly facts = computed(() => {
    const manifest = this.manifest();
    const version = this.version();
    const rows: Array<{ label: string; value: string }> = [];
    if (manifest?.name) rows.push({ label: 'Назва в манифесті', value: manifest.name });
    const id = manifest?.id ?? version?.manifestId;
    if (id) rows.push({ label: 'id у манифесті', value: id });
    const ver = manifest?.version ?? version?.manifestVersion;
    if (ver) rows.push({ label: 'Версія', value: ver });
    if (manifest?.entryPoint) rows.push({ label: 'Точка входу', value: manifest.entryPoint });
    if (manifest) rows.push({ label: 'Ресурсів', value: String(manifest.resourceCount) });
    const engine = manifest?.engineVersion ?? version?.engineVersion;
    rows.push({ label: 'Версія рушія', value: engine || 'не вказано' });
    return rows;
  });

  protected readonly readinessItems = computed(() => {
    const d = this.draft();
    return d ? readiness({ description: d.description, imageUrl: d.imageUrl, currentVersion: d.currentVersion, archiveSha256: d.archiveSha256 }) : [];
  });
  protected readonly ready = computed(() => isReady(this.readinessItems()));

  /** First upload creates the draft; once it exists the same zone replaces its archive. */
  protected readonly send: ArchiveSender = async (file, onProgress, signal) => {
    const current = this.draft();
    if (current) {
      this.replaced = true;
      return this.api.uploadArchive(current.id, file, onProgress, signal);
    }
    this.replaced = false;
    const result = await this.api.fromArchive(file, onProgress, signal);
    this.draft.set(result.scenario);
    this.version.set(result.version);
    this.manifest.set(result.manifest);
    this.warnings.set(result.warnings ?? []);
    return result;
  };

  constructor() {
    void this.api.config().then(config => this.maxBytes.set(config.maxArchiveBytes)).catch(() => this.maxBytes.set(null));
  }

  hasUnsavedChanges(): boolean {
    return this.form()?.dirty() ?? false;
  }

  @HostListener('window:beforeunload', ['$event'])
  protected onBeforeUnload(event: BeforeUnloadEvent): void {
    if (this.hasUnsavedChanges()) event.preventDefault();
  }

  protected go(n: number): void {
    if (n < 1 || n > 4 || (n > 1 && !this.draft())) return;
    this.step.set(n);
  }

  protected async uploaded(): Promise<void> {
    this.error.set(null);
    if (!this.replaced) {
      this.toast.show('Чернетку створено');
      return;
    }
    this.manifest.set(null);
    this.warnings.set([]);
    await this.refreshDraft();
    this.toast.show('Архів замінено');
  }

  /** Refetches the draft row and its current version (after a save, a preview change or a replacement). */
  protected async refreshDraft(): Promise<void> {
    const id = this.draft()?.id;
    if (!id) return;
    try {
      const [row, versions] = await Promise.all([this.api.scenario(id), this.api.versions(id)]);
      if (this.draft()?.id !== id) return;
      if (row) this.draft.set(row);
      this.version.set(versions.find(v => v.state === 'current') ?? null);
    } catch (err) {
      this.error.set(AdminService.describeError(err));
    }
  }

  protected async saveDraft(): Promise<void> {
    if (this.hasUnsavedChanges()) {
      this.error.set(UNSAVED_FIRST);
      return;
    }
    this.toast.show('Чернетку збережено');
    await this.router.navigateByUrl('/admin/scenarios');
  }

  /** Submits for moderation (anyone) or publishes (moderators), then opens the scenario on its Публікація tab. */
  protected async finish(action: 'submit' | 'approve'): Promise<void> {
    const current = this.draft();
    if (!current || this.busy()) return;
    if (this.hasUnsavedChanges()) {
      this.error.set(UNSAVED_FIRST);
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.transition(current.id, action);
      this.toast.show(action === 'submit' ? 'Надіслано на модерацію' : 'Опубліковано в каталозі');
      await this.router.navigate(['/admin/scenarios', current.id, 'publish']);
    } catch (err) {
      this.error.set(AdminService.describeError(err));
    } finally {
      this.busy.set(false);
    }
  }
}
