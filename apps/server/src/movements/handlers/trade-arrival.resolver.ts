import type { GameConfig, Resources } from '@last-signal/game-core';
import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { GAME_CONFIG } from '../../game-config/game-config.tokens';
import { EventSchedulerService } from '../../scheduler/event-scheduler.service';
import type { GameEventDocument } from '../../schemas/event.schema';
import type { MovementDocument } from '../../schemas/movement.schema';
import { Movement, MOVEMENT_TYPE_TRADE } from '../../schemas/movement.schema';
import type { ReportDocument } from '../../schemas/report.schema';
import { REPORT_TYPE_TRADE, Report } from '../../schemas/report.schema';
import type { SettlementDocument } from '../../schemas/settlement.schema';
import { Settlement } from '../../schemas/settlement.schema';
import { toBuildingLevels } from '../../settlements/settlements.util';
import { MOVEMENT_RETURN_EVENT_TYPE } from '../movements.constants';
import {
  computeReturnAt,
  creditResourcesClamped,
  turnAroundOutboundMovement,
} from '../movements.util';
import type { MovementArrivalResolver } from './movement-arrival-resolver.interface';

// Resolves a `trade` movement's arrival (M3d.3, `docs/M3_DESIGN_DECISIONS.md` §14/§9/§15/§18)
// — the fourth and, per M3d's own count, LAST arrival resolver `MovementArriveHandler`'s
// settlement-target registry ever needed to gain (`ScoutArrivalResolver`, `BattleArrivalResolver`,
// `SupportArrivalResolver`, and now this one — every settlement-target `MovementType` has a
// resolver as of this step; see that handler's own updated guard comment).
//
// Unlike a raid/assault, a trade never fights and never re-checks anything about the target —
// `MarketService.acceptOffer` already validated both settlements, both merchants, and the
// accepter's affordability once, atomically, at acceptance (§18: the two-document write for
// this feature lives THERE, not here — this resolver only ever touches ONE settlement
// document, the destination, so it needs none of `BattleArrivalResolver`'s/
// `SupportArrivalResolver`'s ascending-`_id` two-document discipline). What this resolver does
// is purely mechanical: credit `movement.cargo` into the destination, clamped to its storage
// caps exactly like loot (`creditResourcesClamped`, `movements.util.ts` — shared with
// `MovementReturnHandler`'s loot/cargo-refund paths so there is only one copy of that
// arithmetic anywhere in this module), tell the receiving party, then turn the merchants
// around for home — merchants are never lost, never attacked (§14), so there is no battle
// step, no siege step, nothing but delivery and a return leg.
//
// **Is cancelling a trade leg supported? Yes — decided and documented here, since this is the
// resolver whose own "already delivered" bookkeeping is what makes it safe.** §9 states the
// 90s cancel window "applies to every outbound movement type", and nothing about `trade`
// structurally forbids it: `MovementsService.cancelMovement` is completely generic (it only
// flips `status` and reschedules a return, unaware of `cargo`/`merchants`/`tradeOfferId`), so
// it needed NO code changes at all to also work correctly for a trade leg. Correctness lives
// entirely in `movement.cargo` staying present when a leg is cancelled (this resolver only
// ever clears it on a successful `resolveArrival`, below) — `MovementReturnHandler` reads
// that same presence/absence to know whether the goods still need to come home, and always
// frees `movement.merchants` on return regardless of how the leg got there. A half-supported
// cancel that turned the movement around without preserving `cargo`, or without eventually
// freeing `movement.merchants`, would strand real resources or real merchants — worse than
// rejecting cancel outright — so the design was built to be genuinely correct rather than
// half right: each leg is its own independent `Movement`, owned by whichever party sent it
// (the offerer for the give-leg, the accepter for the want-leg — `MarketService.acceptOffer`),
// so either party can cancel ONLY their own leg, exactly like any other movement. The OTHER
// leg is entirely unaffected and completes normally.
//
// **§15's report allocation, worked out in full because "both parties get one" is genuinely
// non-trivial for a two-leg, two-return trade.** A trade's one fact-pair — "resources
// delivered" (known the instant ONE leg arrives) and "merchants freed" (known only once the
// OTHER, unrelated leg later returns home) — lives on two different `Movement` documents that
// share no field except the offer they both came from. So this resolver and
// `MovementReturnHandler` jointly maintain ONE report per party, found by
// `(accountId, type: 'trade', payload.tradeOfferId)`:
//   - `resolveArrival` (here) always addresses the RECEIVING party (`targetDoc.accountId` —
//     the party whose settlement is credited) and upserts `resourcesDelivered`/`resourcesLost`.
//   - `MovementReturnHandler`, at THIS SAME leg's own later return, addresses the SENDER
//     (`movement.ownerAccountId` — the party whose merchants are coming home) and upserts
//     `merchantsFreed: true` on the SAME `tradeOfferId`-keyed document.
//   Tracing one full trade: leg1 (offerer -> accepter) arrival credits the ACCEPTER and
//   upserts the accepter's own report; leg1's later return frees the OFFERER's merchants and
//   upserts a SEPARATE report addressed to the OFFERER. leg2 (accepter -> offerer) arrival
//   credits the OFFERER — the SAME report leg1's return already touched (or will touch),
//   found by the same `(offerer, 'trade', tradeOfferId)` key — adding `resourcesDelivered`
//   without disturbing whatever `merchantsFreed` value is already there; leg2's own later
//   return frees the ACCEPTER's merchants, updating the accepter's report from leg1's arrival.
//   Net result: exactly two `trade` reports ever exist for one accepted offer — one per
//   party, addressed by `payload.tradeOfferId` — never zero, never four. Neither writer needs
//   to know which of the two events (across either leg) happens first: `upsert: true`
//   (`MovementReturnHandler`'s own comment on its half of this pair has the full reasoning for
//   why an upsert, uniquely, is correct here) makes the ordering irrelevant. That reasoning
//   only covers *order*, not *concurrency* — there is no unique index on `(accountId, type,
//   payload.tradeOfferId)`, so two truly simultaneous upserts on that key would each insert
//   their own document instead of one updating the other's. What makes that unreachable is
//   §18's single-process scheduler dispatching one event at a time (the same load-bearing
//   property §18 already names): this resolver and `MovementReturnHandler` can never be
//   mid-flight together, so "unordered" here only ever means "either could run first," never
//   "both at once."
//
// **The missing-target edge case is intentionally its OWN, self-contained report** (never
// happens in v1 — settlements are never deleted — but every resolver in this module defends
// against it anyway): `resolveMissingTarget` below writes `reason: 'targetNotFound'` straight
// onto the SAME `tradeOfferId`-keyed document (there is no "receiving party" to credit, so
// there is nothing to defer to a later event), then turns the leg around WITHOUT clearing
// `cargo` — the goods and the merchants both come home via the ordinary return path, and that
// return's own `merchantsFreed: true` update lands on this exact report, giving the sender one
// coherent record of "it never arrived, and here's what came back."
@Injectable()
export class TradeArrivalResolver implements MovementArrivalResolver {
  readonly types = [MOVEMENT_TYPE_TRADE] as const;

