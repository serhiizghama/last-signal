import { unionTroops } from '@last-signal/game-core';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import type { Types } from 'mongoose';

import { EventSchedulerService } from '../../scheduler/event-scheduler.service';
import type { GameEventDocument } from '../../schemas/event.schema';
import type { MovementDocument } from '../../schemas/movement.schema';
import { Movement, MOVEMENT_TYPE_SUPPORT } from '../../schemas/movement.schema';
import type { SettlementDocument, StationedContingent } from '../../schemas/settlement.schema';
import { Settlement } from '../../schemas/settlement.schema';
import { SettlementsService } from '../../settlements/settlements.service';
import { toTroopCounts } from '../../settlements/settlements.util';
import {
  subtractUnitCounts,
  toPlainUnitCounts,
  turnAroundOutboundMovement,
} from '../movements.util';
import type { UnitCountEntry } from '../movements.util';
import type { MovementArrivalResolver } from './movement-arrival-resolver.interface';

// One stationed contingent, reshaped to plain objects for a `$set` — same hazard
// `toPlainQueueItem`'s comment (`settlements/build-queue.util.ts`) describes for every other
// subdocument array this codebase writes back wholesale.
interface PlainContingent {
  ownerAccountId: Types.ObjectId;
  fromSettlementId: Types.ObjectId;
  troops: UnitCountEntry[];
}

// Resolves a `support` movement's arrival (M3c.6, `docs/M3_DESIGN_DECISIONS.md` §3/§8/§9/§18)
// — the last of the three arrival resolvers `MovementArriveHandler`'s registry dispatches to
// (`ScoutArrivalResolver`, `BattleArrivalResolver`, this one). Unlike either of those, a
// support arrival resolves no combat and schedules no return leg: it is pure bookkeeping —
// §3's "`awayTroops` → `stationedTroops` (on the host) when support arrives" — moving a
// contingent that is already alive and unharmed from one settlement's ledger to another's.
// The units stay at the host indefinitely; the only two ways they ever leave are the
// recall/evict command pair (`MovementsService`, §8), never this resolver again.
//
// §15's reporting table allocates eleven report kinds and none of them is "support arrived":
// the host already sees inbound support in full the instant it lands (§12: "incoming support
// is always fully visible"), so a report here would just be a second copy of information the
// host's own settlement view already carries. `supportLoss` (already shipped, written by
// `BattleArrivalResolver`/`StarvationTickHandler`) is the only support-related report §15
// actually allocates, and it belongs to a different event (this contingent later taking
// casualties), not to arriving safely. This resolver therefore never touches the `reports`
// collection at all — deliberate, not an oversight; do not "fix" this by adding one.
@Injectable()
export class SupportArrivalResolver implements MovementArrivalResolver {
  readonly types = [MOVEMENT_TYPE_SUPPORT] as const;

  // Same pattern as every other resolver/handler in this module — the diagnostic surface for
  // `subtractUnitCounts`'s `shortfall` below (see that function's comment for why it clamps
  // rather than throws).
  private readonly logger = new Logger(SupportArrivalResolver.name);

  constructor(
    @InjectModel(Movement.name) private readonly movementModel: Model<MovementDocument>,
    @InjectModel(Settlement.name) private readonly settlementModel: Model<SettlementDocument>,
    @Inject(EventSchedulerService) private readonly eventScheduler: EventSchedulerService,
    // The M3a.6 starvation lazy-scheduling choke point (`ensureStarvationSchedule`) — needed
    // here for the exact reason `BattleArrivalResolver` already needs it for a siege pass: the
    // host's Food upkeep can newly go negative as a direct effect of this write (it now feeds
    // the guests, §3/owner decision 6), a deficit no pending tick was ever scheduled against.
    @Inject(SettlementsService) private readonly settlementsService: SettlementsService,
  ) {}

