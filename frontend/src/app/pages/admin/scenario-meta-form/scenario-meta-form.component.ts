// path: src/app/pages/admin/scenario-meta-form/scenario-meta-form.component.ts

import { ChangeDetectionStrategy, Component, OnInit, computed, effect, inject, input, output, signal, untracked } from '@angular/core';

import { AdminCategory, AdminRole, PlatformConfig, ScenarioPatch } from '../../../models/admin.model';
import { AdminScenario, ScenarioFeature } from '../../../models/scenario.model';
import { AdminApi } from '../../../services/admin-api.service';
import { AdminService } from '../../../services/admin.service';
import { formatBytes, formatDate } from '../../../ui/format';
import { IconComponent } from '../../../ui/icon/icon.component';
import { IconPickerComponent } from '../../../ui/icon-picker/icon-picker.component';
import { ScenarioCardComponent, ScenarioCardData } from '../../../ui/scenario-card/scenario-card.component';
import { ToastService } from '../../../ui/toast/toast.service';
import { readiness } from '../scenario-rules';

/** The server's own cap on "Що всередині" (`backend/catalog-input.js`); it still answers 400 above it. */
export const MAX_FEATURES = 6;
/** The card's description budget (the counter on the short description). */
export const MAX_DESCRIPTION = 160;
const MAX_FEATURE_TITLE = 60;
const MAX_FEATURE_SUBTITLE = 90;
const DEFAULT_FEATURE_ICON = 'cube';

/** The editable fields of the tab; `edits` overrides them one by one over the scenario's own values. */
interface Fields {
  title: string;
  description: string;
  fullDescription: string;
  category: string;
  version: string;
  author: string;
  features: ScenarioFeature[];
}
type TextField = Exclude<keyof Fields, 'features'>;

/** An empty subtitle is "no subtitle": the server stores absence, not an empty string. */
const cleanFeatures = (features: ScenarioFeature[]): ScenarioFeature[] =>
  features.map(({ icon, title, subtitle }) => (subtitle ? { icon, title: title.trim(), subtitle } : { icon, title: title.trim() }));

const fieldsOf = (scenario: AdminScenario): Fields => ({
  title: scenario.title ?? '',
  description: scenario.description ?? '',
  fullDescription: scenario.fullDescription ?? '',
  category: scenario.category ?? '',
  version: scenario.version ?? '',
  author: scenario.author ?? '',
  features: (scenario.features ?? []).map(feature => ({ ...feature })),
});

const same = (a: Fields[keyof Fields], b: Fields[keyof Fields]): boolean =>
  typeof a === 'string' || typeof b === 'string'
    ? a === b
    : JSON.stringify(cleanFeatures(a)) === JSON.stringify(cleanFeatures(b));

/**
 * The Метадані form (prototype 2g): the fields a student sees, "Що всередині", the cover image, the live
 * catalog card and the readiness list. It is reused by the upload wizard, so it asks only for the row and
 * the role and tells its parent (`saved`) when the server changed something, so the parent can refetch.
 *
 * Edits are kept apart from the row (`edits` over `scenario`): a refetch after a preview upload does not
 * wipe what the user typed, and `dirty` says whether anything differs from what the server has.
 * `author` is a moderator's field; an author sees it read-only and never sends it.
 */
