// scripts/test/selfhost-doc-https-redirect-blank.test.mjs
//
// P5f: the ## HTTPS section of docs/self-host.md must teach the three states
// of HTTPS_REDIRECT_PORT — unset (follows HTTPS_PORT, 8443 by default),
// explicitly empty (no http→https redirect at all), and a number (that port) —
// and show the literal `HTTPS_REDIRECT_PORT=` line as the off switch. An
// operator behind their own TLS proxy needs the off switch documented, or the
// only way to learn it is reading the overlay. Section slicing follows
// selfhost-doc.test.mjs: the rule must live in ## HTTPS, not anywhere.
// `node --test`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOC = readFileSync(path.join(ROOT, 'docs', 'self-host.md'), 'utf8');

/** The body of one `## <title…>` section, up to the next `## ` heading. */
function section(title) {
  const start = DOC.indexOf(`## ${title}`);
  assert.notEqual(start, -1, `section "## ${title}" must exist`);
  const rest = DOC.slice(start + 1);
  const next = rest.search(/^## /m);
  return next === -1 ? DOC.slice(start) : DOC.slice(start, start + 1 + next);
}

test('self-host doc: HTTPS section shows the literal HTTPS_REDIRECT_PORT= off-switch line', () => {
  const https = section('HTTPS');
  assert.match(https, /^HTTPS_REDIRECT_PORT=$/m,
    'a line with nothing after = must appear — that exact line in .env is how the redirect is turned off');
});

test('self-host doc: HTTPS section states in words that an empty value disables the redirect', () => {
  const https = section('HTTPS');
  const lines = https.split('\n');
  // The blank rule must be prose, not only a code line: "порожн…" within two
  // lines of a mention of the redirect.
  const stated = lines.some((line, i) =>
    /порожн/.test(line) &&
    /редирект/.test(lines.slice(Math.max(0, i - 2), i + 3).join('\n')));
  assert.ok(stated, 'the words "порожн…" and "редирект" must stand together — the empty-value rule in prose');
});
