// path: src/app/ui/site-footer/site-footer.component.ts

import { ChangeDetectionStrategy, Component } from '@angular/core';

import { SITE } from '../../site.config';

/** Page footer: the copyright bar only. Brand, contacts and the developers' block were removed in release 1, phase 5. */
@Component({
  selector: 'vl-site-footer',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './site-footer.component.scss',
  template: `
    <footer class="site-footer">
      <div class="footer-legal"><div class="footer-legal-inner">{{ site.copyright }}</div></div>
    </footer>
  `,
})
export class SiteFooterComponent {
  protected readonly site = SITE;
}
