// path: src/app/app.routes.ts

import { Routes } from '@angular/router';

import { adminGuard, loginGuard, moderatorGuard, unsavedChangesGuard } from './pages/admin/admin-guards';

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
  // The admin. Sign-in sits outside the shell (own layout); everything else is a child of it.
  {
    path: 'admin/login',
    canActivate: [loginGuard],
    loadComponent: () =>
      import('./pages/admin/admin-login.component').then(m => m.AdminLoginComponent),
  },
  {
    path: 'admin',
    canActivate: [adminGuard],
    loadComponent: () =>
      import('./pages/admin/admin-shell/admin-shell.component').then(m => m.AdminShellComponent),
    children: [
      {
        path: '',
        pathMatch: 'full',
        loadComponent: () =>
          import('./pages/admin/dashboard/dashboard.component').then(m => m.DashboardComponent),
      },
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
      {
        path: 'upload',
        canDeactivate: [unsavedChangesGuard],
        loadComponent: () =>
          import('./pages/admin/upload-wizard/upload-wizard.component').then(m => m.UploadWizardComponent),
      },
      {
        path: 'queue',
        canActivate: [moderatorGuard],
        loadComponent: () => import('./pages/admin/queue/queue.component').then(m => m.QueueComponent),
      },
      {
        path: 'categories',
        canActivate: [moderatorGuard],
        loadComponent: () => import('./pages/admin/categories/categories.component').then(m => m.CategoriesComponent),
      },
      {
        path: 'access',
        canActivate: [moderatorGuard],
        loadComponent: () => import('./pages/admin/access/access.component').then(m => m.AccessComponent),
      },
      { path: '**', redirectTo: 'scenarios' },
    ],
  },
  {
    path: '**',
    redirectTo: 'catalog',
  },
];
