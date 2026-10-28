// path: src/app/pages/admin/check-list/check-list.component.spec.ts
//
// Test-plan scenario 219 (DW-6.2): the stored static checks read as a verdict and one row per check, with the
// level spelled out and the archive's own words shown as text.

import { TestBed } from '@angular/core/testing';

import { ArchiveChecks } from '../../../models/admin.model';
import { CheckListComponent, summarizeChecks } from './check-list.component';

const item = (level: 'ok' | 'warning' | 'error', label: string, note = '') => ({ level, label, note });

describe('summarizeChecks', () => {
  it('DW-6.2 says clean, counts warnings and counts errors with Ukrainian plurals', () => {
    expect(summarizeChecks({ ok: true, items: [item('ok', 'a')] })).toBe('Архів придатний до запуску');
    expect(summarizeChecks({ ok: true, items: [item('warning', 'a')] })).toBe('Архів придатний до запуску — 1 зауваження');
    expect(summarizeChecks({ ok: true, items: [item('warning', 'a'), item('warning', 'b')] })).toBe('Архів придатний до запуску — 2 зауваження');
    expect(summarizeChecks({ ok: true, items: Array.from({ length: 5 }, () => item('warning', 'w')) })).toContain('5 зауважень');
    expect(summarizeChecks({ ok: false, items: [item('error', 'x'), item('warning', 'w')] })).toBe('Архів не придатний до запуску — 1 помилка');
  });
});

describe('CheckListComponent', () => {
  function render(checks: ArchiveChecks): HTMLElement {
    const fixture = TestBed.createComponent(CheckListComponent);
    fixture.componentRef.setInput('checks', checks);
    fixture.detectChanges();
    return fixture.nativeElement;
  }

  it('DW-6.2 shows the verdict and one row per item, each with its level in words', () => {
    const root = render({ ok: true, items: [item('ok', 'Маніфест', 'id "alpha"'), item('warning', 'Версія рушія', 'не вказано'), item('error', 'Файли', 'порожньо')] });
    expect(root.querySelector('.verdict')?.textContent).toContain('1 помилка');
    const rows = [...root.querySelectorAll('[data-role="check-item"]')];
    expect(rows.map(r => r.className)).toEqual(['ok', 'warning', 'error']);
    expect(rows[1].textContent).toContain('Зауваження: Версія рушія');
    expect(rows[1].textContent).toContain('не вказано');
    expect(rows[2].textContent).toContain('Помилка: Файли');
  });

  it('DW-6.2 labels and notes from an archive render as text, never as markup', () => {
    const root = render({ ok: true, items: [item('ok', '<img src=x onerror=alert(1)>', '<script>alert(2)</script>')] });
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('script')).toBeNull();
    expect(root.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(root.textContent).toContain('<script>alert(2)</script>');
  });

  it('an item without a note draws no empty note line; an unknown level still renders', () => {
    const root = render({ ok: true, items: [item('ok', 'Тільки назва'), { level: 'info' as never, label: 'Новий рівень', note: '' }] });
    expect(root.querySelectorAll('.note').length).toBe(0);
    expect(root.querySelectorAll('[data-role="check-item"]').length).toBe(2);
  });
});