@Component({
  selector: 'vl-scenario-meta-form',
  standalone: true,
  imports: [IconComponent, IconPickerComponent, ScenarioCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './scenario-meta-form.component.scss',
  template: `
    <div class="meta-grid">
      <form class="panel form" (submit)="$event.preventDefault(); save()" novalidate>
        <h2>Основне</h2>

        @if (error(); as message) {
          <p class="banner banner-error" role="alert">{{ message }}</p>
        }

        <div class="fields">
          <div class="field span-2">
            <label for="meta-title">Назва <em>*</em></label>
            <input id="meta-title" class="input" [value]="value().title" (input)="set('title', $event)" />
          </div>
          <div class="field">
            <label for="meta-id">ID у каталозі</label>
            <input id="meta-id" class="input" [value]="scenario().id" readonly />
          </div>
          <div class="field">
            <label for="meta-category">Категорія</label>
            <select id="meta-category" class="input" (change)="set('category', $event)">
              @for (option of categoryOptions(); track option.slug) {
                <option [value]="option.slug" [selected]="option.slug === value().category">{{ option.label }}</option>
              }
            </select>
          </div>
          <div class="field">
            <label for="meta-version">Версія</label>
            <input id="meta-version" class="input" [value]="value().version" (input)="set('version', $event)" />
          </div>
          <div class="field">
            <label for="meta-author">Автор</label>
            <input id="meta-author" class="input" [value]="value().author" [readOnly]="role() !== 'moderator'"
                   (input)="set('author', $event)" />
            @if (role() !== 'moderator') {
              <p class="hint">Імʼя автора змінює модератор.</p>
            }
          </div>
          <div class="field">
            <label for="meta-updated">Дата оновлення</label>
            <input id="meta-updated" class="input" [value]="updated()" readonly />
          </div>

          <div class="field span-2">
            <label for="meta-description">
              Короткий опис — показується на картці каталогу
              <span class="counter" [class.over]="descriptionLength() > maxDescription">{{ descriptionLength() }} / {{ maxDescription }}</span>
            </label>
            <textarea id="meta-description" class="input short" rows="2" [value]="value().description"
                      (input)="set('description', $event)"></textarea>
          </div>
          <div class="field span-2">
            <label for="meta-full">Повний опис — показується на сторінці сценарію</label>
            <textarea id="meta-full" class="input" rows="5" [value]="value().fullDescription"
                      (input)="set('fullDescription', $event)"></textarea>
          </div>
        </div>

        <fieldset class="features">
          <legend>Що всередині ({{ value().features.length }}/{{ maxFeatures }})</legend>
          @for (feature of value().features; track $index) {
            <div class="feature-row">
              <vl-icon-picker [value]="feature.icon" [label]="'Іконка пункту ' + ($index + 1)"
                              (valueChange)="setFeature($index, 'icon', $event)" />
              <input class="input feature-title" [maxLength]="maxFeatureTitle" placeholder="Заголовок"
                     [attr.aria-label]="'Заголовок пункту ' + ($index + 1)" [value]="feature.title"
                     (input)="setFeature($index, 'title', $any($event.target).value)" />
              <input class="input feature-subtitle" [maxLength]="maxFeatureSubtitle" placeholder="Підпис"
                     [attr.aria-label]="'Підпис пункту ' + ($index + 1)" [value]="feature.subtitle ?? ''"
                     (input)="setFeature($index, 'subtitle', $any($event.target).value)" />
              <button type="button" class="btn btn-icon" [attr.aria-label]="'Видалити пункт ' + ($index + 1)"
                      (click)="removeFeature($index)"><vl-icon name="x" size="16" /></button>
            </div>
          }
          <button type="button" class="btn btn-secondary add-feature" [disabled]="value().features.length >= maxFeatures"
                  (click)="addFeature()"><vl-icon name="plus" size="14" />Додати пункт</button>
        </fieldset>

        <div class="cover">
          <h2>Превʼю</h2>
          @if (scenario().imageUrl) {
            <img class="cover-image" [src]="scenario().imageUrl" alt="Поточне превʼю" />
          }
          <div class="cover-actions">
            <label class="btn btn-secondary upload-preview" [class.disabled]="previewBusy()">
              <vl-icon name="upload-simple" size="16" />Завантажити зображення
              <input type="file" class="visually-hidden" accept="image/png,image/jpeg" [disabled]="previewBusy()"
                     (change)="onPreview($event)" />
            </label>
            @if (scenario().imageUrl) {
              <button type="button" class="btn btn-ghost" [disabled]="previewBusy()" (click)="removePreview()">Прибрати</button>
            }
          </div>
          <p class="hint">{{ previewHint() }}</p>
          @if (previewWarnings().length) {
            <ul class="banner banner-warn preview-warnings">
              @for (warning of previewWarnings(); track $index) { <li>{{ warning }}</li> }
            </ul>
          }
        </div>

        @if (problems().length) {
          <ul class="problems" role="alert">
            @for (problem of problems(); track problem) { <li>{{ problem }}</li> }
          </ul>
        }

        <div class="form-actions">
          <button type="submit" class="btn btn-primary save" [disabled]="!canSave()">Зберегти</button>
          @if (dirty()) {
            <button type="button" class="btn btn-ghost discard" [disabled]="busy()" (click)="discard()">Скасувати зміни</button>
            <span class="unsaved">Є незбережені зміни</span>
          }
        </div>
      </form>

      <aside class="side">
        <section class="panel">
          <h2>Як це побачить студент</h2>
          <!-- A preview, not a control: inert keeps its buttons out of reach and the tab order. -->
          <div class="live-card" inert><vl-scenario-card [scenario]="card()" /></div>
        </section>

        <section class="panel readiness">
          <h2>Готовність до публікації</h2>
          <ul>
            @for (item of readinessItems(); track item.key) {
              <li [class]="'level-' + item.level">
                <vl-icon [name]="item.level === 'ok' ? 'check-circle' : item.level === 'warn' ? 'warning' : 'warning-circle'" size="16" />
                <span>{{ item.label }}</span>
              </li>
            }
          </ul>
        </section>
      </aside>
    </div>
  `,
})
export class ScenarioMetaFormComponent implements OnInit {
  readonly scenario = input.required<AdminScenario>();
  readonly role = input.required<AdminRole>();
  /** The server changed something (fields saved, preview set or removed): refetch the row. */
  readonly saved = output<void>();

  private readonly api = inject(AdminApi);
  private readonly toast = inject(ToastService);

  protected readonly maxFeatures = MAX_FEATURES;
  protected readonly maxDescription = MAX_DESCRIPTION;
  protected readonly maxFeatureTitle = MAX_FEATURE_TITLE;
  protected readonly maxFeatureSubtitle = MAX_FEATURE_SUBTITLE;

  private readonly edits = signal<Partial<Fields>>({});
  private readonly categories = signal<AdminCategory[]>([]);
  private readonly config = signal<PlatformConfig | null>(null);

  protected readonly busy = signal(false);
  protected readonly previewBusy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly previewWarnings = signal<string[]>([]);

  private readonly baseline = computed(() => fieldsOf(this.scenario()));
  protected readonly value = computed<Fields>(() => ({ ...this.baseline(), ...this.edits() }));

  private readonly changedFields = computed(() => {
    const base = this.baseline();
    const edits = this.edits();
    return (Object.keys(edits) as (keyof Fields)[]).filter(key => !same(edits[key]!, base[key]));
  });

  /** True while any field differs from what the server holds. The parent asks before discarding it. */
  readonly dirty = computed(() => this.changedFields().length > 0);

  protected readonly descriptionLength = computed(() => this.value().description.length);

  protected readonly problems = computed(() => {
    const { title, description, features } = this.value();
    const found: string[] = [];
    if (!title.trim()) found.push('Вкажіть назву сценарію.');
    if (description.length > MAX_DESCRIPTION) found.push(`Короткий опис довший за ${MAX_DESCRIPTION} символів.`);
    if (features.some(feature => !feature.title.trim())) found.push('У кожного пункту «Що всередині» має бути заголовок.');
    return found;
  });

  protected readonly canSave = computed(() => this.dirty() && this.problems().length === 0 && !this.busy());

  /** The scenario's own category stays selectable even when the list does not have it (a legacy slug). */
  protected readonly categoryOptions = computed(() => {
    const options = this.categories().map(({ slug, label }) => ({ slug, label }));
    const current = this.value().category;
    if (current && !options.some(option => option.slug === current)) {
      options.unshift({ slug: current, label: this.scenario().categoryLabel || current });
    }
    return options;
  });

  protected readonly updated = computed(() => formatDate(this.scenario().updatedAt));

  protected readonly previewHint = computed(() => {
    const preview = this.config()?.preview;
    const limits = preview ? `, від ${preview.minWidth} px завширшки, до ${formatBytes(preview.maxBytes)}` : '';
    return `PNG або JPG, 16:10${limits}. Без превʼю картка виглядає порожньою.`;
  });

  protected readonly card = computed<ScenarioCardData>(() => {
    const { title, description, category, version, author } = this.value();
    const scenario = this.scenario();
    return {
      id: scenario.id,
      title: title || 'Без назви',
      description: description || 'Опис не заповнено',
      category,
      categoryLabel: this.categoryLabel(category) ?? scenario.categoryLabel,
      version,
      author,
      imageUrl: scenario.imageUrl,
      archiveBytes: scenario.archiveBytes,
    };
  });

  protected readonly readinessItems = computed(() =>
    readiness({
      description: this.value().description,
      imageUrl: this.scenario().imageUrl,
      currentVersion: this.scenario().currentVersion,
      archiveSha256: this.scenario().archiveSha256,
    })
  );

  private lastId: string | null = null;

  constructor() {
    // Another scenario drops every edit; a refetched row of the same one only retires the edits it now equals.
    effect(() => {
      const id = this.scenario().id;
      const base = this.baseline();
      untracked(() => {
        if (id !== this.lastId) {
          this.lastId = id;
          this.edits.set({});
          this.error.set(null);
          this.previewWarnings.set([]);
        } else {
          this.edits.update(edits =>
            Object.fromEntries(Object.entries(edits).filter(([key, v]) => !same(v as Fields[keyof Fields], base[key as keyof Fields])))
          );
        }
      });
    });
  }

  ngOnInit(): void {
    // Both are conveniences: without the list the select offers the current category only, without
    // the limits the hint omits the numbers. The save itself is checked by the server either way.
    void this.api.categories().then(list => this.categories.set(list)).catch(err => this.error.set(AdminService.describeError(err)));
    void this.api.config().then(config => this.config.set(config)).catch(() => this.config.set(null));
  }

  private categoryLabel(slug: string): string | undefined {
    return this.categories().find(category => category.slug === slug)?.label;
  }

  // ==================== EDITING ====================

  protected set(field: TextField, event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
    if (field === 'author' && this.role() !== 'moderator') return;
    this.edits.update(edits => ({ ...edits, [field]: value }));
  }

  private updateFeatures(change: (features: ScenarioFeature[]) => ScenarioFeature[]): void {
    this.edits.update(edits => ({ ...edits, features: change(this.value().features) }));
  }

  protected addFeature(): void {
    this.updateFeatures(features =>
      features.length < MAX_FEATURES ? [...features, { icon: DEFAULT_FEATURE_ICON, title: '', subtitle: '' }] : features
    );
  }

  protected removeFeature(index: number): void {
    this.updateFeatures(features => features.filter((_, i) => i !== index));
  }

  protected setFeature(index: number, field: keyof ScenarioFeature, value: string): void {
    this.updateFeatures(features => features.map((feature, i) => (i === index ? { ...feature, [field]: value } : feature)));
  }

  protected discard(): void {
    this.edits.set({});
    this.error.set(null);
  }

  // ==================== SAVE ====================

  /** Only what changed, and only what the role may send (an author's `author` is refused by the server). */
  private patch(): ScenarioPatch {
    const value = this.value();
    const patch: ScenarioPatch = {};
    for (const field of this.changedFields()) {
      switch (field) {
        case 'title': patch.title = value.title.trim(); break;
        case 'features': patch.features = cleanFeatures(value.features); break;
        case 'category':
          patch.category = value.category;
          patch.categoryLabel = this.categoryLabel(value.category) ?? this.scenario().categoryLabel;
          break;
        case 'author':
          if (this.role() === 'moderator') patch.author = value.author;
          break;
        default: patch[field] = value[field];
      }
    }
    return patch;
  }

  protected async save(): Promise<void> {
    if (!this.canSave()) return;
    const patch = this.patch();
    if (Object.keys(patch).length === 0) return;

    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.updateScenario(this.scenario().id, patch);
      this.toast.show('Зміни збережено');
      this.saved.emit();
    } catch (err) {
      // The edits stay: nothing the user typed is lost to a refusal.
      this.error.set(AdminService.describeError(err));
    } finally {
      this.busy.set(false);
    }
  }

  // ==================== PREVIEW ====================

  protected async onPreview(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // the same file can be picked again after a refusal
    if (!file) return;
    await this.changePreview(async () => {
      const result = await this.api.uploadPreview(this.scenario().id, file);
      this.previewWarnings.set(result.warnings ?? []);
      this.toast.show('Превʼю завантажено');
    });
  }

  protected async removePreview(): Promise<void> {
    await this.changePreview(async () => {
      await this.api.removePreview(this.scenario().id);
      this.previewWarnings.set([]);
      this.toast.show('Превʼю прибрано');
    });
  }

  private async changePreview(action: () => Promise<void>): Promise<void> {
    if (this.previewBusy()) return;
    this.previewBusy.set(true);
    this.error.set(null);
    try {
      await action();
      this.saved.emit();
    } catch (err) {
      this.error.set(AdminService.describeError(err));
    } finally {
      this.previewBusy.set(false);
    }
  }
}
