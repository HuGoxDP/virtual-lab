// backend/test/unit/nginx-forwarded-proto.test.js
//
// B6 phase 2 (DW-2.3): the nginx file is configuration, but the contract it
// carries — "the API believes what the last proxy says" — is source-pinned
// here, because a line lost in an nginx edit is invisible to every JS test.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const NGINX = path.resolve(__dirname, '..', '..', '..', 'nginx', 'nginx.conf');
const src = readFileSync(NGINX, 'utf8');

test('B6.3 the forwarded-proto map exists', () => {
  assert.match(src, /map\s+\$http_x_forwarded_proto\s+\$vl_forwarded_proto\s+\{\s*default\s+\$scheme;\s*https\s+https;\s*\}/);
});

test('B6.3 both api locations send the mapped header', () => {
  const locations = src.split(/location\s+[~^]{0,2}\s*\/api\/(lti\/)?/)
    .filter(Boolean);
  const apiBlocks = src.match(/location\s+(?:\^~\s+)?\/api\/(?:lti\/)?\s*\{[\s\S]*?\n    \}/g) || [];
  assert.equal(apiBlocks.length, 2, 'both /api/ and /api/lti/ blocks found');
  for (const block of apiBlocks) {
    assert.match(block, /proxy_set_header\s+X-Forwarded-Proto\s+\$vl_forwarded_proto/, block.slice(0, 60));
  }
});

test('B6.3 no api location still sends the raw scheme', () => {
  const apiBlocks = src.match(/location\s+(?:\^~\s+)?\/api\/(?:lti\/)?\s*\{[\s\S]*?\n    \}/g) || [];
  for (const block of apiBlocks) {
    assert.doesNotMatch(block, /X-Forwarded-Proto\s+\$scheme/);
  }
});

test('B6.3 the https listener exists for the map to be about', () => {
  assert.match(src, /listen\s+443\s+ssl;/);
});
