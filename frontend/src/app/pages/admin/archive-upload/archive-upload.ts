// path: src/app/pages/admin/archive-upload/archive-upload.ts
//
// What both upload screens (the Файл tab and the wizard) decide about a file before and after it goes to the
// server. The server is the authority on every one of these; the client checks only to refuse early and to
// say in words what the status code means.

import { HttpErrorResponse } from '@angular/common/http';

import { UploadCancelled } from '../../../services/admin-api.service';
import { AdminService } from '../../../services/admin.service';
import { formatBytes } from '../../../ui/format';

/** Why `file` should not be sent at all, or null. `maxBytes` is `GET /api/config`'s cap, null while unknown. */
export function checkArchiveFile(file: File, maxBytes: number | null): string | null {
  if (!/\.zip$/i.test(file.name)) return 'Потрібен ZIP-архів: файл має закінчуватися на .zip.';
  if (file.size === 0) return 'Файл порожній.';
  if (maxBytes !== null && file.size > maxBytes) {
    return `Архів завеликий: ${formatBytes(file.size)}, а максимум — ${formatBytes(maxBytes)}. Нічого не завантажено.`;
  }
  return null;
}

/** The sentence a 409 for an upload in review is followed by. */
export const WITHDRAW_HINT = 'Відкличте сценарій з перевірки на вкладці «Публікація», потім завантажте архів знову.';

/**
 * What to tell the user about a failed upload; null for one the user cancelled (nothing went wrong).
 * The server's own words are kept; a 409 about a scenario in review gets the way out, and a request that
 * never reached the server (status 0) is said so rather than shown as «Помилка 0».
 */
export function describeUploadError(err: unknown): string | null {
  if (err instanceof UploadCancelled) return null;
  if (err instanceof HttpErrorResponse && err.status === 0) {
    return 'Немає звʼязку з сервером. Перевірте мережу й повторіть: нічого не збережено.';
  }
  const message = AdminService.describeError(err);
  if (err instanceof HttpErrorResponse && err.status === 409 && /перевірці/.test(message)) {
    return `${message.replace(/[.\s]+$/, '')}. ${WITHDRAW_HINT}`;
  }
  return message;
}
