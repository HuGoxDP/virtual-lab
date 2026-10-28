// path: src/app/pages/admin/scenario-rules.spec.ts
//
// Test-plan scenario 212 (DW-5.3, DW-5.4): which transitions a role is offered, what the readiness list
// reports, how a journal row reads. Scenario 217 (DW-6.2): a stored test run read against the norms.

import { CurrentVersionSummary } from '../../models/scenario.model';
import { LARGE_ARCHIVE_BYTES, describeEvent, reviewChips, evaluateTestRun, isReady, readiness, statusMeta, STATUS_META, STATUS_ORDER, TEST_NORMS, transitionsFor } from './scenario-rules';

const actions = (role: 'author' | 'moderator', status: Parameters<typeof transitionsFor>[1], archive = true) =>
  transitionsFor(role, status, archive).map(spec => spec.action);

describe('transitionsFor', () => {
  it('DW-5.4 an author submits a draft or a returned scenario, and withdraws one in review', () => {
    expect(actions('author', 'draft')).toEqual(['submit']);
    expect(actions('author', 'rejected')).toEqual(['submit']);
    expect(actions('author', 'review')).toEqual(['withdraw']);
  });

  it('DW-5.4 an author has no action on a published scenario', () => {
    expect(actions('author', 'published')).toEqual([]);
  });

  it('DW-5.4 a moderator publishes review/draft/returned, returns one in review, unpublishes a published one', () => {
    expect(actions('moderator', 'review')).toEqual(['approve', 'reject', 'withdraw']);
    expect(actions('moderator', 'draft')).toEqual(['approve', 'submit']);
    expect(actions('moderator', 'rejected')).toEqual(['approve', 'submit']);
    expect(actions('moderator', 'published')).toEqual(['unpublish']);
  });

  it('DW-5.4 returning needs a note, unpublishing asks first, publishing is the primary button', () => {
    const review = transitionsFor('moderator', 'review', true);
    expect(review.find(s => s.action === 'reject')?.needsNote).toBe(true);
    expect(review.find(s => s.action === 'approve')?.primary).toBe(true);
    expect(transitionsFor('moderator', 'published', true)[0].confirm).toMatch(/Зняти/);
  });

  it('DW-5.4 a moderator also gets the owner moves, as secondary buttons; an author never gets moderator ones', () => {
    expect(transitionsFor('moderator', 'draft', true).find(s => s.action === 'submit')?.primary).toBe(false);
    expect(transitionsFor('author', 'draft', true).find(s => s.action === 'submit')?.primary).toBe(true);
    for (const status of ['draft', 'review', 'published', 'rejected'] as const) {
      expect(actions('author', status)).not.toContain('approve');
      expect(actions('author', status)).not.toContain('reject');
      expect(actions('author', status)).not.toContain('unpublish');
    }
  });

  it('submit and publish are drawn disabled, with the reason, when there is no archive', () => {
    const [submit] = transitionsFor('author', 'draft', false);
    expect(submit.disabledReason).toMatch(/архів/);
    const [approve] = transitionsFor('moderator', 'draft', false);
    expect(approve.disabledReason).toMatch(/архів/);
    // withdraw / reject / unpublish never depend on an archive
    expect(transitionsFor('author', 'review', false)[0].disabledReason).toBeUndefined();
  });
});

describe('statusMeta', () => {
  it('covers the four statuses with the prototype labels, in chip order', () => {
    expect(STATUS_ORDER.map(s => STATUS_META[s].label)).toEqual(['Опубліковано', 'На перевірці', 'Чернетка', 'На доопрацюванні']);
  });

  it('is total: an unknown status shows its raw name and never throws', () => {
    expect(statusMeta('archived').label).toBe('archived');
    expect(statusMeta('').label).toBe('—');
    expect(statusMeta('__proto__').label).toBe('__proto__');
  });
});

