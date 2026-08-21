import type { GameConfig } from '@last-signal/game-core';
import { calcInfluence, settlementsAllowed } from '@last-signal/game-core';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { isDuplicateKeyError } from '../../database/mongo-errors.util';
import { GAME_CONFIG } from '../../game-config/game-config.tokens';
import { NotificationsService } from '../../notifications/notifications.service';
import { PlacementService } from '../../placement/placement.service';
import { EventSchedulerService } from '../../scheduler/event-scheduler.service';
import type { AccountDocument } from '../../schemas/account.schema';
import { Account } from '../../schemas/account.schema';
import type { GameEventDocument } from '../../schemas/event.schema';
import type { MovementDocument } from '../../schemas/movement.schema';
import { Movement } from '../../schemas/movement.schema';
import { NOTIFICATION_KIND_SETTLEMENT_FOUNDED } from '../../schemas/notification.schema';
import type { OasisDocument } from '../../schemas/oasis.schema';
import { Oasis } from '../../schemas/oasis.schema';
import type { ReportDocument } from '../../schemas/report.schema';
import { REPORT_TYPE_SETTLE, Report } from '../../schemas/report.schema';
import type { SettlementDocument } from '../../schemas/settlement.schema';
import { Settlement } from '../../schemas/settlement.schema';
import { SettlementsService } from '../../settlements/settlements.service';
import { toBuildingLevels } from '../../settlements/settlements.util';
import { subtractUnitCounts, turnAroundOutboundMovement } from '../movements.util';
import type { TileArrivalResolver } from './tile-arrival-resolver.interface';

// A `settle` failure's stable `reason` discriminator (§15, the same convention
// `ScoutArrivalResolver` uses for `allScoutsDead`/`targetNotFound`). `tileOccupied` covers
// BOTH ways a tile can turn out to already hold something: the up-front re-check finding a
// settlement/oasis already there, and the `{x, y}` unique-index collision discovered only by
// the `create()` call itself losing a genuinely simultaneous race (§13: "the index is the
// final authority... the loser turns around") — from the sender's point of view both are the
// same fact ("someone else got there"), so they share one reason rather than forcing the
// client to treat a millisecond-scale race as a materially different outcome from a tile
// that had already been settled for an hour.
type SettleFailureReason = 'tileOccupied' | 'tileNotSettleable' | 'settlementLimitReached';

// Resolves a `settle` movement's arrival (M3d.1, `docs/M3_DESIGN_DECISIONS.md` §13) — the
// tile-target sibling of `BattleArrivalResolver`/`ScoutArrivalResolver`/
// `OasisBattleArrivalResolver`, structurally simpler than any of them because there is no
// defender, no battle, and (on the happy path) no return leg: the Settlers are either
// consumed founding a new settlement, or they come home unharmed.
//
// **Every legality check from send is re-run here, from scratch, against the world as it
// stands right now** — §13 is explicit that this is not paranoia: "Influence dropped below
// the threshold because a building was destroyed in the meantime" is a real, reachable path
// once M3c.5b's siege pass can knock a building down mid-flight. Re-checking is cheap (three
// reads, no writes) compared to the alternative of trusting stale send-time facts about a
// second-scale-to-hours-long convoy.
@Injectable()
export class SettleArrivalResolver implements TileArrivalResolver {
  private readonly logger = new Logger(SettleArrivalResolver.name);

  constructor(
    @InjectModel(Movement.name) private readonly movementModel: Model<MovementDocument>,
    @InjectModel(Settlement.name) private readonly settlementModel: Model<SettlementDocument>,
    @InjectModel(Oasis.name) private readonly oasisModel: Model<OasisDocument>,
    @InjectModel(Account.name) private readonly accountModel: Model<AccountDocument>,
    @InjectModel(Report.name) private readonly reportModel: Model<ReportDocument>,
    @Inject(EventSchedulerService) private readonly eventScheduler: EventSchedulerService,
    @Inject(GAME_CONFIG) private readonly config: GameConfig,
    // The same legality helper `MovementsService.sendMovement`'s own settle-target branch
    // uses (§13) — reused, not restated, so send-time and arrival-time can never silently
    // disagree about what "still settleable" means.
    @Inject(PlacementService) private readonly placementService: PlacementService,
    // `createSettlementDoc` (M3d.1): the one shared definition of "what a brand-new
    // settlement looks like" — see that method's own comment in `SettlementsService` for why
    // this resolver, not `SettlementsService.createSettlement`, owns the Influence check,
    // the `{x, y}` collision handling, and (by never calling it) the `protectedUntil` stamp.
    @Inject(SettlementsService) private readonly settlementsService: SettlementsService,
    // §16's `settlementFounded` trigger — enqueued only on the success path (`writeReport`
    // below), never for a turn-around failure.
    @Inject(NotificationsService) private readonly notificationsService: NotificationsService,
  ) {}

