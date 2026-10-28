// backend/test/unit/nginx-lti-frame.test.js
//
// DW-6F.1: who may frame /lti/pick. The entrypoint script validates LTI_FRAME_ANCESTORS and renders the nginx
// include that sets the page's CSP `frame-ancestors`; the two config files must stay wired to it. The served
// headers themselves are checked against a running stack in e2e/tests/csp.spec.ts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const NGINX = path.join(__dirname, '..', '..', '..', 'nginx');
const SCRIPT = path.join(NGINX, '15-lti-frame-ancestors.sh');
const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;

/** Runs the script with the given LTI_FRAME_ANCESTORS (undefined = unset); returns its exit code and output file. */
function render(value) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lti-pick-'));
  const out = path.join(dir, 'lti-pick.conf');
  const env = { PATH: process.env.PATH, LTI_PICK_CONF: out };
  if (value !== undefined) env.LTI_FRAME_ANCESTORS = value;
  const res = spawnSync('sh', [SCRIPT], { env, encoding: 'utf8' });
  const conf = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: res.status, stderr: res.stderr, conf };
}

test('DW_6F_1 the include sets $csp_ancestors to the configured origins', { skip: !hasSh }, () => {
  assert.equal(render('https://moodle.lti.test').conf, 'set $csp_ancestors "https://moodle.lti.test";\n');
  assert.equal(render('https://a.example.edu  http://b.test:8080').conf,
    'set $csp_ancestors "https://a.example.edu http://b.test:8080";\n');
  assert.equal(render("'self' https://m.test").conf, `set $csp_ancestors "'self' https://m.test";\n`);
});

test('DW_6F_1 unset or blank means nobody but the platform itself', { skip: !hasSh }, () => {
  for (const value of [undefined, '', '   ']) {
    const { status, conf } = render(value);
    assert.equal(status, 0);
    assert.equal(conf, `set $csp_ancestors "'self'";\n`);
  }
});

test('DW_6F_1 anything that is not an origin fails the start and writes no include', { skip: !hasSh }, () => {
  const bad = ['*', 'https://*.edu', 'https://x.test/path', 'https://x.test;', 'https://x.test; script-src *',
    'javascript:alert(1)', 'moodle.test', 'https://', 'data:', '"https://x.test"', 'https://x.test"; add_header X 1; "'];
  for (const value of bad) {
    const { status, conf, stderr } = render(value);
    assert.equal(status, 1, `${value} must be refused`);
    assert.equal(conf, null, `${value} must not produce a config`);
    assert.match(stderr, /invalid entry/);
  }
});

test('DW_6F_1 csp.conf takes frame-ancestors from the variable, and only the picker location changes it', () => {
  const csp = fs.readFileSync(path.join(NGINX, 'csp.conf'), 'utf8');
  const nginx = fs.readFileSync(path.join(NGINX, 'nginx.conf'), 'utf8');
  assert.match(csp, /frame-ancestors \$csp_ancestors" always;/);

  assert.equal(nginx.match(/set \$csp_ancestors "'self'";/g).length, 1, 'default is set once, at server level');
  const pick = nginx.match(/location = \/lti\/pick \{[^}]*\}/)[0];
  assert.match(pick, /include \/etc\/nginx\/lti-pick\.conf;/);
  assert.match(pick, /rewrite \^ \/index\.html break;/);
  assert.match(pick, /include \/etc\/nginx\/csp\.conf;/);
  assert.doesNotMatch(pick, /X-Frame-Options/, 'SAMEORIGIN would block the frame the page exists for');
  assert.equal(nginx.match(/include \/etc\/nginx\/lti-pick\.conf;/g).length, 1, 'only that one location includes the rendered file');
});
