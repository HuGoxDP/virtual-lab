// path: src/app/pages/admin/scenario-rules.ts
//
// What the admin screens know about a scenario's workflow, in one place: how a status looks, which
// transitions a role is offered, what "ready to publish" means, and how a journal row reads. The
// server stays the authority (`backend/workflow.js` TRANSITIONS); these tables only decide which
// buttons to draw, and a button the server refuses shows the server's own message.

import { AuditRow, AdminRole, TransitionAction } from '../../models/admin.model';
import { CurrentVersionSummary, ScenarioStatus } from '../../models/scenario.model';
import { pluralUk } from '../../ui/format';

export { STATUS_META, STATUS_ORDER, statusMeta } from '../../ui/status-pill/status-meta';

// ==================== TRANSITIONS ====================

export interface TransitionSpec {
  action: TransitionAction;
  label: string;
  /** The main button of the screen (accent outline). */
  primary?: boolean;
  /** A moderator's reason is collected before this action. */
  needsNote?: boolean;
  /** Asked before it runs. */
  confirm?: string;
  /** Why the button is drawn but not usable. */
  disabledReason?: string;
}

const NO_ARCHIVE = 'Спершу завантажте архів сценарію.';

/**
 * The transitions to offer `role` on a scenario in `status`, mirroring the backend's table. Owner moves:
 * submit (draft, returned) and withdraw (in review). Moderator moves: publish (in review, draft, returned),
 * return with a note (in review) and unpublish (published). A moderator may also make the owner moves, so
 * they get both, theirs first. Submit and publish need an archive and are drawn disabled, with the reason,
 * without one.
 */
export function transitionsFor(role: AdminRole, status: ScenarioStatus, hasArchive: boolean): TransitionSpec[] {
  const needsArchive = hasArchive ? {} : { disabledReason: NO_ARCHIVE };
  const moderator = role === 'moderator';

  const specs: TransitionSpec[] = [];
  if (moderator && (status === 'review' || status === 'draft' || status === 'rejected')) {
    specs.push({ action: 'approve', label: 'Опублікувати', primary: true, ...needsArchive });
  }
  if (moderator && status === 'review') {
    specs.push({ action: 'reject', label: 'Повернути на доопрацювання', needsNote: true });
  }
  if (moderator && status === 'published') {
    specs.push({
      action: 'unpublish', label: 'Зняти з публікації',
      confirm: 'Зняти сценарій з публікації? Він зникне з каталогу й стане чернеткою.',
    });
  }
  if (status === 'draft' || status === 'rejected') {
    specs.push({ action: 'submit', label: 'Подати на перевірку', primary: !moderator, ...needsArchive });
  }
  if (status === 'review') specs.push({ action: 'withdraw', label: 'Відкликати з перевірки' });
  return specs;
}

// ==================== READINESS ====================

export type ReadinessLevel = 'ok' | 'warn' | 'bad';

export interface ReadinessItem {
  key: 'archive' | 'description' | 'preview';
  level: ReadinessLevel;
  label: string;
}

export interface ReadinessInput {
  description: string;
  imageUrl: string;
  currentVersion?: CurrentVersionSummary | null;
  archiveSha256?: string | null;
}

/** «Готовність до публікації»: what the student would find missing, in the order the prototype lists it. */
export function readiness(input: ReadinessInput): ReadinessItem[] {
  return [archiveItem(input), descriptionItem(input), previewItem(input)];
}

/** Every item is fine. */
export const isReady = (items: ReadinessItem[]): boolean => items.every(item => item.level === 'ok');

function archiveItem({ currentVersion, archiveSha256 }: ReadinessInput): ReadinessItem {
  const item = (level: ReadinessLevel, label: string): ReadinessItem => ({ key: 'archive', level, label });
  if (!currentVersion && !archiveSha256) return item('bad', 'Немає архіву');
  if (!currentVersion?.checked) return item('warn', 'Архів ще не перевірено');

  const { errors, warnings } = currentVersion.checks;
  if (errors > 0) return item('bad', `Автоперевірка: ${errors} ${pluralUk(errors, ['помилка', 'помилки', 'помилок'])}`);
  if (warnings > 0) return item('warn', `Архів перевірено: ${warnings} ${pluralUk(warnings, ['попередження', 'попередження', 'попереджень'])}`);
  return item('ok', 'Архів перевірено');
}

