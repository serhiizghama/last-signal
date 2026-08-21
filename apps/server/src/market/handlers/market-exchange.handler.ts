import type { GameConfig, Resources } from '@last-signal/game-core';
import { emptyResources } from '@last-signal/game-core';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { GAME_CONFIG } from '../../game-config/game-config.tokens';
import { creditResourcesClamped } from '../../movements/movements.util';
import type { EventHandler } from '../../scheduler/event-handler.interface';
import type { GameEventDocument } from '../../schemas/event.schema';
import type { MarketExchangeDocument } from '../../schemas/market-exchange.schema';
import { MarketExchange } from '../../schemas/market-exchange.schema';
import type { SettlementDocument } from '../../schemas/settlement.schema';
import { Settlement } from '../../schemas/settlement.schema';
import { SettlementsService } from '../../settlements/settlements.service';
import { toBuildingLevels } from '../../settlements/settlements.util';
import { MARKET_EXCHANGE_EVENT_TYPE } from '../market.constants';

interface MarketExchangePayload {
  exchangeId: string;
}

// §14's world exchange trip, completed (M3d.4): `config.market.exchangeTripMs` after
// `MarketService.startExchange` deducted `amount` of `from` and occupied its merchants, this
// credits the pre-computed `exchangeOutput` of `to` and frees them back.
//
// **Credits via `creditResourcesClamped` (`movements/movements.util.ts`), not
// `market.util.ts`'s own `computeOfferRefund`, and that choice is deliberate.**
// `computeOfferRefund`'s whole signature and doc comment are scoped to REFUNDING an offer's
// previously-deducted `give.amount` (owner decisions E/F) — this is not a refund, it is
// freshly-converted value the exchange manufactures (at a loss, per `exchangeOutput`'s own
// comment) and delivers for the first time, the same shape `MovementReturnHandler` already
// uses `creditResourcesClamped` for when a raid's loot or a trade's cargo lands on a
// settlement. Both helpers apply an identical single-resource "credit then clamp, overflow
// lost" rule underneath, but `creditResourcesClamped` takes a full four-resource `Resources`
// bundle — mirrors the exact idiom `MarketService.createOffer`'s own affordability check
// already uses for a single-resource cost (`emptyResources()` + set one key) rather than
// reaching for a foreign shape, so wrapping `exchange.output` this way costs nothing new to
// this codebase's conventions.
//
// Idempotency: re-checks `status !== 'pending'` before doing anything else — the same
// status-guard principle `TradeOfferExpireHandler`/`MovementArriveHandler` already use. A
// replay of the same event finds the exchange already `'completed'` (this handler's own
// earlier, successful run) and no-ops.
//
// Settles the settlement to `event.dueAt`, never `Date.now()` (§18) — the same lesson
// M3c.5a recorded for loot and `TradeOfferExpireHandler` recorded for a refund: crediting
// (and clamping against storage caps) onto a stale, not-yet-settled resource figure would be
// wrong, and a downtime replay must resolve in game time, not wall-clock time.
//
// Writes NO report. §15 fixes eleven report kinds and allocates none for the exchange — it is
// not a trade with a counterparty (`market.integration.spec.ts`'s own scope comment already
// makes the same point about the offer board's lifecycle); the exchange document's own
// terminal `status` plus its `output` are what the M3e Market tab renders. Recorded here so a
// future pass does not "fix" this into a twelfth report kind — the same shape of recorded
// reading M3c.6/M3d.2 already made for their own report-less lifecycles.
@Injectable()
export class MarketExchangeHandler implements EventHandler {
  readonly type = MARKET_EXCHANGE_EVENT_TYPE;
  readonly supportedPayloadVersions = [1];

  // Same diagnostic role as `MovementReturnHandler`'s own logger — see the merchant-freeing
  // block below for what it records.
  private readonly logger = new Logger(MarketExchangeHandler.name);

  constructor(
    @InjectModel(MarketExchange.name)
    private readonly marketExchangeModel: Model<MarketExchangeDocument>,
    @InjectModel(Settlement.name) private readonly settlementModel: Model<SettlementDocument>,
    @Inject(SettlementsService) private readonly settlementsService: SettlementsService,
    @Inject(GAME_CONFIG) private readonly config: GameConfig,
  ) {}

  async handle(event: GameEventDocument, session: ClientSession): Promise<void> {
    const payload = event.payload as unknown as MarketExchangePayload;

    const exchange = await this.marketExchangeModel.findById(payload.exchangeId, null, {
      session,
    });
    // Defensive, mirrors every other handler in this codebase: exchanges are never deleted in
    // v1 (a terminal `status` replaces deletion, see the schema's own comment).
    if (!exchange) {
      return;
    }
    if (exchange.status !== 'pending') {
      return;
    }

    const settled = await this.settlementsService.settleSettlementDocUnchecked(
      String(exchange.settlementId),
      event.dueAt,
      session,
    );
    // Defensive, mirrors every other handler here: settlements are never deleted in v1.
    if (!settled) {
      return;
    }

    const outputBundle: Resources = emptyResources();
    // `exchange.to` was only ever written by `MarketService.startExchange` after its own
    // `isResourceKind` check already passed (`market.view.ts`'s `toMarketExchangeView`
    // records the identical trust for the wire view) — safe to index without re-narrowing.
    outputBundle[exchange.to as keyof Resources] = exchange.output;

    const { values } = creditResourcesClamped(
      this.config,
      toBuildingLevels(settled.buildings),
      settled.resources.values,
      outputBundle,
    );

    // §14: "occupied for the whole round trip and freed on return" — floored at 0, mirroring
    // `MovementReturnHandler`'s identical floor for a trade leg's own `movement.merchants`:
    // an occupied-merchant count that somehow drifted below `merchantsOccupied` must not
    // strand this completion or drive `busyMerchants` negative.
    const freed = Math.min(settled.busyMerchants, exchange.merchantsOccupied);
    if (freed < exchange.merchantsOccupied) {
      this.logger.error(
        `MarketExchangeHandler: busyMerchants drifted below zero freeing exchange ` +
          `${String(exchange._id)} at settlement ${String(settled._id)} — clamped at zero, ` +
          `short by ${exchange.merchantsOccupied - freed}`,
      );
    }
    const newBusyMerchants = settled.busyMerchants - freed;

    const updatedSettlement = await this.settlementModel.findOneAndUpdate(
      { _id: settled._id, version: settled.version },
      {
        $set: {
          'resources.values': values,
          busyMerchants: newBusyMerchants,
          version: settled.version + 1,
        },
      },
      { session },
    );
    if (!updatedSettlement) {
      throw new Error(
        `MarketExchangeHandler: version conflict crediting settlement ${String(settled._id)}`,
      );
    }

    const updatedExchange = await this.marketExchangeModel.findOneAndUpdate(
      { _id: exchange._id, version: exchange.version },
      { $set: { status: 'completed', version: exchange.version + 1 } },
      { session },
    );
    if (!updatedExchange) {
      throw new Error(
        `MarketExchangeHandler: version conflict completing exchange ${String(exchange._id)}`,
      );
    }
  }
}
