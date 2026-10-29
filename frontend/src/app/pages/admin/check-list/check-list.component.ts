// path: src/app/pages/admin/check-list/check-list.component.ts

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { pluralUk } from '../../../ui/format';

import { ArchiveCheckItem, ArchiveChecks } from '../../../models/admin.model';
import { IconComponent } from '../../../ui/icon/icon.component';

const LEVEL_ICON: Readonly<Record<ArchiveCheckItem['level'], string>> = {
  ok: 'check-circle', warning: 'warning', error: 'warning-circle',
};
const LEVEL_TEXT: Readonly<Record<ArchiveCheckItem['level'], string>> = {
  ok: 'Гаразд', warning: 'Зауваження', error: 'Помилка',
};

/** The one-line verdict over a set of checks. */
export function summarizeChecks(checks: ArchiveChecks): string {
  const errors = checks.items.filter(item => item.level === 'error').length;
  const warnings = checks.items.filter(item => item.level === 'warning').length;
  if (errors > 0) return `Архів не придатний до запуску — ${errors} ${pluralUk(errors, ['помилка', 'помилки', 'помилок'])}`;
  if (warnings > 0) return `Архів придатний до запуску — ${warnings} ${pluralUk(warnings, ['зауваження', 'зауваження', 'зауважень'])}`;
  return 'Архів придатний до запуску';
}

/**
 * The static checks of an archive, one row each (prototype 2i). `label` and `note` come from the server,
 * which builds them from the archive's own manifest, so they are untrusted text and only ever interpolated.
 * The level is also spelled out, never colour alone.
 */
@Component({
  selector: 'vl-check-list',
  standalone: true,
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host { display: block; min-width: 0; }
    .verdict { margin: 0 0 var(--space-4); font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
    .verdict.bad { color: #f0b4b4; }
    .verdict.warn { color: #e5c887; }
    .verdict.ok { color: #8fdcb4; }
    ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: var(--space-3); }
    li { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
    li.ok vl-icon { color: #8fdcb4; }
    li.warning vl-icon { color: #e5c887; }
    li.error vl-icon { color: #f0b4b4; }
    .text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .label { font-size: 14px; overflow-wrap: anywhere; }
    .note { font-size: 12.5px; overflow-wrap: anywhere; color: color-mix(in srgb, var(--color-text) 62%, transparent); }
    .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  `,
  template: `
    <p class="verdict" [class.bad]="tone() === 'bad'" [class.warn]="tone() === 'warn'" [class.ok]="tone() === 'ok'">{{ verdict() }}</p>
    <ul>
      @for (item of checks().items; track $index) {
        <li [class]="item.level" data-role="check-item">
          <vl-icon [name]="icon(item)" size="18" />
          <span class="text">
            <span class="label"><span class="visually-hidden">{{ levelText(item) }}: </span>{{ item.label }}</span>
            @if (item.note) { <span class="note">{{ item.note }}</span> }
          </span>
        </li>
      }
    </ul>
  `,
})
export class CheckListComponent {
  readonly checks = input.required<ArchiveChecks>();

  protected readonly verdict = computed(() => summarizeChecks(this.checks()));
  protected readonly tone = computed<'ok' | 'warn' | 'bad'>(() => {
    const levels = this.checks().items.map(item => item.level);
    return levels.includes('error') ? 'bad' : levels.includes('warning') ? 'warn' : 'ok';
  });

  protected icon(item: ArchiveCheckItem): string {
    return LEVEL_ICON[item.level] ?? 'info';
  }

  protected levelText(item: ArchiveCheckItem): string {
    return LEVEL_TEXT[item.level] ?? '';
  }
}