function descriptionItem({ description }: ReadinessInput): ReadinessItem {
  return description.trim()
    ? { key: 'description', level: 'ok', label: 'Короткий опис заповнено' }
    : { key: 'description', level: 'bad', label: 'Немає короткого опису' };
}

function previewItem({ imageUrl }: ReadinessInput): ReadinessItem {
  return imageUrl
    ? { key: 'preview', level: 'ok', label: 'Превʼю додано' }
    : { key: 'preview', level: 'bad', label: 'Немає превʼю' };
}

// ==================== JOURNAL ====================

export interface EventView {
  icon: string;
  /** What happened, without the actor. */
  text: string;
  /** A moderator's reason, when the row carries one. */
  note?: string;
}

const FIELD_NAMES: Readonly<Record<string, string>> = {
  title: 'назву', description: 'короткий опис', fullDescription: 'повний опис', category: 'категорію',
  categoryLabel: 'підпис категорії', imageUrl: 'превʼю', scenarioUrl: 'архів', manifestUrl: 'маніфест',
  version: 'версію', author: 'автора', features: '«Що всередині»',
};

const EVENTS: Readonly<Record<string, { icon: string; text: string }>> = {
  'scenario.create': { icon: 'plus', text: 'Створено сценарій' },
  'scenario.submit': { icon: 'paper-plane-tilt', text: 'Надіслано на модерацію' },
  'scenario.withdraw': { icon: 'arrow-u-up-left', text: 'Відкликано з перевірки' },
  'scenario.approve': { icon: 'seal-check', text: 'Опубліковано в каталозі' },
  'scenario.reject': { icon: 'arrow-u-up-left', text: 'Повернуто на доопрацювання' },
  'scenario.unpublish': { icon: 'eye-slash', text: 'Знято з публікації' },
  'scenario.archive': { icon: 'upload-simple', text: 'Завантажено архів' },
  'scenario.preview': { icon: 'file-image', text: 'Оновлено превʼю' },
  'scenario.preview.remove': { icon: 'file-image', text: 'Прибрано превʼю' },
  'scenario.delete': { icon: 'trash', text: 'Сценарій видалено' },
  'version.accept': { icon: 'seal-check', text: 'Прийнято нову версію архіву' },
  'version.reject': { icon: 'arrow-u-up-left', text: 'Відхилено нову версію архіву' },
  'version.restore': { icon: 'arrow-counter-clockwise', text: 'Відновлено попередню версію архіву' },
  'version.delete': { icon: 'trash', text: 'Видалено версію архіву' },
  'version.checks': { icon: 'shield-check', text: 'Перезапущено перевірку архіву' },
  'version.test-run': { icon: 'play-circle', text: 'Збережено результат тестового запуску' },
};

/** How a journal row reads in "Історія рішень"; an action this build has no sentence for shows its name. */
export function describeEvent(row: Pick<AuditRow, 'action' | 'details'>): EventView {
  const details = row.details ?? {};
  const note = typeof details['note'] === 'string' && details['note'] ? details['note'] : undefined;

  if (row.action === 'scenario.update') {
    const fields = Array.isArray(details['fields'])
      ? details['fields'].filter((f): f is string => typeof f === 'string').map(f => FIELD_NAMES[f] ?? f)
      : [];
    return { icon: 'pencil-simple', text: fields.length ? `Оновлено: ${fields.join(', ')}` : 'Оновлено сценарій' };
  }

  const known = Object.hasOwn(EVENTS, row.action) ? EVENTS[row.action] : undefined;
  return { ...(known ?? { icon: 'info', text: row.action }), ...(note ? { note } : {}) };
}