  async resolveArrival(
    movement: MovementDocument,
    targetDoc: SettlementDocument,
    event: GameEventDocument,
    session: ClientSession,
  ): Promise<void> {
    const originDoc = await this.settlementModel.findById(movement.fromSettlementId, null, {
      session,
    });
    // Defensive, mirrors every other resolver here: settlements are never deleted in v1, so a
    // supporter whose own home vanished mid-flight is unreachable in practice. Nothing sane to
    // apply here — leave the movement `outbound` rather than guessing.
    if (!originDoc) {
      return;
    }

    // §3 step 2: merge `movement.units` into the host's `stationedTroops` under the
    // contingent identified by `(ownerAccountId, fromSettlementId)`. Two support movements
    // from the same origin are ONE contingent (`stationedContingentKey` in
    // `settlements/settlements.util.ts` already assumes this, and the battle/starvation
    // resolvers already key their own defence/kill-order logic on it) — so an existing match
    // gets its counts added via `unionTroops`, and only a genuinely new `(owner, origin)` pair
    // appends a fresh entry. Every entry (existing and incoming) is reshaped through
    // `toTroopCounts`/`toPlainUnitCounts` rather than spread, per `toPlainQueueItem`'s hazard
    // comment — this array is headed straight for a `$set`.
    const incoming = toTroopCounts(movement.units);
    const contingentIndex = targetDoc.stationedTroops.findIndex(
      (c: StationedContingent) =>
        c.ownerAccountId.equals(movement.ownerAccountId) &&
        c.fromSettlementId.equals(movement.fromSettlementId),
    );
    const updatedStationedTroops: PlainContingent[] = targetDoc.stationedTroops.map((c) => ({
      ownerAccountId: c.ownerAccountId,
      fromSettlementId: c.fromSettlementId,
      troops: toPlainUnitCounts(toTroopCounts(c.troops)),
    }));
    if (contingentIndex === -1) {
      updatedStationedTroops.push({
        ownerAccountId: movement.ownerAccountId,
        fromSettlementId: movement.fromSettlementId,
        troops: toPlainUnitCounts(incoming),
      });
    } else {
      const existing = updatedStationedTroops[contingentIndex];
      if (!existing) {
        // Unreachable: `contingentIndex` was just found by `findIndex` over the exact same
        // array `updatedStationedTroops` was mapped from, at the same length. Narrows the
        // type for TypeScript rather than guarding a real runtime case.
        throw new Error(
          `SupportArrivalResolver: contingent index ${contingentIndex} out of range applying ` +
            `movement ${String(movement._id)}`,
        );
      }
      updatedStationedTroops[contingentIndex] = {
        ...existing,
        troops: toPlainUnitCounts(unionTroops(toTroopCounts(existing.troops), incoming)),
      };
    }

    // §18's ascending-`_id` rule: the two Settlement documents this arrival writes (the
    // host's `stationedTroops`, the supporter origin's `awayTroops`) are acquired in
    // ascending `_id` order — same discipline `BattleArrivalResolver.resolveArrival` applies
    // to its own defender/origin pair, copied here verbatim rather than reinvented.
    // `ensureStarvationSchedule`'s own extra write only ever touches the host (`targetDoc`) —
    // never the origin — so calling it immediately after `writeHostStationedTroops`, on
    // whichever side of the branch that call already sits, cannot reorder the two
    // settlements' first-touch relative to each other.
    if (String(targetDoc._id) < String(originDoc._id)) {
      const updatedHost = await this.writeHostStationedTroops(
        targetDoc,
        updatedStationedTroops,
        movement,
        session,
      );
      await this.settlementsService.ensureStarvationSchedule(updatedHost, event.dueAt, session);
      await this.writeOriginAwayTroops(movement, originDoc, session);
    } else {
      await this.writeOriginAwayTroops(movement, originDoc, session);
      const updatedHost = await this.writeHostStationedTroops(
        targetDoc,
        updatedStationedTroops,
        movement,
        session,
      );
      await this.settlementsService.ensureStarvationSchedule(updatedHost, event.dueAt, session);
    }

    // §3/§8: there is no return leg for a support arrival — the units stay at the host until
    // a recall/evict command sends them home (`MovementsService`, its own new `Movement`
    // document at that point, not this one). This movement simply ends `done`, survivors
    // equal to the whole army that departed (nobody fought, nobody died).
    const updatedMovement = await this.movementModel.findOneAndUpdate(
      { _id: movement._id, version: movement.version },
      {
        $set: {
          status: 'done',
          survivors: movement.units.map((u) => ({ unitType: u.unitType, count: u.count })),
          version: movement.version + 1,
        },
      },
      { session },
    );
    if (!updatedMovement) {
      throw new Error(
        `SupportArrivalResolver: version conflict applying movement ${String(movement._id)}`,
      );
    }
  }