  constructor(
    @InjectModel(Movement.name) private readonly movementModel: Model<MovementDocument>,
    @InjectModel(Settlement.name) private readonly settlementModel: Model<SettlementDocument>,
    @InjectModel(Report.name) private readonly reportModel: Model<ReportDocument>,
    @Inject(EventSchedulerService) private readonly eventScheduler: EventSchedulerService,
    @Inject(GAME_CONFIG) private readonly config: GameConfig,
  ) {}

  async resolveArrival(
    movement: MovementDocument,
    targetDoc: SettlementDocument,
    event: GameEventDocument,
    session: ClientSession,
  ): Promise<void> {
    // Both are set unconditionally by `MarketService.acceptOffer` for every `trade` movement
    // it ever creates, and neither is ever cleared before this method runs (`cargo` is cleared
    // by THIS method, below, only after a successful delivery). A missing one here is a
    // corrupt document, not a legitimate state — thrown loudly rather than guessed at, the
    // same "refuse to guess" convention `MovementArriveHandler`'s own corrupt-document branch
    // documents.
    if (!movement.cargo) {
      throw new Error(
        `TradeArrivalResolver: movement ${String(movement._id)} has no cargo — corrupt document`,
      );
    }
    if (!movement.tradeOfferId) {
      throw new Error(
        `TradeArrivalResolver: movement ${String(movement._id)} has no tradeOfferId — corrupt document`,
      );
    }

    // §14: merchants deliver, they don't loot — credit the full cargo bundle into the
    // destination's already-settled resources (`targetDoc` was settled to `event.dueAt` by
    // `MovementArriveHandler`'s shared preamble before this resolver ever ran), clamped to its
    // storage caps. Overflow is lost, not banked — same rule loot already follows (§6/M1 §5).
    const cargo: Resources = {
      scrap: movement.cargo.scrap,
      fuel: movement.cargo.fuel,
      electronics: movement.cargo.electronics,
      food: movement.cargo.food,
    };
    const buildings = toBuildingLevels(targetDoc.buildings);
    const { values, delivered, lost } = creditResourcesClamped(
      this.config,
      buildings,
      targetDoc.resources.values,
      cargo,
    );

    const updatedTarget = await this.settlementModel.findOneAndUpdate(
      { _id: targetDoc._id, version: targetDoc.version },
      { $set: { 'resources.values': values, version: targetDoc.version + 1 } },
      { session },
    );
    if (!updatedTarget) {
      throw new Error(
        `TradeArrivalResolver: version conflict crediting cargo to settlement ${String(targetDoc._id)}`,
      );
    }

    // The receiving party's half of the trade's one shared report — see this class's own file
    // comment for the full report-allocation reasoning and why `upsert: true` is required.
    await this.reportModel.findOneAndUpdate(
      {
        accountId: targetDoc.accountId,
        type: REPORT_TYPE_TRADE,
        'payload.tradeOfferId': String(movement.tradeOfferId),
      },
      {
        $set: {
          read: false,
          'payload.fromSettlementId': String(movement.fromSettlementId),
          'payload.toSettlementId': String(targetDoc._id),
          'payload.resourcesDelivered': delivered,
          'payload.resourcesLost': lost,
        },
        $setOnInsert: {
          accountId: targetDoc.accountId,
          type: REPORT_TYPE_TRADE,
          'payload.tradeOfferId': String(movement.tradeOfferId),
          'payload.merchantsFreed': false,
        },
      },
      { session, upsert: true },
    );

    // Turn the merchants around for home — no survivors to carry (there were never any
    // units), and `cargo` is cleared (`$unset`) precisely because it has now been delivered:
    // this is the one write in the whole feature that distinguishes "delivered, nothing left
    // to refund" from "never delivered, must ride home instead" for `MovementReturnHandler`
    // (see that handler's own comment, and `Movement.cargo`'s schema comment).
    const returnAt = computeReturnAt(movement.departAt, event.dueAt);
    const returnEvent = await this.eventScheduler.scheduleEvent(
      {
        type: MOVEMENT_RETURN_EVENT_TYPE,
        dueAt: returnAt,
        payload: { movementId: String(movement._id) },
      },
      session,
    );

    const updatedMovement = await this.movementModel.findOneAndUpdate(
      { _id: movement._id, version: movement.version },
      {
        $set: {
          status: 'returning',
          survivors: [],
          returnAt,
          returnEventId: returnEvent._id,
          version: movement.version + 1,
        },
        $unset: { cargo: '' },
      },
      { session },
    );
    if (!updatedMovement) {
      throw new Error(
        `TradeArrivalResolver: version conflict applying movement ${String(movement._id)}`,
      );
    }
  }

