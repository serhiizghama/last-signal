import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { GameConfigModule } from '../game-config/game-config.module';
import { WorldModule } from '../world/world.module';
import { OasisService } from './oasis.service';

// The oasis settle seam (M3c.7a, `docs/M3_DESIGN_DECISIONS.md` §10): owns the `Oasis` model
// and lazily materialises/regenerates one oasis's live state on first contact, mirroring
// `SettlementsModule`'s ownership of the settlement settle seam. No controller — nothing in
// this step exposes a player-facing oasis endpoint; `OasisService` is consumed by
// `MovementsService` (target resolution at send) and `MovementArriveHandler`/
// `OasisScoutArrivalResolver` (settle + scout resolution at arrival), both in
// `MovementsModule`, which is why this module exports `OasisService` rather than keeping it
// module-private.
@Module({
  // DatabaseModule for `@InjectModel(Oasis.name)` (Nest DI is per-module — see the comment
  // in `database.module.ts`); GameConfigModule for the injected `GameConfig` `settleOasis`
  // needs; WorldModule for `WorldService.getWorld()` — the world seed `oasisTargetDefenders`
  // derives every oasis's target garrison from (§10), the same seed `BattleArrivalResolver`
  // already reads via `WorldModule` for its own deterministic roll (see
  // `movements.module.ts`'s comment on why it imports `WorldModule` too).
  imports: [DatabaseModule, GameConfigModule, WorldModule],
  providers: [OasisService],
  exports: [OasisService],
})
export class OasisModule {}
