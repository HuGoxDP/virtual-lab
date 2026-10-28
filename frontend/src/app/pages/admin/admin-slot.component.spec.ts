// path: src/app/pages/admin/admin-slot.component.spec.ts
//
// Test-plan scenario 209 (DW-5.1): a section whose screen comes later is reachable, titled by its route, and links back.

import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';

import { AdminSlotComponent } from './admin-slot.component';

function render(data: Record<string, unknown>): HTMLElement {
  TestBed.configureTestingModule({
    providers: [provideRouter([]), { provide: ActivatedRoute, useValue: { snapshot: { data } } }],
  });
  const fixture = TestBed.createComponent(AdminSlotComponent);
  fixture.detectChanges();
  return fixture.nativeElement;
}

describe('AdminSlotComponent', () => {
  it('DW-5.1 shows the route\'s title, says it comes later and links to the list', () => {
    const root = render({ title: 'Черга модерації' });
    expect(root.querySelector('h1')?.textContent).toBe('Черга модерації');
    expect(root.textContent).toContain('зʼявиться в одному з наступних оновлень');
    expect(root.querySelector('a')?.getAttribute('href')).toBe('/admin/scenarios');
  });

  it('a route without a title renders an empty heading rather than throwing', () => {
    expect(render({}).querySelector('h1')?.textContent).toBe('');
  });
});
