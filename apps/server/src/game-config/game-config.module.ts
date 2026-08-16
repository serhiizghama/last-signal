import { DEFAULT_CONFIG } from '@last-signal/game-core';
import { Module } from '@nestjs/common';

import { GAME_CONFIG } from './game-config.tokens';

// Single shared `GameConfig` instance for the whole app, bound to game-core's
// `DEFAULT_CONFIG`. Feature modules `@Inject(GAME_CONFIG)` instead of importing
// `DEFAULT_CONFIG` directly, so swapping in a per-round/archived config later (§9) is a
// change to this one provider, not to every call site.
@Module({
  providers: [{ provide: GAME_CONFIG, useValue: DEFAULT_CONFIG }],
  exports: [GAME_CONFIG],
})
export class GameConfigModule {}
