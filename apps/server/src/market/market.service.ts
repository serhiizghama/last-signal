import type { Faction, GameConfig, ResourceKind, Resources } from '@last-signal/game-core';
import {
  canAfford,
  chebyshevDistance,
  emptyResources,
  exchangeOutput,
  isOfferRatioLegal,
  merchantSpeed,
  merchantsFromMarketLevel,
  merchantsNeededFor,
  subtractResources,
  travelTimeMs,
  weightedResourceValue,
} from '@last-signal/game-core';
import { Inject, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Connection, Model } from 'mongoose';
import { Types } from 'mongoose';

import { GAME_CONFIG } from '../game-config/game-config.tokens';
import { MOVEMENT_ARRIVE_EVENT_TYPE } from '../movements/movements.constants';
import { EventSchedulerService } from '../scheduler/event-scheduler.service';
import type { AccountDocument } from '../schemas/account.schema';
import { Account } from '../schemas/account.schema';
import type { MarketExchangeDocument } from '../schemas/market-exchange.schema';
import { MarketExchange } from '../schemas/market-exchange.schema';
import type { MovementDocument } from '../schemas/movement.schema';
import { Movement, MOVEMENT_TYPE_TRADE } from '../schemas/movement.schema';
import type { SettlementDocument } from '../schemas/settlement.schema';
import { Settlement } from '../schemas/settlement.schema';
import type { TradeOfferDocument } from '../schemas/trade-offer.schema';
import { TradeOffer } from '../schemas/trade-offer.schema';
import { SettlementNotFoundError } from '../settlements/settlements.errors';
import { SettlementsService } from '../settlements/settlements.service';
import { currentLevelOf, isResourceKind, toBuildingLevels } from '../settlements/settlements.util';
import {
  MARKET_EXCHANGE_EVENT_TYPE,
  MAX_COMMAND_ATTEMPTS,
  TRADE_OFFER_EXPIRE_EVENT_TYPE,
} from './market.constants';
import {
  CommandConflictRetryExhaustedError,
  MarketCommandError,
  TradeOfferNotFoundError,
  VersionConflictError,
} from './market.errors';
import { computeOfferRefund } from './market.util';
import type {
  MarketExchangeView,
  TradeAcceptView,
  TradeOfferBoardEntryView,
  TradeOfferBoardView,
  TradeOfferCancelView,
  TradeOfferView,
} from './market.view';
import { toMarketExchangeView, toTradeOfferBoardEntryView, toTradeOfferView } from './market.view';

// A raw `{resource, amount}` pair as it arrives off the wire (`CreateOfferDto`'s nested
// class), before either field has been narrowed/validated — `createOffer` below is what
// turns this into a real `OfferSide`.
export interface OfferSideInput {
  resource: string;
  amount: number;
}

