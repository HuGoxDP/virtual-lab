// path: src/app/app.config.ts

import { ApplicationConfig, provideZonelessChangeDetection } from '@angular/core';
import { provideRouter, withViewTransitions } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    // Stated explicitly rather than inherited from the absence of zone.js:
    // UI state is signal-based, and reintroducing zone.js must be a deliberate
    // decision instead of a silent change of change-detection semantics.
    provideZonelessChangeDetection(),
    provideRouter(routes, withViewTransitions()),
    provideHttpClient(),
  ],
};
