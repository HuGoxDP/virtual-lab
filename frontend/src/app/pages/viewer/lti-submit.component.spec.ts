// path: src/app/pages/viewer/lti-submit.component.spec.ts
//
// The viewer's LTI controls with a fake LtiService. DW-6.1: both button kinds, the confirmation, the
// submitted state, the instructor view, an expired session, 409, 502 and a double click.

import { ComponentFixture, TestBed } from '@angular/core/testing';

import { LtiSession } from '../../models/lti.model';
import { LtiRequestError, LtiService } from '../../services/lti.service';
import { LtiResult, LtiSubmitComponent, toPoints } from './lti-submit.component';

const LEARNER: LtiSession = { scenarioId: 'electric-circuits', role: 'learner', messageType: 'resource', graded: true, submitted: null };

interface Deferred<T> { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type Fixture = ComponentFixture<LtiSubmitComponent>;

function setup(session: Promise<LtiSession> | LtiSession, result: LtiResult | null = null) {
  const lti = {
    getSession: vi.fn(async () => session),
    submit: vi.fn(async (_score?: number) => ({ score: 1 })),
  };
  TestBed.configureTestingModule({ providers: [{ provide: LtiService, useValue: lti }] });
  const fixture = TestBed.createComponent(LtiSubmitComponent);
  fixture.componentRef.setInput('result', result);
  fixture.detectChanges();
  return { fixture, lti };
}

const el = (f: Fixture) => f.nativeElement as HTMLElement;
const q = (f: Fixture, sel: string) => el(f).querySelector<HTMLElement>(sel);
const text = (f: Fixture) => (el(f).textContent ?? '').replace(/\s+/g, ' ').trim();

async function settle(fixture: Fixture) {
  await fixture.whenStable();
  await Promise.resolve();
  fixture.detectChanges();
}
const loaded = async (session: LtiSession, result: LtiResult | null = null) => {
  const ctx = setup(session, result);
  await settle(ctx.fixture);
  return ctx;
};
async function failedSession(status: number) {
  const lti = { getSession: vi.fn().mockRejectedValue(new LtiRequestError('x', status)), submit: vi.fn() };
  TestBed.configureTestingModule({ providers: [{ provide: LtiService, useValue: lti }] });
  const fixture = TestBed.createComponent(LtiSubmitComponent);
  fixture.detectChanges();
  await settle(fixture);
  return fixture;
}

describe('LtiSubmitComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('shows nothing while the session loads', () => {
    const { fixture } = setup(deferred<LtiSession>().promise);
    expect(el(fixture).querySelector('button')).toBeNull();
    expect(text(fixture)).toBe('');
  });

  describe('graded scenario', () => {
    it('DW-6.1 shows «Здати»; pressing it asks for confirmation with the score and sends nothing yet', async () => {
      const { fixture, lti } = await loaded(LEARNER, { score: 0.85, completed: true });
      expect(q(fixture, '.lti-submit')!.textContent!.trim()).toBe('Здати');

      q(fixture, '.lti-submit')!.click();
      fixture.detectChanges();

      expect(text(fixture)).toContain('Ваш результат: 85 з 100');
      expect(q(fixture, '.lti-confirm-yes')).not.toBeNull();
      expect(lti.submit).not.toHaveBeenCalled();
    });

    it('DW-6.1 confirming sends the reported score and shows «Роботу здано, оцінка X з 100» with no button', async () => {
      const { fixture, lti } = await loaded(LEARNER, { score: 0.85, completed: true });
      lti.submit.mockResolvedValue({ score: 0.85 });
      q(fixture, '.lti-submit')!.click();
      fixture.detectChanges();
      q(fixture, '.lti-confirm-yes')!.click();
      await settle(fixture);

      expect(lti.submit).toHaveBeenCalledExactlyOnceWith(0.85);
      expect(text(fixture)).toBe('Роботу здано, оцінка 85 з 100');
      expect(el(fixture).querySelector('button')).toBeNull();
    });

    it('cancelling the confirmation goes back to the button without a request', async () => {
      const { fixture, lti } = await loaded(LEARNER, { score: 0.5, completed: false });
      q(fixture, '.lti-submit')!.click();
      fixture.detectChanges();
      q(fixture, '.lti-confirm-no')!.click();
      fixture.detectChanges();

      expect(q(fixture, '.lti-submit')).not.toBeNull();
      expect(q(fixture, '.lti-confirm')).toBeNull();
      expect(lti.submit).not.toHaveBeenCalled();
    });

    it('without a reported result the confirmation says 0 and the request carries no score', async () => {
      const { fixture, lti } = await loaded(LEARNER, null);
      q(fixture, '.lti-submit')!.click();
      fixture.detectChanges();
      expect(text(fixture)).toContain('буде надіслано 0 з 100');

      q(fixture, '.lti-confirm-yes')!.click();
      await settle(fixture);
      expect(lti.submit).toHaveBeenCalledExactlyOnceWith(undefined);
    });

    it('the confirmation follows the latest score the viewer passes in', async () => {
      const { fixture } = await loaded(LEARNER, { score: 0.2, completed: false });
      fixture.componentRef.setInput('result', { score: 0.6, completed: true });
      q(fixture, '.lti-submit')!.click();
      fixture.detectChanges();
      expect(text(fixture)).toContain('Ваш результат: 60 з 100');
    });
  });

  describe('non-graded scenario', () => {
    it('DW-6.1 shows «Завершити» and submits at once, with no confirmation and no score', async () => {
      const { fixture, lti } = await loaded({ ...LEARNER, graded: false }, { score: 0.3, completed: true });
      expect(q(fixture, '.lti-submit')!.textContent!.trim()).toBe('Завершити');

      lti.submit.mockResolvedValue({ score: 1 });
      q(fixture, '.lti-submit')!.click();
      expect(q(fixture, '.lti-confirm')).toBeNull();
      await settle(fixture);

      expect(lti.submit).toHaveBeenCalledExactlyOnceWith(undefined);
      expect(text(fixture)).toBe('Роботу здано, оцінка 100 з 100');
    });
  });

  describe('session states', () => {
    it('DW-6.1 an already submitted launch shows the grade and no button', async () => {
      const { fixture } = await loaded({ ...LEARNER, submitted: { score: 0.7 } });
      expect(text(fixture)).toBe('Роботу здано, оцінка 70 з 100');
      expect(el(fixture).querySelector('button')).toBeNull();
    });

    it('DW-6.1 the instructor gets view mode and no button', async () => {
      const { fixture } = await loaded({ ...LEARNER, role: 'instructor' });
      expect(text(fixture)).toContain('Режим перегляду');
      expect(el(fixture).querySelector('button')).toBeNull();
    });

    it('a deep-linking session is also view-only', async () => {
      const { fixture } = await loaded({ ...LEARNER, messageType: 'deep-link', scenarioId: null });
      expect(el(fixture).querySelector('button')).toBeNull();
    });

    it('DW-6.1 an expired session (401) explains itself in Ukrainian with no button', async () => {
      const fixture = await failedSession(401);
      expect(text(fixture)).toContain('Сесію Moodle завершено');
      expect(q(fixture, '[role=alert]')).not.toBeNull();
      expect(el(fixture).querySelector('button')).toBeNull();
    });

    it('any other session failure shows a message and no button', async () => {
      const fixture = await failedSession(500);
      expect(text(fixture)).toContain('Не вдалося отримати дані сесії Moodle');
      expect(el(fixture).querySelector('button')).toBeNull();
    });
  });

  describe('submit outcomes', () => {
    it('DW-6.1 a 409 shows the submitted state with the score the server returned', async () => {
      const { fixture, lti } = await loaded({ ...LEARNER, graded: false });
      lti.submit.mockRejectedValue(new LtiRequestError('Роботу вже здано', 409, 0.85));
      q(fixture, '.lti-submit')!.click();
      await settle(fixture);

      expect(text(fixture)).toBe('Роботу здано, оцінка 85 з 100');
      expect(el(fixture).querySelector('button')).toBeNull();
    });

    it('a 409 without a score still shows «Роботу здано», just without a grade', async () => {
      const { fixture, lti } = await loaded({ ...LEARNER, graded: false });
      lti.submit.mockRejectedValue(new LtiRequestError('Роботу вже здано', 409));
      q(fixture, '.lti-submit')!.click();
      await settle(fixture);

      expect(text(fixture)).toBe('Роботу здано');
    });

    it('DW-6.1 a 502 shows the server message and re-enables the button for a retry that can succeed', async () => {
      const { fixture, lti } = await loaded({ ...LEARNER, graded: false });
      lti.submit.mockRejectedValueOnce(new LtiRequestError('Moodle недоступний', 502));
      q(fixture, '.lti-submit')!.click();
      await settle(fixture);

      expect(q(fixture, '.lti-error')!.textContent).toContain('Moodle недоступний');
      const button = q(fixture, '.lti-submit') as HTMLButtonElement;
      expect(button.disabled).toBe(false);

      lti.submit.mockResolvedValueOnce({ score: 1 });
      button.click();
      await settle(fixture);
      expect(lti.submit).toHaveBeenCalledTimes(2);
      expect(text(fixture)).toBe('Роботу здано, оцінка 100 з 100');
    });

    it('a graded 502 returns to the button, not the confirmation, and keeps the error', async () => {
      const { fixture, lti } = await loaded(LEARNER, { score: 0.4, completed: true });
      lti.submit.mockRejectedValue(new LtiRequestError('Moodle недоступний', 502));
      q(fixture, '.lti-submit')!.click();
      fixture.detectChanges();
      q(fixture, '.lti-confirm-yes')!.click();
      await settle(fixture);

      expect(q(fixture, '.lti-submit')).not.toBeNull();
      expect(q(fixture, '.lti-error')).not.toBeNull();
    });

    it('a failure that is not a LtiRequestError gets a generic message', async () => {
      const { fixture, lti } = await loaded({ ...LEARNER, graded: false });
      lti.submit.mockRejectedValue(new Error('boom'));
      q(fixture, '.lti-submit')!.click();
      await settle(fixture);
      expect(q(fixture, '.lti-error')!.textContent).toContain('Не вдалося передати роботу');
    });

    it('a 401 on submit turns into the expired-session message', async () => {
      const { fixture, lti } = await loaded({ ...LEARNER, graded: false });
      lti.submit.mockRejectedValue(new LtiRequestError('Немає сесії', 401));
      q(fixture, '.lti-submit')!.click();
      await settle(fixture);

      expect(text(fixture)).toContain('Сесію Moodle завершено');
      expect(el(fixture).querySelector('button')).toBeNull();
    });

    it('DW-6.1 a double click sends one request and disables the button while it is in flight', async () => {
      const { fixture, lti } = await loaded({ ...LEARNER, graded: false });
      const pending = deferred<{ score: number }>();
      lti.submit.mockReturnValue(pending.promise);

      const button = q(fixture, '.lti-submit') as HTMLButtonElement;
      button.click();
      button.click();
      fixture.detectChanges();
      expect(lti.submit).toHaveBeenCalledTimes(1);
      expect(button.disabled).toBe(true);

      pending.resolve({ score: 1 });
      await settle(fixture);
      expect(lti.submit).toHaveBeenCalledTimes(1);
    });

    it('a double click on «Так, здати» also sends one request', async () => {
      const { fixture, lti } = await loaded(LEARNER, { score: 0.9, completed: true });
      const pending = deferred<{ score: number }>();
      lti.submit.mockReturnValue(pending.promise);
      q(fixture, '.lti-submit')!.click();
      fixture.detectChanges();

      const yes = q(fixture, '.lti-confirm-yes') as HTMLButtonElement;
      yes.click();
      yes.click();
      expect(lti.submit).toHaveBeenCalledTimes(1);
      pending.resolve({ score: 0.9 });
      await settle(fixture);
    });
  });

  describe('toPoints', () => {
    it.each([
      [0.855, 86], [0, 0], [1, 100], [-1, 0], [7, 100], [Number.NaN, 0],
    ])('%s -> %s', (score, points) => expect(toPoints(score)).toBe(points));
  });
});
