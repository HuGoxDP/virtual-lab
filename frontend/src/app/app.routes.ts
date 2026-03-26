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
    path: 'play/:id',
    loadComponent: () =>
      import('./pages/viewer/viewer.component').then(m => m.ViewerComponent),
  },
  {
    path: '**',
    redirectTo: 'catalog',
  },
];
