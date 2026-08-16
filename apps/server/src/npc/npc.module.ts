import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { DatabaseModule } from '../database/database.module';
import { GameConfigModule } from '../game-config/game-config.module';
import { WorldModule } from '../world/world.module';
import { NpcSeederService } from './npc-seeder.service';
import { NPC_RNG } from './npc.tokens';

// NPC seeding (M2a.5). DatabaseModule for `@InjectModel(Account/Settlement/World.name)` (Nest
// DI is per-module — see the comment in `database.module.ts`); GameConfigModule for the
// injected `GameConfig` the catalogue lookups need; WorldModule for `WorldService` (seed +
// oases + the idempotent `bootstrap` call `NpcSeederService.onModuleInit` makes); ConfigModule
// for the `WORLD_NPC_COUNT` env knob, mirroring `WorldModule`'s own "imported here only for
// clarity, already global" note.
@Module({
  imports: [ConfigModule, DatabaseModule, GameConfigModule, WorldModule],
  providers: [
    NpcSeederService,
    // Real randomness in production; integration tests can override this provider with a
    // deterministic generator the same way `settlement-creation.integration.spec.ts` does for
    // `PLACEMENT_RNG`, if a future step needs to force a specific seeding outcome.
    { provide: NPC_RNG, useValue: (): number => Math.random() },
  ],
  exports: [NpcSeederService],
})
export class NpcModule {}
