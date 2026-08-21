import type { GameConfig, ResourceKind } from '@last-signal/game-core';
import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { GAME_CONFIG } from '../../game-config/game-config.tokens';
import type { EventHandler } from '../../scheduler/event-handler.interface';
import type { GameEventDocument } from '../../schemas/event.schema';
import type { SettlementDocument } from '../../schemas/settlement.schema';
import { Settlement } from '../../schemas/settlement.schema';
import type { TradeOfferDocument } from '../../schemas/trade-offer.schema';
import { TradeOffer } from '../../schemas/trade-offer.schema';
import { SettlementsService } from '../../settlements/settlements.service';
import { toBuildingLevels } from '../../settlements/settlements.util';
import { TRADE_OFFER_EXPIRE_EVENT_TYPE } from '../market.constants';
import { computeOfferRefund } from '../market.util';

interface TradeOfferExpirePayload {
  offerId: string;
}

// §14's 48h offer TTL, applied. Owner decision F ("Owner decisions during M3d",
// `docs/PROGRESS.md`): expiry refunds 100% of `give.amount`, identically to a player-issued
// cancel — clamped to the origin settlement's storage caps, overflow lost — and flips
// `status` to `'expired'`. Shares its refund arithmetic with `MarketService.cancelOffer` via
// `computeOfferRefund` rather than reimplementing the clamp twice; see that function's own
// comment for why the two paths must never compute it differently.
//
// Idempotency: re-checks `status !== 'open'` before doing anything else — the same status-
// guard principle every movement handler already uses (§18, e.g. `MovementArriveHandler`'s
// own `status !== 'outbound'` guard). A replay of the same event finds the offer already
// `'expired'` (this handler's own earlier, successful run) — or `'cancelled'`, if the offerer
// cancelled it in the gap between the event firing and this replay — and no-ops either way.
//
// Settles the origin settlement to `event.dueAt`, never `Date.now()` (§18) — the same lesson
// M3c.5a already recorded for loot: a refund landing on a stale, not-yet-settled resource
// figure would be wrong, and a downtime replay must resolve in game time, not wall-clock time.
//
// Writes NO report. §15's table fixes eleven report kinds and allocates none for an offer's
// own lifecycle (cancel/expire) — the offer document's terminal `status` is what the Market
// tab (M3e) reads to show "expired". Recorded here so a future pass does not "fix" this into
// a twelfth report kind — the same shape of recorded reading M3c.6 made for support arrivals.
@Injectable()
export class TradeOfferExpireHandler implements EventHandler {
  readonly type = TRADE_OFFER_EXPIRE_EVENT_TYPE;
  readonly supportedPayloadVersions = [1];

  constructor(
    @InjectModel(TradeOffer.name) private readonly tradeOfferModel: Model<TradeOfferDocument>,
    @InjectModel(Settlement.name) private readonly settlementModel: Model<SettlementDocument>,
    @Inject(SettlementsService) private readonly settlementsService: SettlementsService,
    @Inject(GAME_CONFIG) private readonly config: GameConfig,
  ) {}

  async handle(event: GameEventDocument, session: ClientSession): Promise<void> {
    const payload = event.payload as unknown as TradeOfferExpirePayload;

    const offer = await this.tradeOfferModel.findById(payload.offerId, null, { session });
    // Defensive, mirrors every other handler in this codebase: trade offers are never deleted
    // in v1 (a terminal `status` replaces deletion, see the schema's own comment).
    if (!offer) {
      return;
    }
    if (offer.status !== 'open') {
      return;
    }

    const homeDoc = await this.settlementsService.settleSettlementDocUnchecked(
      String(offer.fromSettlementId),
      event.dueAt,
      session,
    );
    // Defensive, mirrors every other handler here: settlements are never deleted in v1.
    if (!homeDoc) {
      return;
    }

    const { values } = computeOfferRefund(
      this.config,
      toBuildingLevels(homeDoc.buildings),
      homeDoc.resources.values,
      offer.give.resource as ResourceKind,
      offer.give.amount,
    );

    const updatedSettlement = await this.settlementModel.findOneAndUpdate(
      { _id: homeDoc._id, version: homeDoc.version },
      { $set: { 'resources.values': values, version: homeDoc.version + 1 } },
      { session },
    );
    if (!updatedSettlement) {
      throw new Error(
        `TradeOfferExpireHandler: version conflict crediting settlement ${String(homeDoc._id)}`,
      );
    }

    const updatedOffer = await this.tradeOfferModel.findOneAndUpdate(
      { _id: offer._id, version: offer.version },
      { $set: { status: 'expired', version: offer.version + 1 } },
      { session },
    );
    if (!updatedOffer) {
      throw new Error(
        `TradeOfferExpireHandler: version conflict expiring offer ${String(offer._id)}`,
      );
    }
  }
}
