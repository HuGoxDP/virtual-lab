// path: src/app/ui/status-pill/status-pill.component.spec.ts
//
// Test-plan scenario 210 (DW-5.2): every status reads as an icon plus its Ukrainian label, never colour alone.

import { TestBed } from '@angular/core/testing';

import { StatusPillComponent } from './status-pill.component';

function render(status: string): HTMLElement {
  const fixture = TestBed.createComponent(StatusPillComponent);
  fixture.componentRef.setInput('status', status);
  fixture.detectChanges();
  return fixture.nativeElement;
}

describe('StatusPillComponent', () => {
  it.each([
    ['published', 'Опубліковано'],
    ['review', 'На перевірці'],
    ['draft', 'Чернетка'],
    ['rejected', 'На доопрацюванні'],
  ])('DW-5.2 %s reads "%s" with an icon', (status, label) => {
    const root = render(status);
    expect(root.textContent?.trim()).toBe(label);
    expect(root.querySelector('vl-icon svg path')).not.toBeNull();
  });

  it('DW-5.2 an unknown status shows its raw name instead of a blank pill', () => {
    expect(render('archived').textContent?.trim()).toBe('archived');
  });
});