  // The §9/§6 "target missing at arrival" edge case, applied to trade: the destination
  // settlement is gone by the time the merchants arrive (never happens in v1 — settlements
  // are never deleted — but every resolver in this module defends anyway rather than assuming
  // it). Unlike a raid/scout, there is no "reason: targetNotFound" report allocated as its own
  // event here — it lands on the SAME `tradeOfferId`-keyed report `resolveArrival`/
  // `MovementReturnHandler` share (see this class's own file comment), addressed to the
  // SENDER (there is no receiving party to credit — nothing was delivered). `cargo` is
  // deliberately left untouched (NOT cleared) so `MovementReturnHandler` credits it home,
  // clamped, on the ordinary return leg — the goods are never silently destroyed.
  async resolveMissingTarget(
    movement: MovementDocument,
    event: GameEventDocument,
    session: ClientSession,
  ): Promise<void> {
    if (!movement.tradeOfferId) {
      throw new Error(
        `TradeArrivalResolver: movement ${String(movement._id)} has no tradeOfferId — corrupt document`,
      );
    }

    await this.reportModel.findOneAndUpdate(
      {
        accountId: movement.ownerAccountId,
        type: REPORT_TYPE_TRADE,
        'payload.tradeOfferId': String(movement.tradeOfferId),
      },
      {
        $set: {
          read: false,
          'payload.reason': 'targetNotFound',
          'payload.fromSettlementId': String(movement.fromSettlementId),
          'payload.target': { x: movement.target.x, y: movement.target.y },
        },
        $setOnInsert: {
          accountId: movement.ownerAccountId,
          type: REPORT_TYPE_TRADE,
          'payload.tradeOfferId': String(movement.tradeOfferId),
          'payload.merchantsFreed': false,
        },
      },
      { session, upsert: true },
    );

    await turnAroundOutboundMovement(
      movement,
      event,
      this.eventScheduler,
      this.movementModel,
      session,
    );
  }
}
