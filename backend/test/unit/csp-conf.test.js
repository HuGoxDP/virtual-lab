// backend/test/unit/csp-conf.test.js
//
// Test-plan scenario 201 (DW-4.2): the policy of record in nginx/csp.conf - read from the file,
// so it needs no stack - lets the platform page load images only from itself, data: and blob:.
// Cover images are uploaded to /previews/ and no longer hot-linked, so `https:` must stay out.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = name => fs.readFileSync(path.join(__dirname, '../../../nginx', name), 'utf8');
const policy = read('csp.conf').match(/add_header\s+Content-Security-Policy\s+"([^"]*)"/)?.[1] ?? '';
const directive = name => policy.split(';').map(d => d.trim()).find(d => d.startsWith(`${name} `));

test('201. DW-4.2 img-src is exactly self, data: and blob: - no https:, http: or wildcard', () => {
  assert.equal(directive('img-src'), "img-src 'self' data: blob:");
  assert.doesNotMatch(directive('img-src'), /https?:|\*/);
});

test('201. DW-4.2 the other directives the platform depends on are unchanged', () => {
  assert.equal(directive('script-src'), "script-src 'self'");
  assert.equal(directive('frame-src'), "frame-src 'self'");
  assert.equal(directive('default-src'), "default-src 'self'");
  assert.doesNotMatch(policy, /unsafe-eval/);
});

test('201. DW-4.2 nginx serves /previews/ from the previews volume with the CSP include and nosniff', () => {
  const nginx = read('nginx.conf');
  const start = nginx.indexOf('location ^~ /previews/ {');
  assert.notEqual(start, -1, 'the /previews/ location exists');
  const block = nginx.slice(start, nginx.indexOf('\n    }\n', start));
  assert.match(block, /alias \/srv\/previews\/objects\//);
  assert.match(block, /include \/etc\/nginx\/csp\.conf;/);
  assert.match(block, /X-Content-Type-Options "nosniff"/);
  assert.match(block, /immutable/);
  assert.match(block, /image\/png\s+png;/);
  assert.match(block, /image\/jpeg\s+jpg;/);
});