  async resolveArrival(
    movement: MovementDocument,
    event: GameEventDocument,
    session: ClientSession,
  ): Promise<void> {
    const originDoc = await this.settlementModel.findById(movement.fromSettlementId, null, {
      session,
    });
    // Defensive, mirrors every other resolver in this module: settlements are never deleted
    // in v1, so a convoy whose own home vanished mid-flight is unreachable in practice.
    // Nothing sane to apply — leave the movement `outbound` rather than guessing.
    if (!originDoc) {
      return;
    }

    const tile = { x: movement.target.x, y: movement.target.y };

    // Re-check 1/3 (§13): is the tile still free? Checked directly (existence, not
    // `isSettleable`) so "something is already there" gets its own precise reason distinct
    // from "there was never anything there, but it fails the general legality rule" —
    // exactly the split `MovementsService.sendMovement`'s own settle-target branch draws at
    // send time, mirrored here rather than restated as a different shape.
    const [settlementAtTile, oasisAtTile] = await Promise.all([
      this.settlementModel.findOne(tile, '_id', { session }),
      this.oasisModel.findOne(tile, '_id', { session }),
    ]);
    if (settlementAtTile || oasisAtTile) {
      await this.turnAround(movement, event, 'tileOccupied', session);
      return;
    }

    // Re-check 2/3 (§13): still `isSettleable` otherwise (on-grid, non-toxic terrain,
    // Chebyshev distance from every existing settlement)? Reuses the exact same helper send
    // validation did (`PlacementService.isTileSettleable`) — see that method's own comment.
    const legal = await this.placementService.isTileSettleable(tile, session);
    if (!legal) {
      await this.turnAround(movement, event, 'tileNotSettleable', session);
      return;
    }

    // Re-check 3/3 (§13): does the sender's Influence still permit another settlement? The
    // exact functions `SettlementsService.createSettlement` uses for the identical gate,
    // read fresh against `movement.ownerAccountId`'s settlements as they stand right now —
    // NOT a value carried over from send time, since §13 names exactly this drift ("a
    // building was destroyed in the meantime") as a real, reachable failure mode.
    const accountSettlements = await this.settlementModel.find(
      { accountId: movement.ownerAccountId },
      'buildings',
      { session },
    );
    const influence = calcInfluence(
      this.config,
      accountSettlements.map((s) => toBuildingLevels(s.buildings)),
    );
    const allowed = settlementsAllowed(this.config, influence);
    if (accountSettlements.length >= allowed) {
      await this.turnAround(movement, event, 'settlementLimitReached', session);
      return;
    }

    // The account's own name, reused for the new settlement — the same value
    // `SettlementsController.create` passes `createSettlement` for an account's first
    // settlement, so a `settle`-founded settlement is named exactly the way any other one
    // would be through the normal player flow, not a second, forked naming convention.
    const account = await this.accountModel.findById(movement.ownerAccountId, 'name', {
      session,
    });
    // Defensive: an account is never deleted in v1 (settlements/movements reference it by id
    // forever), but a scheduler-driven handler must not assume a foreign document it doesn't
    // own can never be gone. Unreachable in practice — the account that trained and sent
    // these Settlers obviously still exists — but a plain `Error`, not a turn-around: this is
    // a "cannot happen" invariant, not a normal game-state outcome §13 anticipates.
    if (!account) {
      throw new Error(
        `SettleArrivalResolver: movement ${String(movement._id)}'s owning account ` +
          `${String(movement.ownerAccountId)} was not found`,
      );
    }

    // The one remaining way to fail (§13, failure case 3): two convoys were both legal at
    // send and both passed every re-check above, and only the `{x, y}` unique index — the
    // final authority — can tell them apart. `createSettlementDoc`'s `create()` throws a
    // duplicate-key error the same way `SettlementsService.createSettlement`'s own retry loop
    // already handles; caught here INSIDE this arrival's own transaction (rather than left to
    // propagate, which would abort the whole transaction and hand the event to the
    // scheduler's retry/backoff instead of resolving it now) — a plain command error like
    // E11000 does not itself abort an in-flight MongoDB transaction, so catching it and
    // continuing to write the turn-around in the SAME transaction is safe. `isDuplicateKeyError`
    // is the only thing this catch treats as expected; anything else is a real defect and
    // propagates, exactly like every other resolver's version-conflict throws in this module.
    let newSettlement: SettlementDocument;
    try {
      newSettlement = await this.settlementsService.createSettlementDoc(
        movement.ownerAccountId,
        account.name,
        tile.x,
        tile.y,
        event.dueAt,
        session,
      );
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
      await this.turnAround(movement, event, 'tileOccupied', session);
      return;
    }

    // §18.3's ascending-`_id` acquisition order exists to stop two CONCURRENT multi-document
    // commands from grabbing the same PAIR of already-existing documents in opposite orders
    // and deadlocking. It does not apply here: `newSettlement` did not exist a moment ago —
    // nothing else in the system can reference it yet (its id was generated by this very
    // `create()` call), so no other concurrent command could ever be attempting to acquire it
    // in the opposite order. The only document this write genuinely contends with is
    // `originDoc`, and there is exactly one of those — "acquire in ascending order" has
    // nothing to order against when there is only one contendable document, so the natural
    // sequence is simply "create the new settlement first (the operation that can fail),
    // then account for the Settlers at the origin (the operation that cannot, once the first
    // one has already committed within this same transaction)".
    await this.writeReport(movement, newSettlement, true, undefined, session);
    await this.consumeSettlersAtOrigin(movement, originDoc, session);

    // §13: "The 3 Settlers are consumed" — no return leg, ever, on a successful founding.
    // Mirrors every other resolver's total-wipe branch (`BattleArrivalResolver`,
    // `ScoutArrivalResolver`): the movement ends `done`, `survivors: []`, nothing scheduled.
    const updated = await this.movementModel.findOneAndUpdate(
      { _id: movement._id, version: movement.version },
      { $set: { status: 'done', survivors: [], version: movement.version + 1 } },
      { session },
    );
    if (!updated) {
      throw new Error(
        `SettleArrivalResolver: version conflict applying movement ${String(movement._id)}`,
      );
    }
  }

