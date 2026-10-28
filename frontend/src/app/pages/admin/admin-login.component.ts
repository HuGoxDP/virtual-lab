// path: src/app/pages/admin/admin-login.component.ts

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { AdminSession } from '../../services/admin-session.service';
import { AdminService } from '../../services/admin.service';
import { IconComponent } from '../../ui/icon/icon.component';
import { SiteLogoComponent } from '../../ui/site-header/site-logo.component';
import { SITE } from '../../site.config';

/** The three steps of the publishing flow, as the prototype's side panel tells them (Unity wording replaced). */
const STEPS = [
  { title: 'Автор завантажує архів сценарію', text: 'Сценарій зберігається як чернетка й не видимий у каталозі.' },
  { title: 'Автоперевірка архіву', text: 'Маніфест, точка входу, ресурси, розмір.' },
  { title: 'Модератор публікує', text: 'Сценарій зʼявляється в каталозі для студентів.' },
] as const;

/**
 * `/admin/login` (prototype 2e): one field, the access code. The code is verified with the server before
 * it is kept; a code that was taken away mid-session (revoked, expired) comes back here with its reason.
 */
@Component({
  selector: 'vl-admin-login',
  standalone: true,
  imports: [IconComponent, RouterLink, SiteLogoComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './admin-login.component.scss',
  template: `
    <main class="login">
      <section class="form-side">
        <a class="brand" routerLink="/catalog">
          <vl-site-logo [size]="36" />
          <span class="brand-text">
            <span class="brand-name">{{ site.name }}</span>
            <span class="brand-sub">{{ site.university }}</span>
          </span>
        </a>

        <h1>Вхід до панелі</h1>
        <p class="lead">Доступ за особистим кодом. Код видає модератор каталогу.</p>

        <form class="field" (submit)="$event.preventDefault(); submit()">
          <label for="access-code">Код доступу</label>
          <input id="access-code" class="input code-input" type="password" autocomplete="off" spellcheck="false"
                 placeholder="Вставте код" [value]="code()" [attr.aria-invalid]="!!notice()"
                 [attr.aria-describedby]="notice() ? 'login-notice' : null" (input)="onInput($event)" />
          @if (notice(); as text) {
            <p id="login-notice" class="plaque" role="alert">
              <vl-icon name="warning-circle" size="16" /><span>{{ text }}</span>
            </p>
          }
          <button class="btn btn-primary btn-block" type="submit" [disabled]="busy()">
            <vl-icon name="sign-in" size="16" />Увійти
          </button>
        </form>
      </section>

      <aside class="how" aria-labelledby="how-title">
        <h2 id="how-title">Як працює публікація</h2>
        <ol>
          @for (step of steps; track step.title; let i = $index) {
            <li>
              <span class="num">{{ i + 1 }}</span>
              <span><strong>{{ step.title }}</strong><span class="text-muted">{{ step.text }}</span></span>
            </li>
          }
        </ol>
      </aside>
    </main>
  `,
})
export class AdminLoginComponent {
  private readonly session = inject(AdminSession);
  private readonly admin = inject(AdminService);
  private readonly router = inject(Router);

  protected readonly site = SITE;
  protected readonly steps = STEPS;

  protected readonly code = signal('');
  protected readonly busy = signal(false);
  private readonly error = signal<string | null>(null);

  /** What sits under the field: this attempt's failure, else why the last session ended. */
  protected readonly notice = computed(() => this.error() ?? this.admin.endedReason() ?? this.outage());

  /** A stored code the server could not be asked about (it is down): the code is still kept. */
  private readonly outage = computed(() => {
    const problem = this.session.restoreProblem();
    return problem && `Не вдалося перевірити збережений код: ${problem}. Код збережено — оновіть сторінку, щоб спробувати знову, або введіть його ще раз.`;
  });

  protected onInput(event: Event): void {
    this.code.set((event.target as HTMLInputElement).value);
    this.error.set(null);
  }

  protected async submit(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.session.signIn(this.code());
      this.code.set('');
      await this.router.navigateByUrl('/admin/scenarios');
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Не вдалося увійти.');
    } finally {
      this.busy.set(false);
    }
  }
}
