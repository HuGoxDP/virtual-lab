// path: src/app/pages/admin/admin-guards.spec.ts
//
// Test-plan scenario 208 (DW-5.1, DW-5.5): the admin routes need a signed-in code, the old admin and the
// moderator pages need a moderator, and leaving a screen with unsaved edits asks first.

import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRouteSnapshot, CanActivateFn, Router, RouterStateSnapshot, UrlTree, provideRouter } from '@angular/router';

import { AdminService } from '../../services/admin.service';
import { adminGuard, HasUnsavedChanges, loginGuard, moderatorGuard, UNSAVED_PROMPT, unsavedChangesGuard } from './admin-guards';

describe('admin guards', () => {
  let http: HttpTestingController;
  let admin: AdminService;

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    admin = TestBed.inject(AdminService);
  });

  afterEach(() => http.verify());

  const run = (guard: CanActivateFn) =>
    TestBed.runInInjectionContext(() => guard({} as ActivatedRouteSnapshot, {} as RouterStateSnapshot));

  /** Runs the guard with a stored code the server answers for as `identity`. */
  async function runAs(guard: CanActivateFn, identity: { role: string; label: string; keyId: number | null } | null) {
    admin.setToken('stored');
    const result = Promise.resolve(run(guard));
    await Promise.resolve();
    const req = http.expectOne('/api/auth/me');
    if (identity) req.flush(identity);
    else req.flush({ error: 'Невірний токен' }, { status: 403, statusText: 'Forbidden' });
    return result;
  }

  const path = (result: unknown) => TestBed.inject(Router).serializeUrl(result as UrlTree);

  describe('adminGuard', () => {
    it('DW-5.1 sends an anonymous visitor to the sign-in screen without asking the server', async () => {
      expect(path(await run(adminGuard))).toBe('/admin/login');
      http.expectNone('/api/auth/me');
    });

    it('lets a valid code in', async () => {
      expect(await runAs(adminGuard, { role: 'author', label: 'A', keyId: 1 })).toBe(true);
    });

    it('DW-5.5 a stored code the server rejects goes to sign-in', async () => {
      expect(path(await runAs(adminGuard, null))).toBe('/admin/login');
    });
  });

  describe('moderatorGuard (the old admin and the moderator pages)', () => {
    it('DW-5.1 admits a moderator', async () => {
      expect(await runAs(moderatorGuard, { role: 'moderator', label: 'M', keyId: 2 })).toBe(true);
    });

    it('DW-5.1 sends an author back to the list', async () => {
      expect(path(await runAs(moderatorGuard, { role: 'author', label: 'A', keyId: 1 }))).toBe('/admin');
    });

    it('DW-5.1 sends an anonymous visitor to sign-in', async () => {
      expect(path(await run(moderatorGuard))).toBe('/admin/login');
    });
  });

  describe('loginGuard', () => {
    it('shows the form to an anonymous visitor', async () => {
      expect(await run(loginGuard)).toBe(true);
    });

    it('skips it for someone already signed in', async () => {
      expect(path(await runAs(loginGuard, { role: 'author', label: 'A', keyId: 1 }))).toBe('/admin');
    });
  });

  describe('unsavedChangesGuard', () => {
    const screen = (dirty: boolean): HasUnsavedChanges => ({ hasUnsavedChanges: () => dirty });
    const leave = (target: HasUnsavedChanges, to = '/admin/upload', id = 'alpha') =>
      TestBed.runInInjectionContext(() => unsavedChangesGuard(
        target,
        { paramMap: { get: (name: string) => (name === 'id' ? id : null) } } as unknown as ActivatedRouteSnapshot,
        {} as RouterStateSnapshot,
        { url: to } as RouterStateSnapshot,
      ));

    afterEach(() => vi.restoreAllMocks());

    it('DW-5.5 a clean screen leaves without asking', () => {
      admin.setToken('t');
      const confirm = vi.spyOn(window, 'confirm');
      expect(leave(screen(false))).toBe(true);
      expect(confirm).not.toHaveBeenCalled();
    });

    it('DW-5.5 a dirty screen asks, and the answer decides', () => {
      admin.setToken('t');
      const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
      expect(leave(screen(true))).toBe(false);
      expect(leave(screen(true))).toBe(true);
      expect(confirm).toHaveBeenCalledWith(UNSAVED_PROMPT);
    });

    it('DW-5.5 a tab switch within the same scenario never asks, even when confirm would say no', () => {
      admin.setToken('t');
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      expect(leave(screen(true), '/admin/scenarios/alpha/publish')).toBe(true);
      expect(leave(screen(true), '/admin/scenarios/alpha/meta?x=1#h')).toBe(true);
      expect(confirm).not.toHaveBeenCalled();
    });

    it('DW-5.5 another scenario, or one whose id merely starts the same, is a departure and is blocked on No', () => {
      admin.setToken('t');
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      expect(leave(screen(true), '/admin/scenarios/beta/meta')).toBe(false);
      expect(leave(screen(true), '/admin/scenarios/alpha-2/meta')).toBe(false);
      expect(leave(screen(true), '/admin/scenarios')).toBe(false);
      expect(confirm).toHaveBeenCalledTimes(3);
    });

    it('DW-5.5 an ended session leaves without asking (the redirect to sign-in is not a choice)', () => {
      const confirm = vi.spyOn(window, 'confirm');
      expect(leave(screen(true))).toBe(true);
      expect(confirm).not.toHaveBeenCalled();
    });
  });
});
