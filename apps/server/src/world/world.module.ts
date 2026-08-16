import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { DatabaseModule } from '../database/database.module';
import { GameConfigModule } from '../game-config/game-config.module';
import { WorldDevController } from './world-dev.controller';
import { WorldService } from './world.service';

// World bootstrap + the `oases` collection (M2a.3). `WorldService.onModuleInit` self-heals a
// fresh boot — an empty DB gets a world — and `WorldDevController` exposes the dev-only
// regenerate command. Exports `WorldService` so later M2 steps (the NPC seeder, `GET
// /api/map`) can inject it without redoing this wiring.
@Module({
  // DatabaseModule for `@InjectModel(World.name)` / `@InjectModel(Oasis.name)` (Nest DI is
  // per-module — see the comment in `database.module.ts`); GameConfigModule for the injected
  // `GameConfig` `generateOases` needs; ConfigModule for `WorldDevController`'s
  // `NODE_ENV` guard.
  imports: [ConfigModule, DatabaseModule, GameConfigModule],
  controllers: [WorldDevController],
  providers: [WorldService],
  exports: [WorldService],
})
export class WorldModule {}
