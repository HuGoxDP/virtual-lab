// path: src/app/player/player-config.spec.ts
//
// Test-plan scenario 228 (DW-7.5 support): the one place that says where the sandboxed player lives, shared by the
// viewer and the test run.

import { readFileSync } from 'node:fs';
import { TestBed } from '@angular/core/testing';

import { ENGINE_URL, PLAYER_HOST_FACTORY, PLAYER_URL, TRANSCODER_PATH, playerHostOptions } from './player-config';

/** The engine the frontend depends on — the release tarball's own version. */
const engineVersion = (): string =>
  JSON.parse(readFileSync('node_modules/WebEngineTS/package.json', 'utf8')).version as string;

describe('player config', () => {
  it('the options carry the player, engine and transcoder locations and the caller\'s callbacks', () => {
    const onError = vi.fn();
    expect(playerHostOptions({ onError })).toEqual({
      playerUrl: PLAYER_URL, engineUrl: ENGINE_URL, transcoderPath: TRANSCODER_PATH, callbacks: { onError },
    });
    expect(PLAYER_URL).toBe('/player/player.html');
    expect(TRANSCODER_PATH).toBe('/assets/basis/');
  });

  it('the engine URL carries the installed engine\'s version, and nothing unversioned', () => {
    // A10: the platform runs the released engine from a versioned path. When the
    // dependency moves to a newer release, this fails until the URL follows —
    // the version lives in the dependency, not in two hand-edited places.
    expect(ENGINE_URL).toBe(`/engine/${engineVersion()}/WebEngineTS.standalone.js`);
    expect(ENGINE_URL.startsWith('/assets/')).toBe(false);
  });

  it('without callbacks the options still have an (empty) callbacks object', () => {
    expect(playerHostOptions().callbacks).toEqual({});
  });

  it('the default factory is provided at the root and builds a host from the real client', () => {
    const factory = TestBed.inject(PLAYER_HOST_FACTORY);
    const container = document.createElement('div');
    const host = factory(container, playerHostOptions());
    expect(typeof host.measure).toBe('function');
    host.dispose();
  });
});
