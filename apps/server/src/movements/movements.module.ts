import type { OnModuleInit } from '@nestjs/common';
import { Inject, Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { GameConfigModule } from '../game-config/game-config.module';
import { EventHandlerRegistry } from '../scheduler/event-handler.registry';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { SettlementsModule } from '../settlements/settlements.module';
import { MovementArriveHandler } from './handlers/movement-arrive.handler';
import { MovementReturnHandler } from './handlers/movement-return.handler';
import { MovementsController } from './movements.controller';
import { MovementsService } from './movements.service';

@Module({
  // DatabaseModule for `@InjectModel(Movement.name)`/`@InjectModel(Report.name)`/
  // `@InjectModel(Settlement.name)`/`@InjectConnection()` (Nest DI is per-module — see the
  // comment in `database.module.ts`); SchedulerModule for `EventHandlerRegistry` +
  // `EventSchedulerService`; GameConfigModule for the injected `GameConfig`; AuthModule for
  // `AuthGuard` + `CurrentAccount` on `MovementsController`; SettlementsModule for
  // `SettlementsService` — the settle seam both `sendScouts` (origin, ownership-checked) and
  // `MovementArriveHandler` (defender, ownership-free) go through, see
  // `SettlementsService.settleSettlementDoc`/`.settleSettlementDocUnchecked`'s own comments.
  imports: [DatabaseModule, SchedulerModule, GameConfigModule, AuthModule, SettlementsModule],
  controllers: [MovementsController],
  providers: [MovementsService, MovementArriveHandler, MovementReturnHandler],
})
export class MovementsModule implements OnModuleInit {
  constructor(
    @Inject(EventHandlerRegistry) private readonly registry: EventHandlerRegistry,
    @Inject(MovementArriveHandler) private readonly arriveHandler: MovementArriveHandler,
    @Inject(MovementReturnHandler) private readonly returnHandler: MovementReturnHandler,
  ) {}

  // Registers the `movementArrive` and `movementReturn` handlers with the shared scheduler
  // registry — same pattern `SettlementsModule` establishes for `buildComplete`/
  // `trainingComplete`.
  onModuleInit(): void {
    this.registry.register(this.arriveHandler);
    this.registry.register(this.returnHandler);
  }
}
