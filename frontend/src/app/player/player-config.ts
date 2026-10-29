// path: src/app/player/player-config.ts

import { InjectionToken } from '@angular/core';

// The only place the app imports the engine from: the host client of the sandboxed player. It carries
// no engine code, so nothing in the page can run a scenario (player-isolation).
import { PlayerHost } from 'WebEngineTS/player-host';
import type { PlayerHostOptions } from 'WebEngineTS/player-host';

/** Where the sandboxed player, the engine bundle it imports and the KTX2 transcoder are served. */
export const PLAYER_URL = '/player/player.html';
export const ENGINE_URL = '/assets/WebEngineTS.standalone.js';
/** The engine's default is `/basis/`, which 404s here: Angular publishes `src/assets` under `/assets`. */
export const TRANSCODER_PATH = '/assets/basis/';

/** The slice of `PlayerHost` a screen drives; a spec substitutes a fake with the same surface. */
export type PlayerHostLike = Pick<PlayerHost, 'load' | 'restart' | 'pause' | 'resume' | 'measure' | 'dispose'>;

export type PlayerHostFactory = (container: HTMLElement, options: PlayerHostOptions) => PlayerHostLike;

/** How a screen makes a `PlayerHost`. jsdom has no WebGL2 or real frames, so a spec provides a fake factory. */
export const PLAYER_HOST_FACTORY = new InjectionToken<PlayerHostFactory>('PLAYER_HOST_FACTORY', {
  providedIn: 'root',
  factory: () => (container, options) => new PlayerHost(container, options),
});

/** The options every screen passes; callbacks are the caller's. */
export const playerHostOptions = (callbacks: PlayerHostOptions['callbacks'] = {}): PlayerHostOptions => ({
  playerUrl: PLAYER_URL,
  engineUrl: ENGINE_URL,
  transcoderPath: TRANSCODER_PATH,
  callbacks,
});
