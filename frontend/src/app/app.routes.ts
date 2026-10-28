// path: src/app/app.routes.ts

import { Routes } from '@angular/router';

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
  {
    path: 'lti/pick',
    loadComponent: () =>
      import('./pages/lti-pick/lti-pick.component').then(m => m.LtiPickComponent),
  },
  {
    path: 'admin',
    loadComponent: () =>
      import('./pages/admin/admin.component').then(m => m.AdminComponent),
  },
  {
    path: '**',
    redirectTo: 'catalog',
  },
];