  // The §9/§6 "target missing at arrival" edge case, applied to support: the host settlement
  // is gone by the time the contingent arrives (cannot happen under v1's own rules —
  // settlements are never deleted — but every other resolver defends anyway rather than
  // assuming it, and this one is no exception). §15 allocates no report type for support at
  // all (see this class's own opening comment), so unlike every other resolver's
  // `resolveMissingTarget` there is no report to write here either — this is pure mechanics,
  // sending the whole contingent home unharmed with `awayTroops` left exactly as it is (the
  // units never stopped being "in transit" from the origin's point of view).
  async resolveMissingTarget(
    movement: MovementDocument,
    event: GameEventDocument,
    session: ClientSession,
  ): Promise<void> {
    await turnAroundOutboundMovement(
      movement,
      event,
      this.eventScheduler,
      this.movementModel,
      session,
    );
  }

  // Writes the host's merged `stationedTroops` and returns the updated document —
  // `returnDocument: 'after'`, mirroring `BattleArrivalResolver.writeDefenderSettlement` — so
  // the caller can feed it straight into `ensureStarvationSchedule` without a second read.
  private async writeHostStationedTroops(
    targetDoc: SettlementDocument,
    stationedTroops: PlainContingent[],
    movement: MovementDocument,
    session: ClientSession,
  ): Promise<SettlementDocument> {
    const updated = await this.settlementModel.findOneAndUpdate(
      { _id: targetDoc._id, version: targetDoc.version },
      { $set: { stationedTroops, version: targetDoc.version + 1 } },
      { session, returnDocument: 'after' },
    );
    if (!updated) {
      throw new Error(
        `SupportArrivalResolver: version conflict applying movement ${String(movement._id)} ` +
          `(host stationedTroops)`,
      );
    }
    return updated;
  }

  // Subtracts the whole departed contingent from the origin's `awayTroops` (§3: "back to
  // `awayTroops`... when recalled" implies the mirror image at arrival — the units stop being
  // "away" from the origin's own upkeep the instant they start being fed by the host instead).
  // The ORIGIN's upkeep only ever FALLS as a result of this write (one fewer contingent to
  // pay Food for), so unlike the host, it needs no `ensureStarvationSchedule` call here: a
  // pending tick scheduled against a now-smaller deficit can only become unnecessary, never
  // miss a deficit this write introduced — the same reasoning `BattleArrivalResolver`'s own
  // comment gives for why battle losses alone never need it either.
  private async writeOriginAwayTroops(
    movement: MovementDocument,
    originDoc: SettlementDocument,
    session: ClientSession,
  ): Promise<void> {
    const toSubtract = movement.units.map((u) => ({ unitType: u.unitType, count: u.count }));
    const { result: originAwayTroops, shortfall } = subtractUnitCounts(
      originDoc.awayTroops.map((t) => ({ unitType: t.unitType, count: t.count })),
      toSubtract,
    );
    if (shortfall.length > 0) {
      this.logger.error(
        `SupportArrivalResolver: awayTroops drifted below zero applying movement ` +
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
        `SupportArrivalResolver: version conflict applying movement ${String(movement._id)} (origin awayTroops)`,
      );
    }
  }
}
