// path: src/app/pages/admin/categories/categories.component.ts

import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';

import { AdminCategory } from '../../../models/admin.model';
import { AdminApi } from '../../../services/admin-api.service';
import { AdminService } from '../../../services/admin.service';
import { pluralUk } from '../../../ui/format';
import { IconPickerComponent } from '../../../ui/icon-picker/icon-picker.component';
import { IconComponent } from '../../../ui/icon/icon.component';
import { ToastService } from '../../../ui/toast/toast.service';

/** Same rule as the server (`CATEGORY_SLUG_PATTERN`); the server stays the authority. */
const SLUG = /^[a-z0-9-]{2,50}$/;
const MAX_LABEL = 100;

/**
 * `/admin/categories` (prototype 2m, «Напрями»), a moderator's page: the order of the catalog's chips, the
 * icon, the number of scenarios, visibility and a form to add one. A category with scenarios cannot be
 * deleted (the button is disabled and says why): hide it instead. Order changes with the move buttons
 * (keyboard friendly) and is sent as the full list; when the server says the list changed meanwhile (409),
 * the list is read again. Every mutation re-reads the list so the counts stay true.
 */
@Component({
  selector: 'vl-categories',
  standalone: true,
  imports: [IconComponent, IconPickerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './categories.component.scss',
  template: `
    <header class="page-head">
      <div>
        <h1>Напрями</h1>
        <p class="sub" data-role="summary">{{ summary() }} · порядок визначає розташування чипсів у каталозі</p>
      </div>
    </header>

    @if (error(); as message) {
      <p class="banner banner-error" role="alert" data-role="error">{{ message }}</p>
    }
    <p class="banner banner-warn" data-role="used-hint">Категорію з привʼязаними сценаріями не можна видалити — спершу перенесіть сценарії або сховайте категорію.</p>

    @if (!loaded()) {
      <p class="muted">Завантаження…</p>
    } @else {
      <div class="table-wrap">
        <table class="table categories-table" data-role="table">
          <thead>
            <tr><th>Порядок</th><th>Іконка</th><th>Назва</th><th>Slug</th><th>Сценаріїв</th><th>У каталозі</th><th><span class="visually-hidden">Дії</span></th></tr>
          </thead>
          <tbody>
            @for (item of items(); track item.slug; let i = $index; let first = $first; let last = $last) {
              <tr [attr.data-slug]="item.slug" [class.hidden-row]="!item.isVisible">
                <td class="order">
                  <button type="button" class="btn btn-icon" data-action="up" [attr.aria-label]="'Вище: ' + item.label" [disabled]="busy() || first" (click)="move(i, -1)">
                    <vl-icon name="arrow-left" size="14" class="rot-up" />
                  </button>
                  <button type="button" class="btn btn-icon" data-action="down" [attr.aria-label]="'Нижче: ' + item.label" [disabled]="busy() || last" (click)="move(i, 1)">
                    <vl-icon name="arrow-right" size="14" class="rot-down" />
                  </button>
                </td>
                <td><vl-icon-picker [value]="item.icon" [label]="'Іконка ' + item.label" (valueChange)="setIcon(item, $event)" /></td>
                <td>
                  <input class="input label-input" [attr.aria-label]="'Назва ' + item.slug" [value]="item.label" [maxLength]="maxLabel"
                         (change)="rename(item, $event)" />
                </td>
                <td class="slug">{{ item.slug }}</td>
                <td class="num" data-role="count">{{ item.scenarioCount ?? 0 }}</td>
                <td>
                  <button type="button" class="btn btn-ghost" data-action="visibility" [disabled]="busy()" (click)="toggleVisible(item)">
                    <vl-icon [name]="item.isVisible ? 'eye' : 'eye-slash'" size="14" />{{ item.isVisible ? 'Показано' : 'Сховано' }}
                  </button>
                </td>
                <td class="actions">
                  <button type="button" class="btn btn-ghost danger" data-action="delete" [disabled]="busy() || (item.scenarioCount ?? 0) > 0"
                          [attr.title]="(item.scenarioCount ?? 0) > 0 ? 'Категорія використовується: спершу перенесіть сценарії або сховайте її' : null"
                          (click)="remove(item)">
                    <vl-icon name="trash" size="14" />Видалити
                  </button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>

      <section class="panel add" aria-labelledby="add-title">
        <h2 id="add-title">Нова категорія</h2>
        <form (submit)="add($event)" novalidate>
          <div class="fields">
            <div class="field">
              <label for="cat-label">Назва</label>
              <input id="cat-label" class="input" [value]="newLabel()" [maxLength]="maxLabel" (input)="newLabel.set($any($event.target).value)" />
            </div>
            <div class="field">
              <label for="cat-slug">Slug</label>
              <input id="cat-slug" class="input" [value]="newSlug()" maxlength="50" placeholder="latin-slug" (input)="newSlug.set($any($event.target).value)" />
            </div>
            <div class="field">
              <label>Іконка</label>
              <vl-icon-picker [value]="newIcon()" label="Іконка нової категорії" (valueChange)="newIcon.set($event)" />
            </div>
          </div>
          <label class="check"><input type="checkbox" [checked]="newVisible()" (change)="newVisible.set($any($event.target).checked)" /> Показувати в каталозі</label>
          @if (formError(); as problem) { <p class="banner banner-error" role="alert" data-role="form-error">{{ problem }}</p> }
          <button type="submit" class="btn btn-primary" data-action="add" [disabled]="busy()"><vl-icon name="plus" size="16" />Додати категорію</button>
        </form>
      </section>
    }
  `,
})
export class CategoriesComponent implements OnInit {
  private readonly api = inject(AdminApi);
  private readonly toast = inject(ToastService);

  protected readonly maxLabel = MAX_LABEL;
  protected readonly items = signal<AdminCategory[]>([]);
  protected readonly loaded = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly newLabel = signal('');
  protected readonly newSlug = signal('');
  protected readonly newIcon = signal('folder');
  protected readonly newVisible = signal(true);
  protected readonly formError = signal<string | null>(null);

  protected readonly summary = computed(() => {
    const n = this.items().length;
    return `${n} ${pluralUk(n, ['категорія', 'категорії', 'категорій'])}`;
  });

  ngOnInit(): void {
    void this.refresh();
  }

  /** Reads the list again; a failure keeps what is on screen and says why. */
  private async refresh(): Promise<void> {
    try {
      this.items.set(await this.api.categories());
    } catch (err) {
      this.error.set(AdminService.describeError(err));
    } finally {
      this.loaded.set(true);
    }
  }

  /** Runs one mutation exclusively, then re-reads the list; the server's refusal is shown as sent. */
  private async mutate(work: () => Promise<unknown>, done: string, refetchOnConflict = false): Promise<boolean> {
    if (this.busy()) return false;
    this.busy.set(true);
    this.error.set(null);
    let ok = false;
    try {
      await work();
      this.toast.show(done);
      ok = true;
    } catch (err) {
      this.error.set(AdminService.describeError(err));
      if (!(refetchOnConflict && err instanceof HttpErrorResponse && err.status === 409)) {
        this.busy.set(false);
        return false;
      }
    }
    await this.refresh();
    this.busy.set(false);
    return ok;
  }

  protected move(index: number, delta: -1 | 1): Promise<boolean> {
    const slugs = this.items().map(item => item.slug);
    const target = index + delta;
    if (target < 0 || target >= slugs.length) return Promise.resolve(false);
    [slugs[index], slugs[target]] = [slugs[target], slugs[index]];
    return this.mutate(() => this.api.reorderCategories(slugs), 'Порядок змінено', true);
  }

  protected toggleVisible(item: AdminCategory): Promise<boolean> {
    return this.mutate(() => this.api.updateCategory(item.slug, { isVisible: !item.isVisible }), item.isVisible ? 'Категорію сховано' : 'Категорію показано');
  }

  protected setIcon(item: AdminCategory, icon: string): Promise<boolean> {
    return icon === item.icon ? Promise.resolve(false) : this.mutate(() => this.api.updateCategory(item.slug, { icon }), 'Іконку змінено');
  }

  protected async rename(item: AdminCategory, event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const label = input.value.trim();
    if (label === item.label) return;
    if (!label) { input.value = item.label; this.error.set('Назва не може бути порожньою.'); return; }
    if (!(await this.mutate(() => this.api.updateCategory(item.slug, { label }), 'Назву змінено'))) input.value = item.label;
  }

  protected remove(item: AdminCategory): Promise<boolean> {
    if ((item.scenarioCount ?? 0) > 0) return Promise.resolve(false);
    if (!confirm(`Видалити категорію «${item.label}»?`)) return Promise.resolve(false);
    return this.mutate(() => this.api.deleteCategory(item.slug), 'Категорію видалено');
  }

  protected async add(event: Event): Promise<void> {
    event.preventDefault();
    const label = this.newLabel().trim();
    const slug = this.newSlug().trim();
    if (!label) return void this.formError.set('Вкажіть назву.');
    if (!SLUG.test(slug)) return void this.formError.set('Slug: 2–50 символів — малі латинські літери, цифри та «-».');
    this.formError.set(null);
    const ok = await this.mutate(
      () => this.api.createCategory({ slug, label, icon: this.newIcon(), isVisible: this.newVisible() }), 'Категорію додано');
    if (ok) {
      this.newLabel.set(''); this.newSlug.set(''); this.newIcon.set('folder'); this.newVisible.set(true);
    } else {
      this.formError.set(this.error());
    }
  }
}
