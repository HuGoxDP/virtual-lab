// path: src/app/pages/admin/admin-guards.ts

import { inject } from '@angular/core';
import { CanActivateFn, CanDeactivateFn, Router } from '@angular/router';

import { AdminSession } from '../../services/admin-session.service';
import { AdminService } from '../../services/admin.service';

export const LOGIN_URL = '/admin/login';
const HOME_URL = '/admin/scenarios';

/** Signed in (the code is checked with the server once per page load); else the sign-in screen. */
export const adminGuard: CanActivateFn = async () => {
  const router = inject(Router);
  return (await inject(AdminSession).restore()) || router.parseUrl(LOGIN_URL);
};

/** Moderators only. An author is sent home rather than shown a dead end; the API refuses them anyway. */
export const moderatorGuard: CanActivateFn = async () => {
  const router = inject(Router);
  const session = inject(AdminSession);
  if (!(await session.restore())) return router.parseUrl(LOGIN_URL);
  return session.isModerator() || router.parseUrl(HOME_URL);
};

/** The sign-in screen itself: someone already signed in has nothing to do there. */
export const loginGuard: CanActivateFn = async () => {
  const router = inject(Router);
  return (await inject(AdminSession).restore()) ? router.parseUrl(HOME_URL) : true;
};

/** A screen that can hold edits the user has not saved. */
export interface HasUnsavedChanges {
  hasUnsavedChanges(): boolean;
}

export const UNSAVED_PROMPT = 'Є незбережені зміни. Покинути сторінку без збереження?';

/**
 * Asks before leaving a screen with unsaved edits. A session that has already ended leaves without
 * asking: the redirect to sign-in is not the user's choice to discard anything they could still save.
 */
export const unsavedChangesGuard: CanDeactivateFn<HasUnsavedChanges> = (screen, current, _currentState, next) => {
  if (!inject(AdminService).isAuthenticated() || !screen.hasUnsavedChanges()) return true;
  // Angular also runs canDeactivate when only the `:tab` param changes. The edits live on in the same page,
  // so a switch between tabs of the same scenario is not a departure.
  const id = current.paramMap.get('id');
  const nextPath = next.url.split(/[?#]/)[0];
  if (id !== null && nextPath.startsWith(`/admin/scenarios/${encodeURIComponent(id)}/`)) return true;
  return window.confirm(UNSAVED_PROMPT);
};