describe('readiness', () => {
  const version = (overrides: Partial<CurrentVersionSummary> = {}): CurrentVersionSummary => ({
    id: 1, sha256: 'a'.repeat(64), bytes: 1, checked: true, checks: { errors: 0, warnings: 0 }, ...overrides,
  });
  const byKey = (items: ReturnType<typeof readiness>) => Object.fromEntries(items.map(i => [i.key, i]));

  it('DW-5.3 everything present and checked is ready', () => {
    const items = readiness({ description: 'Опис', imageUrl: '/previews/x.png', currentVersion: version() });
    expect(isReady(items)).toBe(true);
    expect(items.map(i => i.label)).toEqual(['Архів перевірено', 'Короткий опис заповнено', 'Превʼю додано']);
  });

  it('DW-5.3 a missing archive, description and preview are each reported', () => {
    const items = byKey(readiness({ description: '   ', imageUrl: '', currentVersion: null, archiveSha256: null }));
    expect(items['archive']).toMatchObject({ level: 'bad', label: 'Немає архіву' });
    expect(items['description']).toMatchObject({ level: 'bad', label: 'Немає короткого опису' });
    expect(items['preview']).toMatchObject({ level: 'bad', label: 'Немає превʼю' });
    expect(isReady(Object.values(items))).toBe(false);
  });

  it('DW-5.3 check errors are bad, warnings are a warning, an unchecked archive is not shown as clean', () => {
    const base = { description: 'x', imageUrl: 'y' };
    expect(byKey(readiness({ ...base, currentVersion: version({ checks: { errors: 2, warnings: 0 } }) }))['archive'])
      .toMatchObject({ level: 'bad', label: 'Автоперевірка: 2 помилки' });
    expect(byKey(readiness({ ...base, currentVersion: version({ checks: { errors: 5, warnings: 0 } }) }))['archive'].label)
      .toBe('Автоперевірка: 5 помилок');
    expect(byKey(readiness({ ...base, currentVersion: version({ checks: { errors: 0, warnings: 1 } }) }))['archive'])
      .toMatchObject({ level: 'warn', label: 'Архів перевірено: 1 попередження' });
    expect(byKey(readiness({ ...base, currentVersion: version({ checked: false }) }))['archive'])
      .toMatchObject({ level: 'warn', label: 'Архів ще не перевірено' });
  });

  it('a legacy row with a hash but no version summary is "not checked", not "missing"', () => {
    expect(byKey(readiness({ description: 'x', imageUrl: 'y', currentVersion: null, archiveSha256: 'b'.repeat(64) }))['archive'].level).toBe('warn');
  });
});

describe('describeEvent', () => {
  it('DW-5.4 reads the workflow actions as sentences, with a moderator note', () => {
    expect(describeEvent({ action: 'scenario.submit', details: { from: 'draft', to: 'review' } }).text).toBe('Надіслано на модерацію');
    expect(describeEvent({ action: 'scenario.approve', details: null }).text).toBe('Опубліковано в каталозі');
    expect(describeEvent({ action: 'scenario.unpublish', details: null }).text).toBe('Знято з публікації');
    const rejected = describeEvent({ action: 'scenario.reject', details: { note: 'Немає опису' } });
    expect(rejected.text).toBe('Повернуто на доопрацювання');
    expect(rejected.note).toBe('Немає опису');
  });

  it('names the fields an update changed, in Ukrainian', () => {
    expect(describeEvent({ action: 'scenario.update', details: { fields: ['title', 'features'] } }).text)
      .toBe('Оновлено: назву, «Що всередині»');
    expect(describeEvent({ action: 'scenario.update', details: { fields: ['somethingNew'] } }).text).toBe('Оновлено: somethingNew');
    expect(describeEvent({ action: 'scenario.update', details: null }).text).toBe('Оновлено сценарій');
  });

  it('DW-7.2 reads the category and access-code journal rows the dashboard lists', () => {
    expect(describeEvent({ action: 'category.create', details: { slug: 'x' } }).text).toBe('Додано категорію');
    expect(describeEvent({ action: 'category.reorder', details: null }).text).toBe('Змінено порядок категорій');
    expect(describeEvent({ action: 'category.delete', details: null }).text).toBe('Видалено категорію');
    expect(describeEvent({ action: 'key.create', details: { label: 'Олена' } }).text).toBe('Видано код доступу');
    expect(describeEvent({ action: 'key.revoke', details: null }).text).toBe('Відкликано код доступу');
  });

  it('an action it has no sentence for shows its name instead of nothing; a non-string note is ignored', () => {
    expect(describeEvent({ action: 'brand.new', details: { note: 42 } })).toEqual({ icon: 'info', text: 'brand.new' });
    expect(describeEvent({ action: 'constructor', details: null }).text).toBe('constructor');
  });
});

