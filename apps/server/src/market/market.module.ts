import type { OnModuleInit } from '@nestjs/common';
import { Inject, Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { GameConfigModule } from '../game-config/game-config.module';
import { EventHandlerRegistry } from '../scheduler/event-handler.registry';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { SettlementsModule } from '../settlements/settlements.module';
import { MarketExchangeHandler } from './handlers/market-exchange.handler';
import { TradeOfferExpireHandler } from './handlers/trade-offer-expire.handler';
import { MarketController } from './market.controller';
import { MarketService } from './market.service';

@Module({
  // DatabaseModule for `@InjectModel(TradeOffer.name)`/`@InjectModel(Settlement.name)`/
  // `@InjectModel(Account.name)`/`@InjectConnection()` (Nest DI is per-module — see the
  // comment in `database.module.ts`); SchedulerModule for `EventHandlerRegistry` +
  // `EventSchedulerService`; GameConfigModule for the injected `GameConfig`; AuthModule for
  // `AuthGuard` + `CurrentAccount` on `MarketController`; SettlementsModule for
  // `SettlementsService` — the settle seam both `createOffer` (ownership-checked) and
  // `cancelOffer`/`TradeOfferExpireHandler` (ownership-free) go through, see
  // `SettlementsService.settleSettlementDoc`/`.settleSettlementDocUnchecked`'s own comments.
  imports: [DatabaseModule, SchedulerModule, GameConfigModule, AuthModule, SettlementsModule],
  controllers: [MarketController],
  providers: [MarketService, TradeOfferExpireHandler, MarketExchangeHandler],
})
export class MarketModule implements OnModuleInit {
  constructor(
    @Inject(EventHandlerRegistry) private readonly registry: EventHandlerRegistry,
    @Inject(TradeOfferExpireHandler) private readonly expireHandler: TradeOfferExpireHandler,
    @Inject(MarketExchangeHandler) private readonly exchangeHandler: MarketExchangeHandler,
  ) {}

  // Registers the `tradeOfferExpire` and `marketExchange` handlers with the shared scheduler
  // registry — same pattern `MovementsModule`/`SettlementsModule` establish for their own
  // handlers.
  onModuleInit(): void {
    this.registry.register(this.expireHandler);
    this.registry.register(this.exchangeHandler);
  }
}
