// ops/deploy/test/core.test.mjs
//
// OPS1 phase 1 (DW-1.1..1.7): the pure core. No Docker, no network, no process
// spawned — the decisions that have to be right before anything that can touch
// a server exists.
//
// The secret rule under test throughout: an error message names the key and
// never the value, and the redactor removes every configured value from any
// text that carries them, in every form a command line or a URL puts them in.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { parseDeployEnv } from '../lib/config.mjs';
import { deployWindow } from '../lib/window.mjs';
import { makeRedactor } from '../lib/redact.mjs';
import { shq, shqArgs } from '../lib/shq.mjs';
import { tagOf, releaseId, imageNames, composeFiles, bundleFiles, nextState, keepForPrune } from '../lib/release.mjs';
import { needsDbRestore } from '../lib/rollback.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = name => readFileSync(path.join(HERE, 'fixtures', name), 'utf8');

const VL = 'a'.repeat(40);
const ED = 'b'.repeat(40);

describe('DW-1.1 parseDeployEnv', () => {
  it('accepts the sample, which carries a `=` inside a value and CRLF line endings', () => {
    const sample = fixture('deploy.env.sample');
    const fromLf = parseDeployEnv(sample);
    assert.equal(fromLf.DEPLOY_HOST, 'deploy.example.invalid');
    assert.equal(fromLf.DEPLOY_USER, 'deployer');
    assert.equal(fromLf.DEPLOY_PATH, '/srv/virtual-lab');
    assert.equal(fromLf.DEPLOY_PORT, '22');
    assert.match(fromLf.DEPLOY_HOSTKEY, /^deploy\.example\.invalid ssh-ed25519 /);

    // The file is written on Windows, so a parser that chokes on CRLF would
    // fail exactly where a human wrote it.
    const crlf = parseDeployEnv(sample.replace(/\n/g, '\r\n'));
    assert.deepEqual(crlf, fromLf);

    // `KEY=value` with an `=` inside the value: a host key line is the real case.
    assert.equal(fromLf.DEPLOY_HOSTKEY.includes('='), true);
  });

  it('rejects each bad input, naming the key and never the value', () => {
    const bad = [
      ['a missing required key', text => text.replace(/^DEPLOY_DOMAIN=.*$/m, ''), 'DEPLOY_DOMAIN'],
      ['a relative DEPLOY_PATH', text => text.replace('DEPLOY_PATH=/srv/virtual-lab', 'DEPLOY_PATH=srv/virtual-lab'), 'DEPLOY_PATH'],
      ['a DEPLOY_PATH with a space', text => text.replace('DEPLOY_PATH=/srv/virtual-lab', 'DEPLOY_PATH=/srv/virtual lab'), 'DEPLOY_PATH'],
      ['a DEPLOY_PATH with ..', text => text.replace('DEPLOY_PATH=/srv/virtual-lab', 'DEPLOY_PATH=/srv/../etc'), 'DEPLOY_PATH'],
      ['a DEPLOY_HOST with a metacharacter', text => text.replace('DEPLOY_HOST=deploy.example.invalid', 'DEPLOY_HOST=a;b'), 'DEPLOY_HOST'],
      ['a port of 0', text => text.replace('DEPLOY_PORT=22', 'DEPLOY_PORT=0'), 'DEPLOY_PORT'],
      ['a port above 65535', text => text.replace('DEPLOY_PORT=22', 'DEPLOY_PORT=70000'), 'DEPLOY_PORT'],
      ['an unknown key', text => `${text}\nDEPLOY_PASSWORD=hunter2\n`, 'DEPLOY_PASSWORD'],
    ];
    for (const [what, mutate, key] of bad) {
      const text = mutate(fixture('deploy.env.sample'));
      assert.throws(
        () => parseDeployEnv(text),
        err => {
          assert.match(err.message, new RegExp(key), `${what}: the message names the key`);
          assert.equal(err.message.includes('hunter2'), false, `${what}: the value is not in the message`);
          return true;
        },
        what
      );
    }
  });
});

