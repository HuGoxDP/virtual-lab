// path: src/app/ui/icon/icon.component.ts

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { ICON_PATHS } from './icon-data.generated';

export { ICON_NAMES } from './icon-data.generated';

/** Shown for a name that is not hosted (a typo, or an icon added to the data but not to the set). */
const FALLBACK_ICON = 'folder';

/**
 * A Phosphor icon drawn as `<svg><path [attr.d]>` from generated path data: it takes the text colour
 * (`currentColor`) and, unless `size` says otherwise, the surrounding font size (`1em`).
 * An unknown, empty or missing name draws the fallback instead of throwing — icon names come from
 * the database, and a bad row must not blank a page.
 */
@Component({
  selector: 'vl-icon',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `:host { display: inline-flex; flex: none; line-height: 1; } svg { display: block; }`,
  template: `
    <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" focusable="false"
         [attr.width]="dimension()" [attr.height]="dimension()">
      @for (d of paths(); track $index) {
        <path [attr.d]="d" />
      }
    </svg>
  `,
})
export class IconComponent {
  /** A name from `ICON_NAMES`. */
  readonly name = input<string | null | undefined>();
  /** Pixels as a number, any CSS length as a string; defaults to the font size. */
  readonly size = input<number | string>('1em');

  protected readonly paths = computed(() => {
    const name = this.name();
    return (name && Object.hasOwn(ICON_PATHS, name) ? ICON_PATHS[name] : ICON_PATHS[FALLBACK_ICON]) ?? [];
  });

  protected readonly dimension = computed(() => {
    const size = this.size();
    return typeof size === 'number' ? String(size) : size;
  });
}
