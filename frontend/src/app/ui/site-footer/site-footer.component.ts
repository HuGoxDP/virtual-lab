// path: src/app/ui/site-footer/site-footer.component.ts

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { SITE } from '../../site.config';
import { formatBytes } from '../format';
import { SiteLogoComponent } from '../site-header/site-logo.component';

/**
 * Page footer: about, contacts, and "for developers" with the real archive requirement.
 * `maxArchiveBytes` is the limit from `GET /api/config`; without it (not loaded yet, or the request
 * failed) the line states the format only - the number is never guessed.
 */
@Component({
  selector: 'vl-site-footer',
  standalone: true,
  imports: [RouterLink, SiteLogoComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './site-footer.component.scss',
  template: `
    <footer class="site-footer">
      <div class="footer-inner">
        <div class="footer-about">
          <div class="footer-brand">
            <vl-site-logo [size]="30" />
            <span class="footer-brand-name">{{ site.name }} {{ site.universityShort }}</span>
          </div>
          <p class="footer-text">{{ site.about }}</p>
        </div>

        <div class="footer-col">
          <h6>Контакти</h6>
          <div class="footer-lines">
            <span>
              @for (line of site.address; track line; let last = $last) {
                {{ line }}@if (!last) {<br />}
              }
            </span>
            <a [href]="'mailto:' + site.email">{{ site.email }}</a>
          </div>
        </div>

        <div class="footer-col">
          <h6>Розробникам</h6>
          <div class="footer-lines footer-dev">
            <a class="btn btn-ghost" routerLink="/admin">Панель адміністрування</a>
            <span class="text-muted archive-requirement">{{ archiveRequirement() }}</span>
          </div>
        </div>
      </div>
      <div class="footer-legal"><div class="footer-legal-inner">{{ site.copyright }}</div></div>
    </footer>
  `,
})
export class SiteFooterComponent {
  /** Upload limit in bytes, from the API. */
  readonly maxArchiveBytes = input<number | null | undefined>();
  protected readonly site = SITE;

  protected readonly archiveRequirement = computed(() => {
    const limit = formatBytes(this.maxArchiveBytes());
    return limit ? `ZIP-архів зі сценарієм, до ${limit}` : 'ZIP-архів зі сценарієм';
  });
}
