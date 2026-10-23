// path: src/app/ui/site-header/site-header.component.ts

import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { SITE } from '../../site.config';
import { SiteLogoComponent } from './site-logo.component';

/**
 * The sticky Nocturne header.
 *
 *  - `full` (catalog): logo + site and university names first, then `[header-start]`, then `[header-end]`.
 *  - `logo` (scenario page): `[header-start]` fills the left (back button + breadcrumbs), then
 *    `[header-end]`, and only the logo - last.
 *
 * The brand links to the catalog. Every text comes from `SITE`.
 */
@Component({
  selector: 'vl-site-header',
  standalone: true,
  imports: [RouterLink, SiteLogoComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './site-header.component.scss',
  template: `
    <header class="site-header" [class.is-logo-only]="brand() === 'logo'">
      @if (brand() === 'full') {
        <a class="brand" routerLink="/catalog">
          <vl-site-logo [size]="36" />
          <span class="brand-text">
            <span class="brand-name">{{ site.name }}</span>
            <span class="brand-sub">{{ site.university }}</span>
          </span>
        </a>
      }
      <div class="slot-start"><ng-content select="[header-start]" /></div>
      <div class="slot-end"><ng-content select="[header-end]" /></div>
      @if (brand() === 'logo') {
        <vl-site-logo [size]="30" />
      }
    </header>
  `,
})
export class SiteHeaderComponent {
  readonly brand = input<'full' | 'logo'>('full');
  protected readonly site = SITE;
}