describe('DW-1.2 deployWindow', () => {
  // 2027-03-28 is the last Sunday of March (DST starts), 2026-10-25 the last
  // Sunday of October (DST ends) — the days a hard-coded table would get wrong.
  const cases = [
    ['Mon 2026-11-09T18:59Z is 20:59 in Kyiv', '2026-11-09T18:59:00Z', false],
    ['Mon 2026-11-09T19:00Z is 21:00 in Kyiv', '2026-11-09T19:00:00Z', true],
    ['Tue 2026-11-10T03:59Z is 05:59 in Kyiv', '2026-11-10T03:59:00Z', true],
    ['Tue 2026-11-10T04:00Z is 06:00 in Kyiv', '2026-11-10T04:00:00Z', false],
    ['Tue 2026-11-10T10:00Z is noon in Kyiv', '2026-11-10T10:00:00Z', false],
    ['Fri 2026-11-13T19:00Z is 21:00 in Kyiv', '2026-11-13T19:00:00Z', true],
    ['Fri 2026-11-13T18:59Z is 20:59 in Kyiv', '2026-11-13T18:59:00Z', false],
    ['Sat 2026-11-14T10:00Z', '2026-11-14T10:00:00Z', true],
    ['Sun 2026-11-15T21:59Z', '2026-11-15T21:59:00Z', true],
    // 2027-03-29 is the Monday *after* the March switch, so Kyiv is already EEST
    // (UTC+3) and 03:59Z is 06:59 — inside the closed hours. The switch itself
    // fell on Sunday 2027-03-28, which is a weekend and allowed all day.
    ['Mon 2027-03-29T03:59Z is 06:59 the morning after the switch', '2027-03-29T03:59:00Z', false],
    ['Fri 2027-03-26T19:00Z is 21:00 the Friday before the switch', '2027-03-26T19:00:00Z', true],
    ['Sun 2026-10-25T20:59Z is 23:59 on the day DST ends', '2026-10-25T20:59:00Z', true],
    ['Mon 2026-10-26T03:59Z is 05:59 the morning after DST ends', '2026-10-26T03:59:00Z', true],
    ['Mon 2026-10-26T04:00Z is 06:00 that Monday', '2026-10-26T04:00:00Z', false],
  ];

  for (const [what, instant, allowed] of cases) {
    it(`${what} → ${allowed ? 'allowed' : 'refused'}`, () => {
      const answer = deployWindow(new Date(instant));
      assert.equal(answer.allowed, allowed, what);
      assert.match(answer.kyivLocal, /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{2}:\d{2} Europe\/Kyiv$/);
      if (allowed) assert.equal(answer.reason, '');
      else assert.match(answer.reason, /21:00–06:00 Europe\/Kyiv/);
    });
  }
});

describe('DW-1.3 redact', () => {
  const cfg = parseDeployEnv(fixture('deploy.env.sample'));
  const redact = makeRedactor(cfg);

  it('removes every value, in every form a command line or a URL puts them in', () => {
    const text = [
      `ssh -i ${cfg.DEPLOY_KEY} ${cfg.DEPLOY_USER}@${cfg.DEPLOY_HOST}`,
      `curl https://${cfg.DEPLOY_DOMAIN}/api/health`,
      `${cfg.DEPLOY_HOST} and ${cfg.DEPLOY_HOST} again`,
      `the host ${cfg.DEPLOY_HOST} appears inside a longer domain ${cfg.DEPLOY_DOMAIN}`,
    ].join('\n');
    const out = redact(text);
    assert.equal(out.includes(cfg.DEPLOY_USER), false);
    assert.equal(out.includes(cfg.DEPLOY_HOST), false);
    assert.equal(out.includes(cfg.DEPLOY_DOMAIN), false);
    assert.equal(out.includes(cfg.DEPLOY_KEY), false);
    assert.equal(out.includes(path.basename(cfg.DEPLOY_KEY)), false);
    assert.match(out, /<DEPLOY_USER>@<DEPLOY_HOST>/);
    assert.match(out, /<DEPLOY_DOMAIN>/);
  });

  it('replaces the longer value first, so a host that is a substring of the domain leaves nothing', () => {
    const nested = makeRedactor({
      DEPLOY_HOST: 'example.com',
      DEPLOY_DOMAIN: 'platform.example.com',
      DEPLOY_USER: 'deployer',
      DEPLOY_KEY: '/keys/k.pem',
    });
    assert.equal(nested('https://platform.example.com').includes('example.com'), false);
    assert.equal(nested('platform.example.com'), '<DEPLOY_DOMAIN>');
  });
});

