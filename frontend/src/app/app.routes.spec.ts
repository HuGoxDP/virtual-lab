// path: src/app/app.routes.spec.ts
//
// Test-plan scenario 221 (DW-6.4): the old admin is gone. `/admin/legacy` has no route of its own, so it
// falls through to the admin's catch-all (the list) instead of loading a screen; the wizard is a real route.

import { Route } from '@angular/router';

import { routes } from './app.routes';

const admin = routes.find(route => route.path === 'admin') as Route;
const paths = (list: Route[] | undefined) => (list ?? []).map(route => route.path);

describe('app routes', () => {
  it('DW-6.4 no route serves the old admin', () => {
    expect(paths(routes)).not.toContain('admin/legacy');
    expect(paths(admin.children)).not.toContain('legacy');
  });

  it('DW-6.4 an unknown admin path, /admin/legacy included, redirects to the list', () => {
    const catchAll = (admin.children ?? []).find(route => route.path === '**');
    expect(catchAll?.redirectTo).toBe('scenarios');
  });

  it('DW-6.4 /admin/upload is the wizard, guarded against losing unsaved metadata', () => {
    const upload = (admin.children ?? []).find(route => route.path === 'upload')!;
    expect(upload.loadComponent).toBeTypeOf('function');
    expect(upload.canDeactivate?.length).toBe(1);
    expect(upload.data).toBeUndefined(); // no longer a placeholder slot
  });
});
