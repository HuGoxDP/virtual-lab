// path: src/app/pages/admin/admin-slot.component.ts

import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

/**
 * A section of the admin frame whose screen belongs to a later phase (upload, queue, categories,
 * access): reachable and role-guarded, saying so instead of 404ing. The route's `data.title` names it.
 */
@Component({
  selector: 'vl-admin-slot',
  standalone: true,
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    h1 { margin: 0 0 var(--space-3); font-size: 26px; }
    p { margin: 0 0 var(--space-4); color: color-mix(in srgb, var(--color-text) 70%, transparent); }
  `,
  template: `
    <h1>{{ title }}</h1>
    <p>Цей розділ зʼявиться в одному з наступних оновлень.</p>
    <a class="btn btn-secondary" routerLink="/admin/scenarios">До списку сценаріїв</a>
  `,
})
export class AdminSlotComponent {
  protected readonly title: string = inject(ActivatedRoute).snapshot.data['title'] ?? '';
}
