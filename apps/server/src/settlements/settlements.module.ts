import type { OnModuleInit } from '@nestjs/common';
import { Inject, Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { GameConfigModule } from '../game-config/game-config.module';
import { PlacementModule } from '../placement/placement.module';
import { EventHandlerRegistry } from '../scheduler/event-handler.registry';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { BuildCompleteHandler } from './handlers/build-complete.handler';
import { ACTIVE_BUILD_SLOTS, DEFAULT_ACTIVE_BUILD_SLOTS } from './settlements.constants';
import { SettlementsController } from './settlements.controller';
import { SettlementsService } from './settlements.service';

@Module({
  // DatabaseModule for `@InjectModel(Settlement.name)` (Nest DI is per-module — see the
  // comment in `database.module.ts`); SchedulerModule for `EventHandlerRegistry` +
  // `EventSchedulerService`; GameConfigModule for the injected `GameConfig`; PlacementModule
  // for settlement creation's outer-ring placement; AuthModule for `AuthGuard` +
  // `CurrentAccount` on `SettlementsController`.
  imports: [DatabaseModule, SchedulerModule, GameConfigModule, PlacementModule, AuthModule],
  controllers: [SettlementsController],
  providers: [
    SettlementsService,
    BuildCompleteHandler,
    // Deliberately a provider, not a hardcoded literal — see the comment on the token
    // itself. Swapping this for a per-settlement/faction-aware value later (Engineers'
    // second parallel build slot) is a provider change, not a rewrite.
    { provide: ACTIVE_BUILD_SLOTS, useValue: DEFAULT_ACTIVE_BUILD_SLOTS },
  ],
  // `SettlementsService` so `DevSeedModule` can delegate its dev-only seeding endpoint to
  // the real placement + creation path (see `DevSeedController`'s comment) instead of
  // duplicating it.
  exports: [SettlementsService],
})
export class SettlementsModule implements OnModuleInit {
  constructor(
    @Inject(EventHandlerRegistry) private readonly registry: EventHandlerRegistry,
    @Inject(BuildCompleteHandler) private readonly buildCompleteHandler: BuildCompleteHandler,
  ) {}

  // Registers the `buildComplete` handler with the shared scheduler registry — the pattern
  // the registry's own doc comment describes: feature modules plug in from their own
  // `onModuleInit`.
  onModuleInit(): void {
    this.registry.register(this.buildCompleteHandler);
  }
}