describe('evaluateTestRun (DW-6.2)', () => {
  const GIB = 1024 ** 3;
  const run = { timeToFirstFrameMs: 3800, avgFps: 58, gpuMemoryBytes: 1.4 * GIB, consoleErrors: 0 };
  const byKey = (rows: ReturnType<typeof evaluateTestRun>) => Object.fromEntries(rows.map(r => [r.key, r]));

  it('DW-6.2 the norms are 5 s, 30 FPS, 1 GB and no errors', () => {
    expect(TEST_NORMS).toEqual({ maxFirstFrameMs: 5000, minFps: 30, maxGpuBytes: GIB, maxConsoleErrors: 0 });
  });

  it('DW-6.2 shows each figure with its norm and whether it holds (GPU over the limit here)', () => {
    const rows = byKey(evaluateTestRun(run));
    expect(rows['firstFrame']).toMatchObject({ value: '3,8 с', norm: 'до 5 с', ok: true });
    expect(rows['fps']).toMatchObject({ value: '58', norm: 'від 30', ok: true });
    expect(rows['gpu']).toMatchObject({ value: '1,4 ГБ', norm: 'до 1 ГБ', ok: false });
    expect(rows['errors']).toMatchObject({ value: '0', norm: '0', ok: true });
  });

  it('DW-6.2 the limits are inclusive: exactly 5 s, 30 FPS and 1 GB pass; one step beyond fails', () => {
    const edge = byKey(evaluateTestRun({ timeToFirstFrameMs: 5000, avgFps: 30, gpuMemoryBytes: GIB, consoleErrors: 0 }));
    expect(Object.values(edge).map(r => r.ok)).toEqual([true, true, true, true]);

    const over = byKey(evaluateTestRun({ timeToFirstFrameMs: 5001, avgFps: 29.9, gpuMemoryBytes: GIB + 1, consoleErrors: 1 }));
    expect(Object.values(over).map(r => r.ok)).toEqual([false, false, false, false]);
  });

  it('DW-6.2 a failed run has no rows (the error is shown instead)', () => {
    expect(evaluateTestRun({ error: 'WebGL недоступний' })).toEqual([]);
  });

  it('a report missing a figure shows a dash and no verdict rather than a pass', () => {
    const rows = byKey(evaluateTestRun({ avgFps: 60 }));
    expect(rows['firstFrame']).toMatchObject({ value: '—', ok: null });
    expect(rows['fps'].ok).toBe(true);
  });
});

describe('reviewChips (DW-7.1)', () => {
  const ready = { description: 'Опис', imageUrl: '/previews/a.png', archiveSha256: 'a'.repeat(64),
    currentVersion: { id: 1, sha256: 'a'.repeat(64), bytes: 1000, checked: true, checks: { errors: 0, warnings: 0 } } };

  it('lists every readiness item, passes included', () => {
    expect(reviewChips(ready).map(chip => chip.level)).toEqual(['ok', 'ok', 'ok']);
  });

  it('flags a missing description and preview as problems, in the readiness order', () => {
    const chips = reviewChips({ ...ready, description: '  ', imageUrl: '' });
    expect(chips.map(chip => [chip.label, chip.level])).toEqual([
      ['Архів перевірено', 'ok'], ['Немає короткого опису', 'bad'], ['Немає превʼю', 'bad'],
    ]);
  });

  it('shows the check counts of the archive', () => {
    const withErrors = { ...ready, currentVersion: { ...ready.currentVersion, checks: { errors: 2, warnings: 0 } } };
    expect(reviewChips(withErrors)[0]).toEqual({ level: 'bad', label: 'Автоперевірка: 2 помилки' });
  });

  it('adds «Великий архів» only above the limit', () => {
    const big = (bytes: number) => reviewChips({ ...ready, currentVersion: { ...ready.currentVersion, bytes } }).some(chip => chip.label === 'Великий архів');
    expect(big(LARGE_ARCHIVE_BYTES)).toBe(false);
    expect(big(LARGE_ARCHIVE_BYTES + 1)).toBe(true);
  });

  it('falls back to the archive size when no version summary exists', () => {
    const chips = reviewChips({ description: 'x', imageUrl: '/p.png', archiveSha256: 'a'.repeat(64), archiveBytes: LARGE_ARCHIVE_BYTES + 5 });
    expect(chips.at(-1)?.label).toBe('Великий архів');
  });
});
