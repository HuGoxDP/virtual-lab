// path: src/app/pages/admin/legacy/admin.component.ts

import { Component, ChangeDetectionStrategy, OnInit, inject, signal } from '@angular/core';
import { RouterModule } from '@angular/router';

import { AdminScenario, ScenarioFeature } from '../../../models/scenario.model';
import { AdminService, ScenarioDraft } from '../../../services/admin.service';
import { ICON_NAMES } from '../../../ui/icon/icon.component';

/** The server's own cap on "Що всередині" (backend/catalog-input.js); it still answers 400 above it. */
export const MAX_FEATURES = 6;

/** Icon given to a freshly added entry. */
const DEFAULT_FEATURE_ICON = 'cube';

const EMPTY_DRAFT: ScenarioDraft = {
  id: '',
  title: '',
  description: '',
  fullDescription: '',
  category: '',
  categoryLabel: '',
  imageUrl: '',
  version: '1.0.0',
  author: '',
  features: [],
};

@Component({
  selector: 'app-admin',
  standalone: true,
  imports: [RouterModule],
  templateUrl: './admin.component.html',
  styleUrls: ['./admin.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminComponent implements OnInit {

  private readonly admin = inject(AdminService);

  readonly isAuthenticated = this.admin.isAuthenticated;

  readonly tokenInput = signal('');
  readonly scenarios = signal<AdminScenario[]>([]);
  readonly isLoading = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly notice = signal<string | null>(null);

  readonly iconNames = ICON_NAMES;
  readonly maxFeatures = MAX_FEATURES;

  /** Draft being edited; `null` when the form is closed. */
  readonly draft = signal<ScenarioDraft | null>(null);
  /** Set when editing an existing row — its id is then immutable. */
  readonly editingId = signal<string | null>(null);

  /** Upload progress per scenario id, 0–100. */
  readonly uploadProgress = signal<Record<string, number>>({});
  /** Ids currently blocked by a request. */
  readonly busyIds = signal<string[]>([]);

  ngOnInit(): void {
    if (this.isAuthenticated()) void this.reload();
  }

  // ==================== AUTH ====================

  submitToken(): void {
    const token = this.tokenInput().trim();
    if (!token) return;
    this.admin.setToken(token);
    this.tokenInput.set('');
    void this.reload();
  }

  signOut(): void {
    this.admin.clearToken();
    this.scenarios.set([]);
    this.errorMessage.set(null);
    this.notice.set(null);
  }

  // ==================== DATA ====================

  async reload(): Promise<void> {
    this.isLoading.set(true);
    this.errorMessage.set(null);

    try {
      this.scenarios.set(await this.admin.listScenarios());
    } catch (err) {
      this.errorMessage.set(AdminService.describeError(err));
      this.scenarios.set([]);
      // A rejected token is worth clearing so the login form comes back.
      if (this.isAuthError(err)) this.admin.clearToken();
    } finally {
      this.isLoading.set(false);
    }
  }

  private isAuthError(err: unknown): boolean {
    const status = (err as { status?: number } | null)?.status;
    return status === 401 || status === 403;
  }

  private isBusy(id: string): boolean {
    return this.busyIds().includes(id);
  }

  busy(id: string): boolean {
    return this.isBusy(id);
  }

  private async withBusy(id: string, action: () => Promise<void>): Promise<void> {
    if (this.isBusy(id)) return;
    this.busyIds.update(ids => [...ids, id]);
    this.errorMessage.set(null);

    try {
      await action();
    } catch (err) {
      this.errorMessage.set(AdminService.describeError(err));
    } finally {
      this.busyIds.update(ids => ids.filter(current => current !== id));
    }
  }

  // ==================== FORM ====================

  startCreate(): void {
    this.editingId.set(null);
    this.draft.set({ ...EMPTY_DRAFT, features: [] });
    this.notice.set(null);
  }

  startEdit(scenario: AdminScenario): void {
    this.editingId.set(scenario.id);
    this.draft.set({
      id: scenario.id,
      title: scenario.title ?? '',
      description: scenario.description ?? '',
      fullDescription: scenario.fullDescription ?? '',
      category: scenario.category ?? '',
      categoryLabel: scenario.categoryLabel ?? '',
      imageUrl: scenario.imageUrl ?? '',
      version: scenario.version ?? '',
      author: scenario.author ?? '',
      features: (scenario.features ?? []).map(feature => ({ ...feature })),
    });
    this.notice.set(null);
  }

  cancelEdit(): void {
    this.draft.set(null);
    this.editingId.set(null);
  }

  updateDraft(field: keyof ScenarioDraft, event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
    this.draft.update(current => (current ? { ...current, [field]: value } : current));
  }

  // ---- "Що всередині" ----

  addFeature(): void {
    this.draft.update(current =>
      current && current.features.length < MAX_FEATURES
        ? { ...current, features: [...current.features, { icon: DEFAULT_FEATURE_ICON, title: '', subtitle: '' }] }
        : current
    );
  }

  removeFeature(index: number): void {
    this.draft.update(current =>
      current ? { ...current, features: current.features.filter((_, i) => i !== index) } : current
    );
  }

  updateFeature(index: number, field: keyof ScenarioFeature, event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLSelectElement).value;
    this.draft.update(current =>
      current
        ? { ...current, features: current.features.map((f, i) => (i === index ? { ...f, [field]: value } : f)) }
        : current
    );
  }

  /** An empty subtitle is "no subtitle": the server stores absence, not an empty string. */
  private static cleanFeatures(features: ScenarioFeature[]): ScenarioFeature[] {
    return features.map(({ icon, title, subtitle }) => (subtitle ? { icon, title, subtitle } : { icon, title }));
  }

  async saveDraft(): Promise<void> {
    const current = this.draft();
    if (!current) return;
    const draft = { ...current, features: AdminComponent.cleanFeatures(current.features) };

    if (!draft.id || !draft.title || !draft.category || !draft.categoryLabel) {
      this.errorMessage.set('Обов\'язкові поля: id, назва, категорія, підпис категорії.');
      return;
    }

    const editingId = this.editingId();

    await this.withBusy(editingId ?? draft.id, async () => {
      if (editingId) {
        const { id: _unused, ...patch } = draft;
        await this.admin.updateScenario(editingId, patch);
        this.notice.set(`Сценарій "${editingId}" оновлено.`);
      } else {
        await this.admin.createScenario(draft);
        this.notice.set(`Сценарій "${draft.id}" створено. Тепер завантажте архів.`);
      }
      this.cancelEdit();
      await this.reload();
    });
  }

  // ==================== ROW ACTIONS ====================

  async togglePublished(scenario: AdminScenario): Promise<void> {
    await this.withBusy(scenario.id, async () => {
      await this.admin.updateScenario(scenario.id, { isPublished: !scenario.isPublished });
      await this.reload();
    });
  }

  async remove(scenario: AdminScenario): Promise<void> {
    const confirmed = confirm(
      `Видалити сценарій "${scenario.title || scenario.id}"?\n\n` +
      'Запис у каталозі буде видалено. Файл архіву залишиться у сховищі.'
    );
    if (!confirmed) return;

    await this.withBusy(scenario.id, async () => {
      await this.admin.deleteScenario(scenario.id);
      this.notice.set(`Сценарій "${scenario.id}" видалено.`);
      await this.reload();
    });
  }

  async onArchiveSelected(scenario: AdminScenario, event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // allow re-picking the same file after a failure
    if (!file) return;

    this.notice.set(null);

    await this.withBusy(scenario.id, async () => {
      this.setProgress(scenario.id, 0);
      try {
        const result = await this.admin.uploadArchive(scenario.id, file, percent =>
          this.setProgress(scenario.id, percent)
        );
        this.reportArchiveResult(scenario.id, result.sha256, result.bytes, result.deduplicated, result.warnings);
        await this.reload();
      } finally {
        this.clearProgress(scenario.id);
      }
    });
  }

  private reportArchiveResult(
    id: string,
    sha256: string,
    bytes: number,
    deduplicated: boolean,
    warnings: string[]
  ): void {
    const parts = [
      `Архів для "${id}" збережено.`,
      `sha256: ${sha256}`,
      `розмір: ${this.formatBytes(bytes)}`,
    ];
    if (deduplicated) parts.push('(такий вміст уже був у сховищі — дедуплікація)');
    if (warnings?.length) parts.push(`⚠ ${warnings.join('; ')}`);
    this.notice.set(parts.join('\n'));
  }

  // ==================== HELPERS ====================

  private setProgress(id: string, percent: number): void {
    this.uploadProgress.update(map => ({ ...map, [id]: percent }));
  }

  private clearProgress(id: string): void {
    this.uploadProgress.update(map => {
      const { [id]: _removed, ...rest } = map;
      return rest;
    });
  }

  progressOf(id: string): number | null {
    return this.uploadProgress()[id] ?? null;
  }

  formatBytes(bytes: number | null): string {
    if (!bytes) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  shortHash(hash: string | null): string {
    return hash ? hash.slice(0, 12) : '—';
  }

  /**
   * Shortens an engine build string for the table.
   *
   * Local packs are `0.1.0-local.<epoch ms>`, where only the timestamp differs
   * between builds — so the tail is the part worth showing. The full string
   * stays in the cell's title attribute.
   */
  shortEngineBuild(engineVersion: string): string {
    const local = /^(.*)-local\.(\d+)$/.exec(engineVersion);
    if (!local) return engineVersion;

    const [, version, epochMs] = local;
    const built = new Date(Number(epochMs));

    return Number.isNaN(built.getTime())
      ? engineVersion
      : `${version}-local ${built.toISOString().slice(0, 10)}`;
  }

  onTokenInput(event: Event): void {
    this.tokenInput.set((event.target as HTMLInputElement).value);
  }
}