  // §13's failure path: the convoy returns home with its Settlers alive, and the sender gets
  // a `settle` report naming which check failed. `turnAroundOutboundMovement` is the one
  // shared implementation of "schedule the return leg, every unit still alive" every other
  // resolver's own `resolveMissingTarget` already uses — nothing died here either, so the
  // mechanics are identical, only the report's payload differs.
  private async turnAround(
    movement: MovementDocument,
    event: GameEventDocument,
    reason: SettleFailureReason,
    session: ClientSession,
  ): Promise<void> {
    await this.writeReport(movement, undefined, false, reason, session);
    await turnAroundOutboundMovement(
      movement,
      event,
      this.eventScheduler,
      this.movementModel,
      session,
    );
  }

  // §15's `settle` report: "founded (with the new settlement id) or the failure reason" —
  // exactly one of `newSettlementId`/`reason` is ever present, discriminated by `founded`,
  // the same structured-ids-and-numbers-only convention (never prose, M1 §15) every other
  // report in this module follows.
  private async writeReport(
    movement: MovementDocument,
    newSettlement: SettlementDocument | undefined,
    founded: boolean,
    reason: SettleFailureReason | undefined,
    session: ClientSession,
  ): Promise<void> {
    const [created] = await this.reportModel.create(
      [
        {
          accountId: movement.ownerAccountId,
          type: REPORT_TYPE_SETTLE,
          read: false,
          payload: {
            movementId: String(movement._id),
            fromSettlementId: String(movement.fromSettlementId),
            target: { x: movement.target.x, y: movement.target.y },
            founded,
            ...(newSettlement ? { newSettlementId: String(newSettlement._id) } : {}),
            ...(reason ? { reason } : {}),
          },
        },
      ],
      { session },
    );

    // §16's `settlementFounded` trigger — success only. A failed founding (the convoy turning
    // around, `founded: false`) is not a "settlement founded" event by any reading of that
    // kind's name, and §16's six kinds have no separate "founding failed" notification —
    // the `settle` REPORT still covers that case (§15), just with no notification riding it.
    if (founded && created) {
      await this.notificationsService.enqueue(
        movement.ownerAccountId,
        NOTIFICATION_KIND_SETTLEMENT_FOUNDED,
        {
          reportId: String(created._id),
          ...(newSettlement ? { newSettlementId: String(newSettlement._id) } : {}),
        },
        session,
      );
    }
  }

  // §13: the 3 Settlers "leave `awayTroops` at the origin for good and are NOT credited
  // anywhere" — the same `subtractUnitCounts` total-wipe shape every other resolver's
  // "the whole departed army is gone" branch uses (`BattleArrivalResolver`/
  // `ScoutArrivalResolver` on a total wipe, `OasisBattleArrivalResolver` likewise), applied
  // to `movement.units` (the Settlers this convoy departed with) rather than any partial
  // loss list — a founding convoy either succeeds whole or fails whole, there is no partial
  // casualty case here at all.
  private async consumeSettlersAtOrigin(
    movement: MovementDocument,
    originDoc: SettlementDocument,
    session: ClientSession,
  ): Promise<void> {
    const { result: originAwayTroops, shortfall } = subtractUnitCounts(
      originDoc.awayTroops.map((t) => ({ unitType: t.unitType, count: t.count })),
      movement.units.map((u) => ({ unitType: u.unitType, count: u.count })),
    );
    if (shortfall.length > 0) {
      this.logger.error(
        `SettleArrivalResolver: awayTroops drifted below zero applying movement ` +
          `${String(movement._id)} at origin ${String(originDoc._id)} — clamped at zero, ` +
          `shortfall: ${JSON.stringify(shortfall)}`,
      );
    }
    const updatedOrigin = await this.settlementModel.findOneAndUpdate(
      { _id: originDoc._id, version: originDoc.version },
      { $set: { awayTroops: originAwayTroops, version: originDoc.version + 1 } },
      { session },
    );
    if (!updatedOrigin) {
      throw new Error(
        `SettleArrivalResolver: version conflict applying movement ${String(movement._id)} (origin awayTroops)`,
      );
    }
  }
}
