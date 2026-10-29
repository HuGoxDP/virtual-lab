// path: src/app/player/player-config.spec.ts
//
// Test-plan scenario 228 (DW-7.5 support): the one place that says where the sandboxed player lives, shared by the
// viewer and the test run.

import { TestBed } from '@angular/core/testing';

import { ENGINE_URL, PLAYER_HOST_FACTORY, PLAYER_URL, TRANSCODER_PATH, playerHostOptions } from './player-config';

describe('player config', () => {
  it('the options carry the player, engine and transcoder locations and the caller\'s callbacks', () => {
    const onError = vi.fn();
    expect(playerHostOptions({ onError })).toEqual({
      playerUrl: PLAYER_URL, engineUrl: ENGINE_URL, transcoderPath: TRANSCODER_PATH, callbacks: { onError },
    });
    expect(PLAYER_URL).toBe('/player/player.html');
    expect(TRANSCODER_PATH).toBe('/assets/basis/');
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
