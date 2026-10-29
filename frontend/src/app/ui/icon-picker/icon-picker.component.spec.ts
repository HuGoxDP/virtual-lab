// path: src/app/ui/icon-picker/icon-picker.component.spec.ts
//
// Test-plan scenario 211 (DW-5.3): the icon picker for "Що всередині" offers exactly the hosted icons.

import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ICON_NAMES } from '../icon/icon.component';
import { IconPickerComponent } from './icon-picker.component';

describe('IconPickerComponent', () => {
  let fixture: ComponentFixture<IconPickerComponent>;
  let root: HTMLElement;
  let chosen: string[];

  beforeEach(async () => {
    fixture = TestBed.createComponent(IconPickerComponent);
    chosen = [];
    fixture.componentInstance.valueChange.subscribe(name => chosen.push(name));
    fixture.componentRef.setInput('value', 'atom');
    fixture.componentRef.setInput('label', 'Іконка пункту 1');
    fixture.detectChanges();
    root = fixture.nativeElement;
  });

  const trigger = () => root.querySelector<HTMLButtonElement>('.trigger')!;
  const options = () => [...root.querySelectorAll<HTMLButtonElement>('.option')];
  const open = () => { trigger().click(); fixture.detectChanges(); };

  it('DW-5.3 is closed at first and names itself and the current icon for assistive tech', () => {
    expect(options().length).toBe(0);
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(trigger().getAttribute('aria-label')).toBe('Іконка пункту 1: atom');
  });

  it('DW-5.3 opens a grid with every hosted icon and marks the current one', () => {
    open();
    expect(options().map(o => o.getAttribute('aria-label'))).toEqual([...ICON_NAMES]);
    expect(options().filter(o => o.getAttribute('aria-pressed') === 'true').map(o => o.title)).toEqual(['atom']);
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
  });

  it('DW-5.3 choosing an icon emits it once and closes the grid', () => {
    open();
    options().find(o => o.title === 'flask')!.click();
    fixture.detectChanges();
    expect(chosen).toEqual(['flask']);
    expect(options().length).toBe(0);
  });

  it('Escape and a click outside close it without a change', () => {
    open();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(options().length).toBe(0);

    open();
    document.body.click();
    fixture.detectChanges();
    expect(options().length).toBe(0);
    expect(chosen).toEqual([]);
  });

  it('a click inside it does not close it; the trigger toggles', () => {
    open();
    root.querySelector<HTMLElement>('.grid')!.click();
    fixture.detectChanges();
    expect(options().length).toBeGreaterThan(0);
    trigger().click();
    fixture.detectChanges();
    expect(options().length).toBe(0);
  });

  it('a value the set does not contain selects nothing and does not throw', () => {
    fixture.componentRef.setInput('value', 'not-an-icon');
    fixture.detectChanges();
    open();
    expect(options().some(o => o.getAttribute('aria-pressed') === 'true')).toBe(false);
  });
});