describe('DW-1.4 shq', () => {
  const bash = process.env.BASH ?? 'bash';
  const hasBash = (() => {
    try {
      execFileSync(bash, ['-c', 'true'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  /**
   * The word a POSIX shell reads out of `shq(value)`: the quoted word is placed
   * in a command line, which is the only place it ever appears, and bash parses
   * it. Passing it as an already-split argv entry would ask bash to parse a word
   * it has already tokenised, which is not what shq is for.
   */
  const readBack = value => execFileSync(bash, ['-c', `printf %s ${shq(value)}`], { encoding: 'utf8' });

  it('round-trips the words that carry meaning to a shell', t => {
    if (!hasBash) return t.skip('no bash on PATH — quoting is verified where bash exists');
    for (const value of [`'`, `"`, `$(x)`, '`x`', 'new\nline', ';', '', 'a b', '\\']) {
      assert.equal(readBack(value), value, JSON.stringify(value));
    }
  });

  it('quotes a whole argv list, one word per entry', () => {
    // Each word is quoted as a word: the expectation is built by the same
    // quoting function, so this says "one quoted word per entry" rather than
    // "here is a string of backslashes" — the per-word round-trip above is what
    // proves the quoting itself.
    assert.deepEqual(shqArgs(['a b', 7, `'`]), ['a b', 7, `'`].map(shq));
  });
});

describe('DW-1.5 compose and bundle files', () => {
  it('names the platform bundle, and the editor adds its four', () => {
    assert.deepEqual(composeFiles({ editor: false }), [
      'docker-compose.yml',
      'docker-compose.restore.yml',
      'ops/deploy/compose.release.yml',
      'db/init.sql',
    ]);
    assert.deepEqual(composeFiles({ editor: true }), [
      'docker-compose.yml',
      'docker-compose.restore.yml',
      'ops/deploy/compose.release.yml',
      'db/init.sql',
      'docker-compose.editor.yml',
      'ops/deploy/compose.release-editor.yml',
      'nginx/editor.conf',
      'nginx/csp-editor.conf',
    ]);
  });

  it('appends extras and refuses anything that is not a repo-relative .yml', () => {
    assert.match(composeFiles({ editor: false, extra: ['docker-compose.https.yml'] }).at(-1), /docker-compose\.https\.yml$/);
    for (const bad of ['/abs/path.yml', '../outside.yml', 'x.txt', 'no-extension']) {
      assert.throws(() => composeFiles({ editor: false, extra: [bad] }), err => {
        // The message names the offender; the assertion checks that it does.
        assert.match(err.message, /repo-relative path|must be a \.yml path/);
        assert.equal(err.message.includes(bad), true);
        return true;
      });
    }
  });

  it('ships the compose files plus the inputs that must exist beside them', () => {
    assert.equal(bundleFiles({ editor: false }).includes('nginx/csp-editor.conf'), false);
    assert.equal(bundleFiles({ editor: true }).includes('nginx/csp-editor.conf'), true);
  });
});

describe('DW-1.6 rollback decision and release state', () => {
  it('needs a restore exactly when the deploy migrated', () => {
    assert.equal(needsDbRestore(['001', '002'], ['001', '002']), false);
    assert.equal(needsDbRestore(['001', '002'], ['001', '002', '003']), true);
    assert.throws(() => needsDbRestore(['001', '002'], ['001']), /migration set shrank/);
  });

  it('keeps at most ten records and prunes exactly three after four deploys', () => {
    let state = { current: null, previous: null, history: [] };
    for (let i = 1; i <= 4; i++) {
      state = nextState(state, { id: `r${i}`, tag: VL, at: `2026-11-1${i}` });
    }
    assert.equal(state.current.id, 'r4');
    assert.equal(state.previous.id, 'r3');
    assert.deepEqual(keepForPrune(state), ['r4', 'r3', 'r2']);
    assert.equal(state.history.length, 3);

    let wide = { current: null, previous: null, history: [] };
    for (let i = 1; i <= 25; i++) {
      wide = nextState(wide, { id: `w${i}`, tag: VL, at: '2026-11-12' });
    }
    assert.equal(wide.history.length, 10);
  });
});

describe('release identity', () => {
  it('a tag is a full sha, and a short one is refused', () => {
    assert.equal(tagOf(VL), VL);
    assert.throws(() => tagOf(VL.slice(0, 7)), /full 40-character commit sha/);
  });

  it('image names carry the tag and the editor is built only when it ships', () => {
    const platform = imageNames({ vlTag: tagOf(VL) }).map(i => i.name);
    assert.deepEqual(platform, [
      'virtual-lab/backend:' + VL,
      'virtual-lab/frontend:' + VL,
      'virtual-lab/backup:' + VL,
    ]);
    const withEditor = imageNames({ vlTag: tagOf(VL), edTag: tagOf(ED) }).map(i => i.name);
    assert.equal(withEditor.at(-1), `webengine-editor/editor:${ED}`);
    assert.equal(withEditor.length, 4);
  });

  it('a release id names both repos it was cut from', () => {
    assert.equal(releaseId({ vl: VL, ed: null }), `vl-${VL.slice(0, 7)}`);
    assert.equal(releaseId({ vl: VL, ed: ED }), `vl-${VL.slice(0, 7)}-ed-${ED.slice(0, 7)}`);
  });
});
