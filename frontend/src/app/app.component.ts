// path: src/app/app.component.ts

import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { ToastHostComponent } from './ui/toast/toast-host.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, ToastHostComponent],
  template: '<router-outlet /><vl-toast-host />',
})
export class AppComponent {}