// The Market: posting an offer, listing it, cancelling one, its lazy expiry (§14, M3d.2), and
// — as of M3d.3 — accepting one, which spawns the two `trade` movements §14 describes. The
// world exchange is still out of scope (M3d.4, per the brief's own boundary). Structured
// exactly like `MovementsService`: `runCommand` + transaction + version-guarded writes +
// i18n-keyed `MarketCommandError`, the concurrency-playbook recipe every command in this
// codebase follows verbatim (`docs/CONCURRENCY_PLAYBOOK.md`).
@Injectable()
export class MarketService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(TradeOffer.name) private readonly tradeOfferModel: Model<TradeOfferDocument>,
    @InjectModel(Settlement.name) private readonly settlementModel: Model<SettlementDocument>,
    @InjectModel(Account.name) private readonly accountModel: Model<AccountDocument>,
    // M3d.3 (§14): `acceptOffer` creates the two `trade` movements directly — `DatabaseModule`
    // (already imported below for every other model here) registers `Movement` globally, so
    // this needs no new module import, exactly like every other cross-feature model injection
    // in this codebase (`MovementsService` already injects `Settlement`/`Account` the same way).
    @InjectModel(Movement.name) private readonly movementModel: Model<MovementDocument>,
    // M3d.4 (§14): `startExchange` writes its own `MarketExchange` document directly, the same
    // reasoning `Movement` above already records — `DatabaseModule` registers it globally, no
    // new module import needed.
    @InjectModel(MarketExchange.name)
    private readonly marketExchangeModel: Model<MarketExchangeDocument>,
    @Inject(EventSchedulerService) private readonly eventScheduler: EventSchedulerService,
    @Inject(GAME_CONFIG) private readonly config: GameConfig,
    // The settle seam (§ M2b.3's own naming): `createOffer`/`cancelOffer` need the *origin*
    // settlement settled and (for creation) ownership-checked — exactly what
    // `SettlementsService.settleSettlementDoc` already does for every other command, reused
    // here rather than reimplemented. See that method's own comment.
    @Inject(SettlementsService) private readonly settlementsService: SettlementsService,
  ) {}

  // Validation order (deliberate, not incidental — mirrors `sendMovement`'s own documented
  // ordering, and `trainUnits`'s "affordability last"): the ownership-checked settle happens
  // first (structurally unavoidable — it's also the 404 for an unknown/foreign settlement);
  // then the Market-building check (cheapest state read, needs only `settled.buildings`);
  // then the account-identity check (no faction — cheap, no second collection read); then
  // shape checks on the two resource sides (real + different kinds, then positive-integer
  // amounts) in the order a player would want them explained — "you named something that
  // isn't a resource" before "you named a bad amount of it"; then the ratio cap, which needs
  // both amounts already validated as sane numbers; affordability last of all, since it's the
  // only check whose failure the caller can do nothing about except changing the numbers
  // already validated above, and it's the one this codebase's convention (`startBuild`,
  // `trainUnits`, `sendMovement`) always puts last.
  async createOffer(
    fromSettlementId: string,
    accountId: Types.ObjectId,
    faction: Faction | undefined,
    giveInput: OfferSideInput,
    wantInput: OfferSideInput,
    now: number,
  ): Promise<TradeOfferView> {
    this.assertValidSettlementId(fromSettlementId);

    return this.runCommand(async (session) => {
      const settled = await this.settlementsService.settleSettlementDoc(
        fromSettlementId,
        accountId,
        now,
        session,
      );

      // 1. A Market at level >= 1 — merchants (and so the whole board) don't exist below
      // that (§14: "merchants = merchantsPerLevel * Market level").
      const marketLevel = currentLevelOf(toBuildingLevels(settled.buildings), 'market');
      if (marketLevel < 1) {
        throw new MarketCommandError('errors.market.noMarket');
      }

      // 2. A faction — merchant capacity/speed are faction-flavoured (§14), mirrors
      // `trainUnits`'s own `errors.training.noFaction` check verbatim: a guest that never
      // registered has none, and there is no principled default faction to fall back to.
      if (!faction) {
        throw new MarketCommandError('errors.market.noFaction');
      }

      // 3. Both sides name a real, and mutually different, resource kind.
      if (!isResourceKind(giveInput.resource)) {
        throw new MarketCommandError('errors.market.unknownResource', {
          side: 'give',
          resource: giveInput.resource,
        });
      }
      if (!isResourceKind(wantInput.resource)) {
        throw new MarketCommandError('errors.market.unknownResource', {
          side: 'want',
          resource: wantInput.resource,
        });
      }
      if (giveInput.resource === wantInput.resource) {
        throw new MarketCommandError('errors.market.sameResource', {
          resource: giveInput.resource,
        });
      }
      const give = { resource: giveInput.resource, amount: giveInput.amount };
      const want = { resource: wantInput.resource, amount: wantInput.amount };

      // 4. Both amounts are positive integers. Technical decision (recorded, brief-mandated):
      // resources are floats internally (M1 §10), but an offer is a player-typed quantity,
      // not an accrued one — allowing e.g. "give 12.5 scrap" would expose sub-unit precision
      // a form field was never meant to carry, for no real gameplay benefit.
      if (!Number.isInteger(give.amount) || give.amount <= 0) {
        throw new MarketCommandError('errors.market.invalidAmount', {
          side: 'give',
          amount: give.amount,
        });
      }
      if (!Number.isInteger(want.amount) || want.amount <= 0) {
        throw new MarketCommandError('errors.market.invalidAmount', {
          side: 'want',
          amount: want.amount,
        });
      }

      // 5. The ratio cap (§14) — both weighted values travel in the error params so the
      // client can explain *why* without recomputing `weightedResourceValue` itself.
      if (!isOfferRatioLegal(this.config, give, want)) {
        throw new MarketCommandError('errors.market.ratioOutOfRange', {
          giveValue: weightedResourceValue(this.config, give.resource, give.amount),
          wantValue: weightedResourceValue(this.config, want.resource, want.amount),
          maxOfferRatio: this.config.market.maxOfferRatio,
        });
      }

      // 6. Affordability last, against the just-settled settlement (mirrors `trainUnits`'s
      // own affordability-last ordering) — a lazily-accrued balance is checked at its real,
      // current value, not a stale snapshot from before `settleSettlementDoc` ran.
      const cost = emptyResources();
      cost[give.resource] = give.amount;
      if (!canAfford(settled.resources.values, cost)) {
        throw new MarketCommandError('errors.market.insufficientResources', {
          resource: give.resource,
          required: give.amount,
          available: settled.resources.values[give.resource],
        });
      }

      const newValues = subtractResources(settled.resources.values, cost);
      const merchantsNeeded = merchantsNeededFor(this.config, faction, give.amount);
      const expiresAt = now + this.config.market.offerTtlMs;

      // Pre-generated so the `tradeOfferExpire` event's payload can reference the offer by id
      // before the offer document itself is inserted — mirrors `sendMovement`'s own
      // `movementId = new Types.ObjectId()` pattern.
      const offerId = new Types.ObjectId();
      const expireEvent = await this.eventScheduler.scheduleEvent(
        {
          type: TRADE_OFFER_EXPIRE_EVENT_TYPE,
          dueAt: expiresAt,
          payload: { offerId: String(offerId) },
        },
        session,
      );

      const [offer] = await this.tradeOfferModel.create(
        [
          {
            _id: offerId,
            accountId,
            fromSettlementId: settled._id,
            give,
            want,
            merchantsNeeded,
            status: 'open',
            expiresAt,
            expireEventId: expireEvent._id,
            version: 0,
          },
        ],
        { session },
      );
      if (!offer) {
        throw new Error('MarketService: offer creation returned no document');
      }

      // Deliberately NOT reserving merchants here (owner decision E, "Owner decisions during
      // M3d", `docs/PROGRESS.md`): an open offer costs nothing but its already-deducted
      // resources. `Settlement.busyMerchants` is untouched by this command — its first writer
      // is M3d.3's acceptance flow. Accepted cost, per that decision: several of this
      // settlement's offers accepted at once, with too few free merchants to cover all of
      // them, means the extra accepts fail at that later step — not this command's problem to
      // prevent.
      const updatedSettlement = await this.settlementModel.findOneAndUpdate(
        { _id: settled._id, version: settled.version },
        { $set: { 'resources.values': newValues, version: settled.version + 1 } },
        { session },
      );
      if (!updatedSettlement) {
        throw new VersionConflictError();
      }

      return toTradeOfferView(offer, now);
    });
  }

  // The board (§14/M3d.2's own brief): every OPEN offer in the world, newest first, plus a
  // flag marking the caller's own. Offers are public (this is a marketplace) — read-only, no
  // transaction, no lazy settling of anyone's resources, same reason `MapService.getMapView`
  // and `MovementsService.listIncoming` never open a session either.
  async listOffers(accountId: Types.ObjectId, now: number): Promise<TradeOfferBoardView> {
    const offers = await this.tradeOfferModel.find({ status: 'open' }).sort({ createdAt: -1 });
    if (offers.length === 0) {
      return { offers: [], serverTime: now };
    }

    // Origin settlements + their owners, resolved as two batched queries joined in memory —
    // not a per-offer lookup and not a `$lookup` aggregation. Same pattern
    // `MovementsService.listIncoming` already establishes for exactly this two-hop join (an
    // offer -> its origin settlement -> that settlement's owner), which itself cites
    // `MapService.getMapView` as the shape's own precedent.
    const settlementIds = [...new Set(offers.map((o) => String(o.fromSettlementId)))];
    const settlements = await this.settlementModel.find(
      { _id: { $in: settlementIds } },
      'x y accountId',
    );
    const settlementById = new Map(settlements.map((s) => [String(s._id), s]));

    const ownerIds = [...new Set(settlements.map((s) => String(s.accountId)))];
    const owners = await this.accountModel.find({ _id: { $in: ownerIds } }, 'name');
    const ownerById = new Map(owners.map((a) => [String(a._id), a]));

    const views: TradeOfferBoardEntryView[] = [];
    for (const offer of offers) {
      // Every offer's `fromSettlementId` references a real settlement, and every
      // settlement's `accountId` a real account — neither is ever deleted (the same
      // invariant `MapService.getMapView`'s own owner join relies on). Skipped rather than
      // thrown for the same reason that comment gives: a read model should not fail an
      // entire response over one stale row.
      const settlement = settlementById.get(String(offer.fromSettlementId));
      if (!settlement) continue;
      const owner = ownerById.get(String(settlement.accountId));
      if (!owner) continue;

      views.push(
        toTradeOfferBoardEntryView(
          offer,
          now,
          offer.accountId.equals(accountId),
          { x: settlement.x, y: settlement.y },
          owner.name,
        ),
      );
    }

    return { offers: views, serverTime: now };
  }

  // Owner-only cancel: refunds 100% of `give.amount`, clamped to the origin settlement's own
  // storage caps (overflow lost, same rule loot already follows — `computeOfferRefund`'s own
  // comment). Flips `status` to `'cancelled'`, deletes the pending `tradeOfferExpire` event,
  // and returns what was actually refunded vs. lost so a synchronous caller can see the
  // clamp. Cancelling an offer that is not `open` is `errors.market.offerNotOpen`; another
  // account's offer is `errors.market.offerNotFound` (same "don't leak existence" convention
  // as `MovementNotFoundError`).
  //
  // Two-document write (settlement + offer), one account, one transaction — `settled ->
  // offer` is the only order this command (or `TradeOfferExpireHandler`, the only other
  // writer of either document) ever acquires them in, so §18.3's ascending-`_id` ordering
  // rule has nothing to protect against here: that rule exists to stop two *different* code
  // paths from grabbing the same pair in opposite orders, and there is only ever this one
  // order in this feature. The playbook's race property still holds under two concurrent
  // cancels of the same offer: whichever transaction commits first wins both writes; the
  // loser's version-guarded write (on whichever document it reaches first) fails, the whole
  // command retries from scratch (`runCommand`), and the retry's fresh read of the offer finds
  // `status !== 'open'` and rejects cleanly with `offerNotOpen` — no double refund, exactly
  // the shape `docs/CONCURRENCY_PLAYBOOK.md` §6 describes for `startBuild`'s own race test.
  async cancelOffer(
    offerId: string,
    accountId: Types.ObjectId,
    now: number,
  ): Promise<TradeOfferCancelView> {
    this.assertValidOfferId(offerId);

    return this.runCommand(async (session) => {
      const offer = await this.tradeOfferModel.findById(offerId, null, { session });
      if (!offer || !offer.accountId.equals(accountId)) {
        throw new TradeOfferNotFoundError(offerId);
      }
      if (offer.status !== 'open') {
        throw new MarketCommandError('errors.market.offerNotOpen', { status: offer.status });
      }

      if (offer.expireEventId) {
        await this.eventScheduler.cancelEvent(offer.expireEventId, session);
      }

      // Ownership was already established above against the OFFER (`offer.accountId`), not
      // the settlement — an offer's `fromSettlementId` is fixed at creation and settlements
      // never change hands (§13/M1 §4), so a second ownership check against the settlement
      // itself could never disagree. `settleSettlementDocUnchecked` is therefore the right
      // seam (mirrors `MovementReturnHandler`'s own use of it for a home settlement it
      // already knows the movement belongs to), not `settleSettlementDoc`'s ownership-
      // checking sibling.
      const homeDoc = await this.settlementsService.settleSettlementDocUnchecked(
        String(offer.fromSettlementId),
        now,
        session,
      );
      if (!homeDoc) {
        // Defensive, mirrors every scheduler handler in this codebase: settlements are never
        // deleted in v1.
        throw new Error(
          `MarketService: origin settlement ${String(offer.fromSettlementId)} missing while ` +
            `cancelling offer ${offerId}`,
        );
      }

      const { values, delivered, lost } = computeOfferRefund(
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
        throw new VersionConflictError();
      }

      const updatedOffer = await this.tradeOfferModel.findOneAndUpdate(
        { _id: offer._id, version: offer.version },
        { $set: { status: 'cancelled', version: offer.version + 1 } },
        { session, returnDocument: 'after' },
      );
      if (!updatedOffer) {
        throw new VersionConflictError();
      }

      return { offer: toTradeOfferView(updatedOffer, now), refunded: delivered, lost };
    });
  }

  // Accepting an offer (M3d.3, §14) — the second half of the two `trade` movements §14
  // promises: "one in each direction, each occupying merchants at both ends." This is the
  // first genuinely two-ACCOUNT, two-document command this feature has needed: `createOffer`
  // and `cancelOffer` (M3d.2) each touch exactly one account's own settlement, which is why
  // `cancelOffer`'s own comment could correctly say §18.3's ascending-`_id` ordering "has
  // nothing to protect against here" — that reasoning does NOT carry over to this method, and
  // it applies from the very first document touch: both settlements are settled in ascending-
  // `_id` order before either role's ownership is even resolved (see the settle block's own
  // comment, mirrored from `MovementsService.settleHostAndOrigin`), not only at the
  // `busyMerchants`/resources writes near the end.
  //
  // Validation order (mirrors `createOffer`'s own documented reasoning: cheapest/most-
  // structural first, affordability and merchants last): offer exists + is `open`
  // (`errors.market.offerNotOpen`) — the cheapest possible rejection, needs no settlement
  // read at all; then `ownOffer` (also state-free beyond the already-loaded offer — rejecting
  // it before paying for a settle is deliberate, see that check's own comment); then both
  // settlements settled ownership-free in ascending-`_id` order, followed immediately by the
  // accepter's own ownership check (also this command's 404) and the offerer's "does it exist
  // at all" defensive one; then Market level >= 1 + a faction on the accepter — the same two
  // checks `createOffer` already makes, reused rather than restated; then affordability; then
  // merchants on both sides (the accepted cost of owner decision E:
  // merchants are only ever checked/occupied at acceptance, never while an offer merely sits
  // open); everything else — the deduction, the two movements, the two settlement writes, the
  // offer's own terminal flip — follows only once every rejection has already had its chance.
  async acceptOffer(
    offerId: string,
    accountId: Types.ObjectId,
    faction: Faction | undefined,
    fromSettlementId: string,
    now: number,
  ): Promise<TradeAcceptView> {
    this.assertValidOfferId(offerId);
    this.assertValidSettlementId(fromSettlementId);

    return this.runCommand(async (session) => {
      const offer = await this.tradeOfferModel.findById(offerId, null, { session });
      if (!offer) {
        throw new TradeOfferNotFoundError(offerId);
      }
      if (offer.status !== 'open') {
        throw new MarketCommandError('errors.market.offerNotOpen', { status: offer.status });
      }

      // Cannot accept your own offer. This is not merely redundant with anything else here —
      // nothing else in this method would catch "the same account on both sides" — and it
      // matters because a self-accept is a pure no-op dressed up as a trade: resources would
      // leave one of the account's own settlements and, two deliveries later, land back on
      // another of that SAME account's settlements, while still burning real merchant
      // capacity at both ends the whole round trip (owner decision E's entire cost) for zero
      // net change in what the account owns. Rejected outright, before any settle, rather
      // than silently allowed to "work" and waste merchants for nothing.
      if (offer.accountId.equals(accountId)) {
        throw new MarketCommandError('errors.market.ownOffer');
      }

      // §18.3, mirrored from `MovementsService.settleHostAndOrigin` (M3c.6): settling a
      // document is itself its FIRST touch, so the ascending-`_id` ordering applies here too —
      // not only to the `busyMerchants`/resources writes further down (§18.3 states the rule
      // for "acquiring" a document with no exception for "a version conflict would sort it
      // out anyway"). Both settlements are therefore settled ownership-free, in ascending-
      // `_id` order, BEFORE either role's ownership is resolved; the accepter's ownership
      // check runs immediately after, in exactly the shape `settleSettlementDoc` applies
      // inline for a single-settlement command — the identical `SettlementNotFoundError`
      // whether `fromSettlementId` is unknown or belongs to someone else (the "don't leak
      // existence" convention every command in this codebase follows). The offerer's
      // settlement is not acting on anyone's behalf (this command is resolving what their
      // already-posted, already-funded offer commits them to), so it gets no comparable
      // ownership check — only the "does it exist at all" defensive one below.
      //
      // The real race this closes: two different offers between the SAME two settlements,
      // accepted concurrently with the offerer/accepter roles reversed between them, would
      // otherwise settle this exact pair in opposite order depending on which offer each
      // command happens to be resolving — a genuine, if rare, instance of the two-different-
      // code-paths-grabbing-the-same-pair-in-opposite-orders hazard §18.3 exists to rule out.
      const offererSettlementIdString = String(offer.fromSettlementId);
      const accepterFirst =
        String(new Types.ObjectId(fromSettlementId)) <
        String(new Types.ObjectId(offererSettlementIdString));

      let accepterSettledUnchecked: SettlementDocument | null;
      let offererSettled: SettlementDocument | null;
      if (accepterFirst) {
        accepterSettledUnchecked = await this.settlementsService.settleSettlementDocUnchecked(
          fromSettlementId,
          now,
          session,
        );
        offererSettled = await this.settlementsService.settleSettlementDocUnchecked(
          offererSettlementIdString,
          now,
          session,
        );
      } else {
        offererSettled = await this.settlementsService.settleSettlementDocUnchecked(
          offererSettlementIdString,
          now,
          session,
        );
        accepterSettledUnchecked = await this.settlementsService.settleSettlementDocUnchecked(
          fromSettlementId,
          now,
          session,
        );
      }

      // Missing or foreign — identical rejection, deferred from the settle call above so the
      // ascending-order guarantee holds regardless of which id turns out to be the caller's
      // own.
      if (!accepterSettledUnchecked || !accepterSettledUnchecked.accountId.equals(accountId)) {
        throw new SettlementNotFoundError(fromSettlementId);
      }
      // `settleSettlementDoc` also runs `ensureStarvationSchedule` on the settlement it
      // settles — reapplied explicitly here, on the now-ownership-confirmed document, so the
      // accepter's own Food gate behaves exactly as it would for any other command acting on
      // their settlement (mirrors `MovementsService.recallSupport`'s identical restoration of
      // this call after its own `settleHostAndOrigin`).
      const accepterSettled = await this.settlementsService.ensureStarvationSchedule(
        accepterSettledUnchecked,
        now,
        session,
      );

      if (!offererSettled) {
        // Defensive, mirrors every other handler/command in this codebase: settlements are
        // never deleted in v1.
        throw new Error(
          `MarketService: offerer settlement ${offererSettlementIdString} missing while ` +
            `accepting offer ${offerId}`,
        );
      }

      // Market level >= 1 + a faction on the ACCEPTER — `createOffer`'s own two checks,
      // reused verbatim: merchant capacity/speed are faction-flavoured (§14), and merchants
      // don't exist below Market level 1 either way. The offerer needed no such re-check —
      // they could not have posted this offer in the first place without both.
      const accepterMarketLevel = currentLevelOf(
        toBuildingLevels(accepterSettled.buildings),
        'market',
      );
      if (accepterMarketLevel < 1) {
        throw new MarketCommandError('errors.market.noMarket');
      }
      if (!faction) {
        throw new MarketCommandError('errors.market.noFaction');
      }

      const give = { resource: offer.give.resource as ResourceKind, amount: offer.give.amount };
      const want = { resource: offer.want.resource as ResourceKind, amount: offer.want.amount };

      // The accepter must actually hold `want.amount` of `want.resource` — the mirror image
      // of `createOffer`'s own affordability check, against the freshly-settled accepter. The
      // offerer's `give` was already deducted at creation (M3d.2) and is not re-checked here.
      const wantCost = emptyResources();
      wantCost[want.resource] = want.amount;
      if (!canAfford(accepterSettled.resources.values, wantCost)) {
        throw new MarketCommandError('errors.market.insufficientResources', {
          resource: want.resource,
          required: want.amount,
          available: accepterSettled.resources.values[want.resource],
        });
      }

      // Merchants, both ends — the accepted cost of owner decision E ("Owner decisions during
      // M3d", `docs/PROGRESS.md`): an open offer reserves no merchants at all, so this is the
      // FIRST moment either side's merchant availability is ever checked. The offerer's own
      // requirement was fixed at creation (`offer.merchantsNeeded`, computed once against
      // their own faction and `give.amount` — `TradeOffer.merchantsNeeded`'s own schema
      // comment) and needs no faction lookup here to re-derive; the accepter's requirement is
      // computed fresh against their own faction and `want.amount`, the same
      // `merchantsNeededFor` `createOffer` already uses for the symmetric case.
      const offererMarketLevel = currentLevelOf(
        toBuildingLevels(offererSettled.buildings),
        'market',
      );
      const offererFreeMerchants =
        merchantsFromMarketLevel(this.config, offererMarketLevel) - offererSettled.busyMerchants;
      if (offererFreeMerchants < offer.merchantsNeeded) {
        throw new MarketCommandError('errors.market.notEnoughMerchants', {
          side: 'offerer',
          required: offer.merchantsNeeded,
          available: offererFreeMerchants,
        });
      }

      const accepterMerchantsNeeded = merchantsNeededFor(this.config, faction, want.amount);
      const accepterFreeMerchants =
        merchantsFromMarketLevel(this.config, accepterMarketLevel) - accepterSettled.busyMerchants;
      if (accepterFreeMerchants < accepterMerchantsNeeded) {
        throw new MarketCommandError('errors.market.notEnoughMerchants', {
          side: 'accepter',
          required: accepterMerchantsNeeded,
          available: accepterFreeMerchants,
        });
      }

      // Deduct `want.amount` from the accepter. The offerer's `give` was already deducted at
      // creation (M3d.2, "deduct at enqueue") — NOT deducted a second time here. That is the
      // entire point of deduct-at-creation (an offer sitting `open` is always fully funded),
      // and double-deducting it now would be the single most likely bug in this step.
      const newAccepterValues = subtractResources(accepterSettled.resources.values, wantCost);

      // The offerer's own faction — a plain lookup, not a re-validation: `createOffer`
      // already required a faction to post this offer (an account's faction never changes
      // after registration, §13 of the M1 record), so unlike the accepter's own faction
      // (freshly re-checked above, since IT is the party invoking this command), this one is
      // guaranteed non-null by construction. Needed only now, for the leg this account's own
      // merchants carry — see the speed comment just below.
      const offererAccount = await this.accountModel.findById(offer.accountId, null, { session });
      if (!offererAccount || !offererAccount.faction) {
        throw new Error(
          `MarketService: offerer account ${String(offer.accountId)} has no faction while ` +
            `accepting offer ${offerId} — should be unreachable (createOffer requires one)`,
        );
      }
      const offererFaction = offererAccount.faction;

      // Two `trade` movements (§14: "one in each direction, each occupying merchants at both
      // ends"), created together in this one transaction. `chebyshevDistance` is symmetric —
      // computed once and reused for both legs — but SPEED is not: §14's faction-flavoured
      // merchant speeds mean the two legs genuinely travel at different rates and can arrive
      // at different times whenever the two accounts' factions differ. Each leg is carried by
      // its OWN sender's merchants, so each leg's travel time uses THAT sender's own faction's
      // speed — a real consequence of §14's design (see `Movement.merchants`'s own comment for
      // the parallel "captured once, at creation" reasoning behind the merchant COUNT).
      const distance = chebyshevDistance(
        { x: offererSettled.x, y: offererSettled.y },
        { x: accepterSettled.x, y: accepterSettled.y },
      );

      const offererToAccepterCargo = emptyResources();
      offererToAccepterCargo[give.resource] = give.amount;
      const offererToAccepterDurationMs = travelTimeMs(
        this.config,
        distance,
        merchantSpeed(this.config, offererFaction),
      );
      const offererToAccepterArriveAt = now + offererToAccepterDurationMs;

      const accepterToOffererCargo = emptyResources();
      accepterToOffererCargo[want.resource] = want.amount;
      const accepterToOffererDurationMs = travelTimeMs(
        this.config,
        distance,
        merchantSpeed(this.config, faction),
      );
      const accepterToOffererArriveAt = now + accepterToOffererDurationMs;

      // Pre-generated so each `movementArrive` event's payload can reference its own movement
      // by id before that movement document is inserted — mirrors
      // `MovementsService.sendMovement`'s own `movementId = new Types.ObjectId()` pattern.
      const offererToAccepterMovementId = new Types.ObjectId();
      const offererToAccepterArriveEvent = await this.eventScheduler.scheduleEvent(
        {
          type: MOVEMENT_ARRIVE_EVENT_TYPE,
          dueAt: offererToAccepterArriveAt,
          payload: { movementId: String(offererToAccepterMovementId) },
        },
        session,
      );

      const accepterToOffererMovementId = new Types.ObjectId();
      const accepterToOffererArriveEvent = await this.eventScheduler.scheduleEvent(
        {
          type: MOVEMENT_ARRIVE_EVENT_TYPE,
          dueAt: accepterToOffererArriveAt,
          payload: { movementId: String(accepterToOffererMovementId) },
        },
        session,
      );

      const [offererToAccepterMovement] = await this.movementModel.create(
        [
          {
            _id: offererToAccepterMovementId,
            ownerAccountId: offer.accountId,
            type: MOVEMENT_TYPE_TRADE,
            fromSettlementId: offererSettled._id,
            toSettlementId: accepterSettled._id,
            target: { x: accepterSettled.x, y: accepterSettled.y },
            units: [],
            cargo: offererToAccepterCargo,
            merchants: offer.merchantsNeeded,
            tradeOfferId: offer._id,
            survivors: [],
            departAt: now,
            arriveAt: offererToAccepterArriveAt,
            returnAt: null,
            status: 'outbound',
            arriveEventId: offererToAccepterArriveEvent._id,
            version: 0,
          },
        ],
        { session },
      );
      if (!offererToAccepterMovement) {
        throw new Error(
          'MarketService: offerer->accepter trade movement creation returned no document',
        );
      }

      const [accepterToOffererMovement] = await this.movementModel.create(
        [
          {
            _id: accepterToOffererMovementId,
            ownerAccountId: accountId,
            type: MOVEMENT_TYPE_TRADE,
            fromSettlementId: accepterSettled._id,
            toSettlementId: offererSettled._id,
            target: { x: offererSettled.x, y: offererSettled.y },
            units: [],
            cargo: accepterToOffererCargo,
            merchants: accepterMerchantsNeeded,
            tradeOfferId: offer._id,
            survivors: [],
            departAt: now,
            arriveAt: accepterToOffererArriveAt,
            returnAt: null,
            status: 'outbound',
            arriveEventId: accepterToOffererArriveEvent._id,
            version: 0,
          },
        ],
        { session },
      );
      if (!accepterToOffererMovement) {
        throw new Error(
          'MarketService: accepter->offerer trade movement creation returned no document',
        );
      }

      // §18.3's ascending-`_id` rule, for real this time (see this method's own header
      // comment): the two Settlement documents this command writes — the offerer's
      // `busyMerchants`, the accepter's `resources.values` + `busyMerchants` — are acquired in
      // that order, the same discipline `BattleArrivalResolver`/`SupportArrivalResolver`
      // already apply to their own two-settlement writes.
      if (String(offererSettled._id) < String(accepterSettled._id)) {
        await this.writeOffererMerchants(offererSettled, offer.merchantsNeeded, session);
        await this.writeAccepterSettlement(
          accepterSettled,
          newAccepterValues,
          accepterMerchantsNeeded,
          session,
        );
      } else {
        await this.writeAccepterSettlement(
          accepterSettled,
          newAccepterValues,
          accepterMerchantsNeeded,
          session,
        );
        await this.writeOffererMerchants(offererSettled, offer.merchantsNeeded, session);
      }

      // §14/owner decision F: an accepted offer must never later expire and refund resources
      // that are already in transit — a real double-spend if missed, since by this point the
      // accepter's `want` is gone from their storage and riding home to the offerer, and the
      // offerer's `give` is riding to the accepter; a stale `tradeOfferExpire` refunding the
      // offerer's `give` a SECOND time on top of a delivery already in flight would create
      // resources from nothing. Deleting the pending event and flipping `status` to
      // `'accepted'` together, in this same transaction, close that hole for good — the
      // `offer.status !== 'open'` guard at the top of this method (and of
      // `TradeOfferExpireHandler`/`cancelOffer`) is what then keeps it closed under replay or
      // a race with either of those.
      if (offer.expireEventId) {
        await this.eventScheduler.cancelEvent(offer.expireEventId, session);
      }

      const updatedOffer = await this.tradeOfferModel.findOneAndUpdate(
        { _id: offer._id, version: offer.version },
        { $set: { status: 'accepted', version: offer.version + 1 } },
        { session, returnDocument: 'after' },
      );
      if (!updatedOffer) {
        throw new VersionConflictError();
      }

      return {
        offer: toTradeOfferView(updatedOffer, now),
        offererToAccepterMovementId: String(offererToAccepterMovementId),
        accepterToOffererMovementId: String(accepterToOffererMovementId),
      };
    });
  }

  // The world exchange (§14, M3d.4): converts `amount` of `from` into `to` at
  // `exchangeOutput`'s fixed weighted rate minus the spread, occupying THIS settlement's own
  // `merchantsNeededFor(config, faction, amount)` merchants for
  // `config.market.exchangeTripMs` before `MarketExchangeHandler` credits the result and
  // frees them. Deliberately NOT a movement — §14 is explicit that nothing travels the map
  // here ("there is no counterparty to travel to") — so this is structurally a single-
  // settlement, settle-validate-deduct-and-schedule command, much closer in shape to
  // `createOffer` above than to `acceptOffer`'s two-account, two-movement one.
  //
  // Validation order mirrors `createOffer`'s own documented reasoning (cheapest/most
  // structural first, affordability and merchants last): the ownership-checked settle happens
  // first (also this command's 404); then the Market-building check and the account-identity
  // check — `createOffer`'s own two checks, reused verbatim rather than restated; then shape
  // checks on `from`/`to` (real resource kinds, then mutually different) in the same
  // "explain what's wrong before what's insufficient" order `createOffer` uses for its own
  // `give`/`want`; then a positive-integer `amount` (the same technical convention M3d.2
  // recorded for offer amounts); then affordability against the settled settlement; then
  // merchants last of all — the one rejection here (like `createOffer`'s own affordability
  // check) whose cause the caller can do nothing about except changing numbers already
  // validated above. Unlike `acceptOffer`, there is only ever ONE settlement's merchants to
  // check — no counterparty, no ascending-`_id` question, no second party's Market level.
  async startExchange(
    fromSettlementId: string,
    accountId: Types.ObjectId,
    faction: Faction | undefined,
    fromInput: string,
    toInput: string,
    amount: number,
    now: number,
  ): Promise<MarketExchangeView> {
    this.assertValidSettlementId(fromSettlementId);

    return this.runCommand(async (session) => {
      const settled = await this.settlementsService.settleSettlementDoc(
        fromSettlementId,
        accountId,
        now,
        session,
      );

      // 1. A Market at level >= 1 — merchants (and so this whole operation) don't exist below
      // that (§14), same reading as `createOffer`'s own check.
      const marketLevel = currentLevelOf(toBuildingLevels(settled.buildings), 'market');
      if (marketLevel < 1) {
        throw new MarketCommandError('errors.market.noMarket');
      }

      // 2. A faction — merchant capacity/speed are faction-flavoured (§14), same reading as
      // `createOffer`'s own check.
      if (!faction) {
        throw new MarketCommandError('errors.market.noFaction');
      }

      // 3. `from`/`to` name real, and mutually different, resource kinds — reuses
      // `errors.market.unknownResource`/`sameResource` verbatim (no new i18n keys needed for
      // this feature: every rejection path below reuses a key `createOffer`/`acceptOffer`
      // already established).
      if (!isResourceKind(fromInput)) {
        throw new MarketCommandError('errors.market.unknownResource', {
          side: 'from',
          resource: fromInput,
        });
      }
      if (!isResourceKind(toInput)) {
        throw new MarketCommandError('errors.market.unknownResource', {
          side: 'to',
          resource: toInput,
        });
      }
      if (fromInput === toInput) {
        throw new MarketCommandError('errors.market.sameResource', { resource: fromInput });
      }
      const from = fromInput;
      const to = toInput;

      // 4. A positive integer amount — identical technical decision to `createOffer`'s own
      // `give`/`want` amounts: resources are floats internally, but a player-typed quantity is
      // not an accrued one.
      if (!Number.isInteger(amount) || amount <= 0) {
        throw new MarketCommandError('errors.market.invalidAmount', { amount });
      }

      // 5. Affordability against the just-settled settlement, checked against the CURRENT
      // (lazily-accrued) balance rather than a stale snapshot — mirrors `createOffer`'s own
      // affordability-last ordering.
      const cost = emptyResources();
      cost[from] = amount;
      if (!canAfford(settled.resources.values, cost)) {
        throw new MarketCommandError('errors.market.insufficientResources', {
          resource: from,
          required: amount,
          available: settled.resources.values[from],
        });
      }

      // 6. Merchants — this settlement's own, both required and occupied by this single
      // operation (§14 names no counterparty for the exchange, unlike `acceptOffer`'s two
      // sides).
      const merchantsNeeded = merchantsNeededFor(this.config, faction, amount);
      const freeMerchants =
        merchantsFromMarketLevel(this.config, marketLevel) - settled.busyMerchants;
      if (freeMerchants < merchantsNeeded) {
        throw new MarketCommandError('errors.market.notEnoughMerchants', {
          required: merchantsNeeded,
          available: freeMerchants,
        });
      }

      // Computed once, at start, from `game-core` — never by hand — and persisted on the
      // exchange document rather than recomputed when `MarketExchangeHandler` later runs
      // (`MarketExchange.output`'s own schema comment explains why: a config retune mid-trip
      // must not change what this specific exchange pays out).
      const output = exchangeOutput(this.config, from, to, amount);
      const completesAt = now + this.config.market.exchangeTripMs;
      const newValues = subtractResources(settled.resources.values, cost);

      // Pre-generated so the `marketExchange` event's payload can reference the exchange by
      // id before the exchange document itself is inserted — mirrors `createOffer`'s own
      // `offerId = new Types.ObjectId()` pattern.
      const exchangeId = new Types.ObjectId();
      const completeEvent = await this.eventScheduler.scheduleEvent(
        {
          type: MARKET_EXCHANGE_EVENT_TYPE,
          dueAt: completesAt,
          payload: { exchangeId: String(exchangeId) },
        },
        session,
      );

      const [exchange] = await this.marketExchangeModel.create(
        [
          {
            _id: exchangeId,
            accountId,
            settlementId: settled._id,
            from,
            to,
            amount,
            output,
            merchantsOccupied: merchantsNeeded,
            status: 'pending',
            startedAt: now,
            completesAt,
            completeEventId: completeEvent._id,
            version: 0,
          },
        ],
        { session },
      );
      if (!exchange) {
        throw new Error('MarketService: exchange creation returned no document');
      }

      // Deduct `amount` of `from` and occupy the merchants together, in the ONE settlement
      // write this single-settlement command ever needs — no ascending-`_id` ordering
      // question the way `acceptOffer`'s two-settlement writes have, since there is only ever
      // one document to acquire here.
      const updatedSettlement = await this.settlementModel.findOneAndUpdate(
        { _id: settled._id, version: settled.version },
        {
          $set: {
            'resources.values': newValues,
            busyMerchants: settled.busyMerchants + merchantsNeeded,
            version: settled.version + 1,
          },
        },
        { session },
      );
      if (!updatedSettlement) {
        throw new VersionConflictError();
      }

      return toMarketExchangeView(exchange, now);
    });
  }

  private async writeOffererMerchants(
    offererSettled: SettlementDocument,
    merchantsToAdd: number,
    session: ClientSession,
  ): Promise<void> {
    const updated = await this.settlementModel.findOneAndUpdate(
      { _id: offererSettled._id, version: offererSettled.version },
      {
        $set: {
          busyMerchants: offererSettled.busyMerchants + merchantsToAdd,
          version: offererSettled.version + 1,
        },
      },
      { session },
    );
    if (!updated) {
      throw new VersionConflictError();
    }
  }

  private async writeAccepterSettlement(
    accepterSettled: SettlementDocument,
    newValues: Resources,
    merchantsToAdd: number,
    session: ClientSession,
  ): Promise<void> {
    const updated = await this.settlementModel.findOneAndUpdate(
      { _id: accepterSettled._id, version: accepterSettled.version },
      {
        $set: {
          'resources.values': newValues,
          busyMerchants: accepterSettled.busyMerchants + merchantsToAdd,
          version: accepterSettled.version + 1,
        },
      },
      { session },
    );
    if (!updated) {
      throw new VersionConflictError();
    }
  }

  private assertValidSettlementId(settlementId: string): void {
    if (!Types.ObjectId.isValid(settlementId)) {
      throw new SettlementNotFoundError(settlementId);
    }
  }

  private assertValidOfferId(offerId: string): void {
    if (!Types.ObjectId.isValid(offerId)) {
      throw new TradeOfferNotFoundError(offerId);
    }
  }

  // The concurrency-playbook command runner — mirrors `MovementsService.runCommand`/
  // `SettlementsService.runCommand` exactly (see either's own comment for the two-layer
  // retry rationale): every command runs inside its own transaction; a `VersionConflictError`
  // means another command raced this one and won, so the whole command retries from scratch
  // against fresh state, up to `MAX_COMMAND_ATTEMPTS` times. Any other thrown error is not a
  // race and propagates immediately, unretried.
  private async runCommand<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= MAX_COMMAND_ATTEMPTS; attempt += 1) {
      const session = await this.connection.startSession();
      try {
        let result: T | undefined;
        await session.withTransaction(async () => {
          result = await fn(session);
        });
        return result as T;
      } catch (error) {
        if (!(error instanceof VersionConflictError)) {
          throw error;
        }
        // Falls through to the next attempt unless this was the last one.
      } finally {
        await session.endSession();
      }
    }
    throw new CommandConflictRetryExhaustedError();
  }
}
