// backend/routes/workflow.js
//
// The five status transitions: POST /api/scenarios/:id/{submit|withdraw|approve|reject|unpublish}.
// The rules live in `workflow.js`; this only turns each into a route in one transaction.

const express = require('express');

const { inTransaction } = require('../db');
const { authorize } = require('../auth');
const { sendError } = require('../http-error');
const { TRANSITIONS, parseRejectNote, applyTransition } = require('../workflow');

const router = express.Router();

for (const action of Object.keys(TRANSITIONS)) {
  // The role gate is `author` for every action: a moderator is an author too, and the table
  // decides per action (owner or moderator, or moderator only).
  router.post(`/api/scenarios/:id/${action}`, authorize('author'), async (req, res) => {
    let note;
    if (action === 'reject') {
      const parsed = parseRejectNote(req.body?.note);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      note = parsed.value;
    }

    try {
      const moved = await inTransaction(db => applyTransition(db, req.principal, req.params.id, action, { note }));
      res.json({
        id: moved.id,
        status: moved.status,
        isPublished: moved.status === 'published',
        moderatorNote: moved.moderatorNote,
        submittedAt: moved.submittedAt,
      });
    } catch (err) {
      sendError(res, err, `POST /api/scenarios/:id/${action}`);
    }
  });
}

module.exports = { router };
