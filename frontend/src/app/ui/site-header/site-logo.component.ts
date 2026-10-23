// path: src/app/ui/site-header/site-logo.component.ts

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { SITE } from '../../site.config';

/** The university logo in the light circle the Nocturne header and footer both use. */
@Component({
  selector: 'vl-site-logo',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: grid; place-items: center; flex: none; overflow: hidden;
      background: var(--color-neutral-100); border-radius: 50%;
    }
    img { object-fit: contain; }
  `,
  host: { '[style.width.px]': 'size()', '[style.height.px]': 'size()' },
  template: `<img [src]="logo.src" [alt]="logo.alt" [style.width.px]="inner()" [style.height.px]="inner()" />`,
})
export class SiteLogoComponent {
  protected readonly logo = SITE.logo;
  /** Diameter of the circle in px; the logo sits 3px inside it on every side. */
  readonly size = input(36);
  protected readonly inner = computed(() => this.size() - 6);
}
