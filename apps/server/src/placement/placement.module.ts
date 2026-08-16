import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { GameConfigModule } from '../game-config/game-config.module';
import { WorldModule } from '../world/world.module';
import { PlacementService } from './placement.service';
import { PLACEMENT_RNG } from './placement.tokens';

@Module({
  // DatabaseModule for `@InjectModel(Settlement.name)` / `@InjectModel(Oasis.name)` (Nest DI
  // is per-module — see the comment in `database.module.ts`); GameConfigModule for the
  // injected `GameConfig` that `pickSpawnTile`/`isSettleable`/`terrainAt` all need;
  // WorldModule for `WorldService.getWorld()` (the stored world seed `terrainAt` needs).
  imports: [DatabaseModule, GameConfigModule, WorldModule],
  providers: [
    PlacementService,
    // Real randomness in production; integration tests override this provider with a
    // deterministic generator to force (and assert on) specific candidates — see
    // `PLACEMENT_RNG`'s own comment.
    { provide: PLACEMENT_RNG, useValue: (): number => Math.random() },
  ],
  exports: [PlacementService],
})
export class PlacementModule {}
