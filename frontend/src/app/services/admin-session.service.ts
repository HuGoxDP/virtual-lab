// path: src/app/services/admin-session.service.ts

import { Injectable, computed, inject, signal } from '@angular/core';

import { AdminUser } from '../models/admin.model';
import { AdminApi, isCredentialRejection } from './admin-api.service';
import { AdminService } from './admin.service';

const REJECTED_CODE = 'Невірний або відкликаний код доступу.';

/**
 * Who is signed in. The code itself stays in `AdminService` (`sessionStorage`); this adds the identity
 * the server reports for it. `user` is derived from the token as well, so a code cleared anywhere (sign-out,
 * a revoked key noticed by `AdminApi`) signs the whole UI out at once.
 */
@Injectable({ providedIn: 'root' })
export class AdminSession {

  private readonly api = inject(AdminApi);
  private readonly admin = inject(AdminService);

  private readonly _user = signal<AdminUser | null>(null);

  readonly user = computed(() => (this.admin.isAuthenticated() ? this._user() : null));
  readonly role = computed(() => this.user()?.role ?? null);
  readonly isModerator = computed(() => this.role() === 'moderator');

  /**
   * Checks `code` with the server and, only if it is valid, keeps it for the tab. Rejects with a
   * Ukrainian message suitable for the form; nothing is stored on failure.
   */
  async signIn(code: string): Promise<AdminUser> {
    const trimmed = code.trim();
    if (!trimmed) throw new Error('Введіть код доступу.');

    let user: AdminUser;
    try {
      user = await this.api.me(trimmed);
    } catch (err) {
      throw new Error(isCredentialRejection(err) ? REJECTED_CODE : AdminService.describeError(err));
    }
    this.admin.setToken(trimmed);
    this._user.set(user);
    return user;
  }

  /**
   * After a reload the code is in `sessionStorage` but the identity is not: fetch it.
   * True when signed in afterwards. A rejected code has already been dropped (with its reason) by
   * `AdminApi`; any other failure (server down) drops the code too and says so, because an identity
   * that cannot be confirmed must not be assumed.
   */
  async restore(): Promise<boolean> {
    if (!this.admin.isAuthenticated()) return false;
    if (this._user()) return true;
    try {
      this._user.set(await this.api.me());
      return true;
    } catch (err) {
      if (this.admin.isAuthenticated()) this.admin.endSession(AdminService.describeError(err));
      return false;
    }
  }

  signOut(): void {
    this.admin.clearToken();
    this._user.set(null);
  }
}
