// path: src/app/pages/admin/admin-shell/admin-shell.component.ts

import { ChangeDetectionStrategy, Component, HostListener, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';

import { AdminApi } from '../../../services/admin-api.service';
import { AdminSession } from '../../../services/admin-session.service';
import { AdminService } from '../../../services/admin.service';
import { IconComponent } from '../../../ui/icon/icon.component';
import { SITE } from '../../../site.config';
import { LOGIN_URL } from '../admin-guards';

interface NavItem {
  label: string;
  link: string;
  icon: string;
  badge?: number | null;
}

/** `Іван Петренко` -> `ІП`; one word -> its first letter; nothing -> `?`. */
export function initials(label: string): string {
  const letters = label.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(word => [...word][0]);
  return letters.length ? letters.join('').toUpperCase() : '?';
}

/**
 * The admin frame: a sidebar with role-aware items, the user card and sign-out; on a narrow screen
 * a top bar with a burger opens the same sidebar as a drawer. The child routes render in the
 * content area. Losing the session anywhere (sign-out, a revoked code noticed by an API call) sends
 * the user to the sign-in screen from here.
 */
@Component({
  selector: 'vl-admin-shell',
  standalone: true,
  imports: [IconComponent, RouterLink, RouterLinkActive, RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './admin-shell.component.scss',
  template: `
    <div class="shell" [class.menu-open]="menuOpen()">
      <header class="topbar">
        <button type="button" class="btn btn-icon burger" aria-controls="admin-sidebar"
                [attr.aria-expanded]="menuOpen()" aria-label="Меню" (click)="menuOpen.set(!menuOpen())">
          <vl-icon [name]="menuOpen() ? 'x' : 'list'" size="20" />
        </button>
        <span class="topbar-title">{{ site.name }}</span>
      </header>

      <div class="scrim" (click)="menuOpen.set(false)" aria-hidden="true"></div>

      <aside class="sidebar" id="admin-sidebar" aria-label="Адмінка">
        <a class="back" routerLink="/catalog"><vl-icon name="arrow-left" size="14" />Каталог</a>

        <nav class="nav-list" aria-label="Розділи">
          @for (item of nav(); track item.link) {
            <a class="nav-item" [routerLink]="item.link" routerLinkActive="active" ariaCurrentWhenActive="page">
              <vl-icon [name]="item.icon" size="18" />
              <span class="nav-label">{{ item.label }}</span>
              @if (item.badge) {
                <span class="badge" [attr.aria-label]="item.badge + ' у черзі'">{{ item.badge }}</span>
              }
            </a>
          }
        </nav>

        @if (session.user(); as user) {
          <div class="user-card">
            <span class="avatar" aria-hidden="true">{{ initials(user.label) }}</span>
            <span class="user-text">
              <span class="user-name" [attr.title]="user.label">{{ user.label }}</span>
              <span class="user-role">{{ user.role === 'moderator' ? 'Модератор' : 'Автор' }}</span>
            </span>
            <button type="button" class="btn btn-icon sign-out" aria-label="Вийти" title="Вийти" (click)="signOut()">
              <vl-icon name="sign-out" size="18" />
            </button>
          </div>
        }
      </aside>

      <main class="content"><router-outlet /></main>
    </div>
  `,
})
export class AdminShellComponent {
  protected readonly session = inject(AdminSession);
  private readonly admin = inject(AdminService);
  private readonly api = inject(AdminApi);
  private readonly router = inject(Router);

  protected readonly site = SITE;
  protected readonly initials = initials;
  protected readonly menuOpen = signal(false);

  /** Scenarios waiting for a moderator; null when unknown (authors, or the call failed). */
  private readonly queueSize = signal<number | null>(null);

  protected readonly nav = computed<NavItem[]>(() => {
    const moderator = this.session.isModerator();
    return [
      { label: moderator ? 'Усі сценарії' : 'Мої сценарії', link: '/admin/scenarios', icon: 'stack' },
      { label: 'Завантажити', link: '/admin/upload', icon: 'upload-simple' },
      ...(moderator
        ? [
          { label: 'Черга модерації', link: '/admin/queue', icon: 'seal-check', badge: this.queueSize() },
          { label: 'Напрями', link: '/admin/categories', icon: 'folders' },
          { label: 'Доступ', link: '/admin/access', icon: 'shield-check' },
          // Until the wizard replaces it, this is the only place an archive can be uploaded.
          { label: 'Старий інтерфейс', link: '/admin/legacy', icon: 'arrow-square-out' },
        ]
        : []),
    ];
  });

  constructor() {
    effect(() => {
      if (!this.admin.isAuthenticated()) void untracked(() => this.router.navigateByUrl(LOGIN_URL));
    });

    // The badge follows the user around: refreshed on every navigation, and the drawer closes.
    this.router.events.pipe(filter(event => event instanceof NavigationEnd), takeUntilDestroyed()).subscribe(() => {
      this.menuOpen.set(false);
      void this.refreshQueue();
    });
    effect(() => {
      if (this.session.isModerator()) void untracked(() => this.refreshQueue());
      else this.queueSize.set(null);
    });
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.menuOpen.set(false);
  }

  protected signOut(): void {
    this.session.signOut();
  }

  private async refreshQueue(): Promise<void> {
    if (!this.session.isModerator()) return;
    try {
      this.queueSize.set((await this.api.dashboard()).queueSize);
    } catch {
      // The badge is a convenience: without it the item simply shows no number. A rejected code has
      // already ended the session (AdminApi), and that is what the user is told about.
      this.queueSize.set(null);
    }
  }
}
