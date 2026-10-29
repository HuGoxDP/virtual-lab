// path: src/app/ui/status-pill/status-meta.ts

import { ScenarioStatus } from '../../models/scenario.model';

export interface StatusMeta {
  label: string;
  /** Text and icon colour. */
  fg: string;
  /** Pill background. */
  bg: string;
  icon: string;
}

/** The prototype's palette: published, in review, draft, returned. */
export const STATUS_META: Readonly<Record<ScenarioStatus, StatusMeta>> = {
  published: { label: 'Опубліковано', fg: '#8fdcb4', bg: 'rgba(126,214,166,.15)', icon: 'check-circle' },
  review: { label: 'На перевірці', fg: '#e5c887', bg: 'rgba(224,192,112,.15)', icon: 'clock' },
  draft: { label: 'Чернетка', fg: '#b2b6ca', bg: 'rgba(147,151,171,.18)', icon: 'pencil-simple' },
  rejected: { label: 'На доопрацюванні', fg: '#f0b4b4', bg: 'rgba(224,138,138,.15)', icon: 'warning' },
};

/** Chip order on the list. */
export const STATUS_ORDER: readonly ScenarioStatus[] = ['published', 'review', 'draft', 'rejected'];

/** Total: a status this build does not know reads as a draft with its raw name, never as a blank. */
export function statusMeta(status: string): StatusMeta {
  return Object.hasOwn(STATUS_META, status) ? STATUS_META[status as ScenarioStatus] : { ...STATUS_META.draft, label: status || '—' };
}

