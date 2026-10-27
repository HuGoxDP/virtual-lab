// backend/workflow.js
//
// The publishing workflow: which status a scenario may move to, who may move it, and
// the one routine that performs a move.
//
//   draft ──submit──▶ review ──approve──▶ published ──unpublish──▶ draft
//     ▲  ◀─withdraw──┘   │                    ▲
//     │                  └──reject──▶ rejected ┘ (submit again, or approve directly)
//
// Everything a route or the compatibility `PUT {isPublished}` needs is `applyTransition`;
// the table below is the single statement of the rules.

const { canEditScenario } = require('./auth');
const audit = require('./audit');
const { httpError } = require('./http-error');

const MAX_NOTE_LENGTH = 2000;
const DEFAULT_REJECT_NOTE = 'Потрібні уточнення від модератора.';

/**
 * `by`: `owner` = the owning author or any moderator (`canEditScenario`); `moderator` = moderators only.
 * `needsVersion`: the scenario must have a `current` archive version.
 * `note`: what happens to `moderator_note` — `set` (reject), `clear`, or `keep`.
 */
const TRANSITIONS = {
  submit:    { from: ['draft', 'rejected'],            to: 'review',    by: 'owner',     needsVersion: true,  note: 'clear' },
  withdraw:  { from: ['review'],                       to: 'draft',     by: 'owner',                          note: 'keep' },
  approve:   { from: ['review', 'draft', 'rejected'],  to: 'published', by: 'moderator', needsVersion: true,  note: 'clear' },
  reject:    { from: ['review'],                       to: 'rejected',  by: 'moderator',                      note: 'set' },
  unpublish: { from: ['published'],                    to: 'draft',     by: 'moderator',                      note: 'keep' },
};

/** The note a rejection stores, as `{ value }`, or `{ error }` for a client mistake. */
function parseRejectNote(raw) {
  if (raw === undefined || raw === null) return { value: DEFAULT_REJECT_NOTE };
  if (typeof raw !== 'string') return { error: 'note має бути рядком' };
  const trimmed = raw.trim();
  if (trimmed.length > MAX_NOTE_LENGTH) return { error: `note: не більше ${MAX_NOTE_LENGTH} символів` };
  return { value: trimmed || DEFAULT_REJECT_NOTE };
}

/**
 * Moves scenario `id` through `action` as `principal`, inside the caller's transaction.
 *
 * The row is read under `FOR UPDATE`, so of two concurrent approves one waits, then sees
 * `published` and gets the 409. Throws `httpError`: 404 unknown scenario, 403 not allowed,
 * 409 wrong status or no archive. Records `scenario.<action>` in the journal.
 *
 * @returns {Promise<{id: string, from: string, status: string, moderatorNote: string|null, submittedAt: Date|null}>}
 */
async function applyTransition(db, principal, id, action, { note } = {}) {
  const rule = TRANSITIONS[action];
  if (!rule) throw new Error(`unknown transition "${action}"`);

  const { rows } = await db.query('SELECT id, status, owner_key_id FROM scenarios WHERE id = $1 FOR UPDATE', [id]);
  const row = rows[0];
  if (!row) throw httpError(404, 'Сценарій не знайдено');

  const allowed = rule.by === 'moderator' ? principal.role === 'moderator' : canEditScenario(principal, row);
  if (!allowed) throw httpError(403, rule.by === 'moderator' ? 'Недостатньо прав' : 'Це не ваш сценарій');

  if (!rule.from.includes(row.status)) {
    throw httpError(409, `Дію «${action}» не можна виконати для сценарію зі статусом «${row.status}»`);
  }
  if (rule.needsVersion) {
    const { rowCount } = await db.query(
      "SELECT 1 FROM scenario_versions WHERE scenario_id = $1 AND state = 'current'", [id]
    );
    if (rowCount === 0) throw httpError(409, 'Спершу завантажте архів сценарію');
  }

  const stored = rule.note === 'set' ? note : null;
  const { rows: [updated] } = await db.query(`
    UPDATE scenarios
       SET status         = $2::varchar,
           moderator_note = CASE WHEN $3::text = 'keep' THEN moderator_note ELSE $4::text END,
           submitted_at   = CASE WHEN $2::varchar = 'review' THEN NOW() ELSE submitted_at END,
           updated_at     = NOW()
     WHERE id = $1
 RETURNING status, moderator_note AS "moderatorNote", submitted_at AS "submittedAt"
  `, [id, rule.to, rule.note, stored]);

  await audit.record(db, principal, `scenario.${action}`, id, {
    from: row.status, to: rule.to, ...(stored ? { note: stored } : {}),
  });
  return { id, from: row.status, ...updated };
}

module.exports = { TRANSITIONS, MAX_NOTE_LENGTH, DEFAULT_REJECT_NOTE, parseRejectNote, applyTransition };
