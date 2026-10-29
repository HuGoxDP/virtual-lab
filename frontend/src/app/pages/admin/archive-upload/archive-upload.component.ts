// path: src/app/pages/admin/archive-upload/archive-upload.component.ts

import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, output, signal } from '@angular/core';

import { formatBytes } from '../../../ui/format';
import { IconComponent } from '../../../ui/icon/icon.component';
import { checkArchiveFile, describeUploadError } from './archive-upload';

/** Sends one file; the caller owns the route, the component owns everything around it. */
export type ArchiveSender = (file: File, onProgress: (percent: number) => void, signal: AbortSignal) => Promise<unknown>;

/**
 * The drop zone of the Файл tab and of the wizard's first step (prototype 2h, 2l): pick or drop one ZIP,
 * refuse it early when it cannot be right (not a ZIP, empty, over the platform cap), then show progress with
 * a cancel button while `send` runs. Cancelling aborts the request, and so does leaving the page, so nothing
 * is left half-created. `done` fires after a successful `send`; a failure is shown here, in words.
 */
@Component({
  selector: 'vl-archive-upload',
  standalone: true,
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './archive-upload.component.scss',
  template: `
    @if (error(); as message) {
      <p class="banner banner-error" role="alert">{{ message }}</p>
    }
    @if (notice(); as message) {
      <p class="banner banner-warn" role="status">{{ message }}</p>
    }

    @if (uploading()) {
      <div class="progress-card" role="status">
        <div class="row">
          <span class="name">{{ fileName() }}</span>
          <span class="pct">{{ percent() }}%</span>
        </div>
        <div class="bar" role="progressbar" aria-label="Завантаження на сервер" aria-valuemin="0" aria-valuemax="100"
             [attr.aria-valuenow]="percent()"><div class="fill" [style.width.%]="percent()"></div></div>
        <div class="row">
          <span class="muted">{{ progressText() }}</span>
          <button type="button" class="btn btn-secondary" data-action="cancel-upload" (click)="cancel()">Скасувати</button>
        </div>
      </div>
    } @else {
      <label class="dropzone" [class.over]="dragging()" [class.disabled]="!!disabledReason()"
             (dragenter)="onDrag($event, true)" (dragover)="onDrag($event, true)" (dragleave)="onDrag($event, false)"
             (drop)="onDrop($event)">
        <input class="visually-hidden" type="file" accept=".zip,application/zip" data-role="archive-input"
               [disabled]="!!disabledReason()" (change)="onPick($event)" />
        <vl-icon name="upload-simple" size="28" />
        <span class="title">{{ title() }}</span>
        <span class="sub">або виберіть файл · до {{ limit() }} · у корені архіву: manifest.json, точка входу, assets/</span>
      </label>
      @if (disabledReason(); as reason) {
        <p class="muted reason">{{ reason }}</p>
      }
    }
  `,
})
export class ArchiveUploadComponent {
  readonly send = input.required<ArchiveSender>();
  /** The platform cap in bytes (`GET /api/config`); null while unknown, when only the server enforces it. */
  readonly maxBytes = input<number | null>(null);
  /** Why nothing can be uploaded now (the scenario is in review); the zone is drawn but inert. */
  readonly disabledReason = input<string | null>(null);
  readonly title = input('Перетягніть ZIP-архів сюди');
  /** The upload went through. */
  readonly done = output<void>();

  protected readonly uploading = signal(false);
  protected readonly dragging = signal(false);
  protected readonly percent = signal(0);
  protected readonly fileName = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  private readonly fileBytes = signal(0);

  protected readonly limit = computed(() => {
    const max = this.maxBytes();
    return max === null ? 'ліміту сервера' : formatBytes(max);
  });
  protected readonly progressText = computed(() =>
    this.percent() >= 100
      ? 'Сервер перевіряє архів…'
      : `Завантаження на сервер — ${formatBytes(Math.round((this.fileBytes() * this.percent()) / 100))} з ${formatBytes(this.fileBytes())}`
  );

  private controller: AbortController | null = null;

  constructor() {
    // Leaving the page mid-upload aborts it, so no request outlives the screen that started it.
    inject(DestroyRef).onDestroy(() => this.controller?.abort());
  }

  protected onDrag(event: DragEvent, over: boolean): void {
    event.preventDefault(); // without this the browser opens the dropped file instead of handing it over
    if (!this.disabledReason()) this.dragging.set(over);
  }

  protected onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
    if (this.disabledReason()) return;
    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;
    if (files.length > 1) {
      this.error.set('Перетягніть один ZIP-архів.');
      return;
    }
    void this.start(files[0]);
  }

  protected onPick(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // the same file can be chosen again after a refusal or a cancel
    if (file) void this.start(file);
  }

  protected cancel(): void {
    this.controller?.abort();
  }

  private async start(file: File): Promise<void> {
    if (this.uploading() || this.disabledReason()) return;
    this.error.set(null);
    this.notice.set(null);

    const refusal = checkArchiveFile(file, this.maxBytes());
    if (refusal) {
      this.error.set(refusal);
      return;
    }

    const controller = new AbortController();
    this.controller = controller;
    this.fileName.set(file.name);
    this.fileBytes.set(file.size);
    this.percent.set(0);
    this.uploading.set(true);
    try {
      await this.send()(file, percent => this.percent.set(percent), controller.signal);
      this.done.emit();
    } catch (err) {
      const message = describeUploadError(err);
      if (message) this.error.set(message);
      else this.notice.set('Завантаження скасовано. Нічого не збережено.');
    } finally {
      this.uploading.set(false);
      this.controller = null;
    }
  }
}
