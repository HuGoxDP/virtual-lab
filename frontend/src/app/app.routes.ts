// path: src/app/app.routes.ts

import { Route, Routes } from '@angular/router';

import { adminGuard, loginGuard, moderatorGuard, unsavedChangesGuard } from './pages/admin/admin-guards';

/** A section whose screen comes in a later phase: reachable, titled, and nothing more. */
function slot(title: string): Pick<Route, 'loadComponent' | 'data'> {
  return {
    data: { title },
    loadComponent: () => import('./pages/admin/admin-slot.component').then(m => m.AdminSlotComponent),
  };
}

export const routes: Routes = [
  {
    path: '',
    redirectTo: 'catalog',
    pathMatch: 'full',
  },
  {
    path: 'catalog',
    loadComponent: () =>
      import('./pages/catalog/catalog.component').then(m => m.CatalogComponent),
  },
  {
    path: 'scenario/:id',
    loadComponent: () =>
      import('./pages/scenario/scenario.component').then(m => m.ScenarioComponent),
  },
  {
    path: 'play/:id',
    loadComponent: () =>
      import('./pages/viewer/viewer.component').then(m => m.ViewerComponent),
  },
  // The admin. Sign-in and the old admin sit outside the shell (own layouts); everything else is a child of it.
  {
    path: 'admin/login',
    canActivate: [loginGuard],
    loadComponent: () =>
      import('./pages/admin/admin-login.component').then(m => m.AdminLoginComponent),
  },
  {
    // The old admin: the only archive-upload screen until the wizard exists. Moderators only.
    path: 'admin/legacy',
    canActivate: [moderatorGuard],
    loadComponent: () =>
      import('./pages/admin/legacy/admin.component').then(m => m.AdminComponent),
  },
  {
    path: 'admin',
    canActivate: [adminGuard],
    loadComponent: () =>
      import('./pages/admin/admin-shell/admin-shell.component').then(m => m.AdminShellComponent),
    children: [
      // The dashboard replaces this redirect; until then the list is the landing page.
      { path: '', pathMatch: 'full', redirectTo: 'scenarios' },
      {
        path: 'scenarios',
        loadComponent: () =>
          import('./pages/admin/scenario-list/scenario-list.component').then(m => m.ScenarioListComponent),
      },
      {
        path: 'scenarios/:id/:tab',
        canDeactivate: [unsavedChangesGuard],
        loadComponent: () =>
          import('./pages/admin/scenario-edit/scenario-edit.component').then(m => m.ScenarioEditComponent),
      },
      { path: 'scenarios/:id', redirectTo: 'scenarios/:id/meta' },
      { path: 'upload', ...slot('Завантаження сценарію') },
      { path: 'queue', canActivate: [moderatorGuard], ...slot('Черга модерації') },
      { path: 'categories', canActivate: [moderatorGuard], ...slot('Напрями') },
      { path: 'access', canActivate: [moderatorGuard], ...slot('Доступ') },
      { path: '**', redirectTo: 'scenarios' },
    ],
  },
  {
    path: '**',
    redirectTo: 'catalog',
  },
];
