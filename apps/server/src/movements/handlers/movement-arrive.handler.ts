import type { GameConfig } from '@last-signal/game-core';
import { calcStorageCaps, resolveScouting } from '@last-signal/game-core';
import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { GAME_CONFIG } from '../../game-config/game-config.tokens';
import type { EventHandler } from '../../scheduler/event-handler.interface';
import { EventSchedulerService } from '../../scheduler/event-scheduler.service';
import type { GameEventDocument } from '../../schemas/event.schema';
import type { MovementDocument } from '../../schemas/movement.schema';
import { Movement } from '../../schemas/movement.schema';
import type { ReportDocument } from '../../schemas/report.schema';
import {
  REPORT_TYPE_SCOUT,
  REPORT_TYPE_SCOUT_DETECTED,
  REPORT_TYPE_SCOUT_FAILED,
  Report,
} from '../../schemas/report.schema';
import { Settlement } from '../../schemas/settlement.schema';
import type { SettlementDocument } from '../../schemas/settlement.schema';
import { SettlementsService } from '../../settlements/settlements.service';
import {
  currentLevelOf,
  toBuildingLevels,
  toTroopCounts,
} from '../../settlements/settlements.util';
import { MOVEMENT_ARRIVE_EVENT_TYPE, MOVEMENT_RETURN_EVENT_TYPE } from '../movements.constants';
import { computeReturnAt, toPlainResourceValues, toPlainUnitCounts } from '../movements.util';

interface MovementArrivePayload {
  movementId: string;
}

// Resolves a scout movement's arrival at its target (M2b.3, `docs/M2_DESIGN_DECISIONS.md`
// §6/§8): settles the defender's resources inside this same transaction (so the intel
// snapshot is exact), calls `game-core`'s `resolveScouting` for combat/intel/detection,
// writes the attacker's report (and the defender's counter-report iff detected), and either
// flips the movement to `returning` with survivors (scheduling `movementReturn`) or ends it
// `done` when nobody survived.
//
// Idempotency guard: re-checks `movement.status` before doing anything — only `outbound`
// means "this arrival hasn't been applied yet". A replay (a crash between this transaction
// committing and the event's own `done` mark landing, both inside the scheduler's own
// transaction per `SchedulerService.dispatch`) finds `status` already advanced past
// `outbound` (by this handler's own earlier, successful run) and no-ops — the same principle
// as `BuildCompleteHandler`'s "item already gone" check, just keyed on a status field instead
// of an array membership, because a movement (unlike a build-queue item) is never removed.
@Injectable()
export class MovementArriveHandler implements EventHandler {
  readonly type = MOVEMENT_ARRIVE_EVENT_TYPE;
  readonly supportedPayloadVersions = [1];

  constructor(
    @InjectModel(Movement.name) private readonly movementModel: Model<MovementDocument>,
    @InjectModel(Settlement.name) private readonly settlementModel: Model<SettlementDocument>,
    @InjectModel(Report.name) private readonly reportModel: Model<ReportDocument>,
    @Inject(EventSchedulerService) private readonly eventScheduler: EventSchedulerService,
    @Inject(SettlementsService) private readonly settlementsService: SettlementsService,
    @Inject(GAME_CONFIG) private readonly config: GameConfig,
  ) {}

  async handle(event: GameEventDocument, session: ClientSession): Promise<void> {
    const payload = event.payload as unknown as MovementArrivePayload;

    const movement = await this.movementModel.findById(payload.movementId, null, { session });
    // The movement itself is gone — nothing left to apply this to. Not expected in practice
    // (movements are never deleted in v1) but defensive rather than throwing, mirroring
    // `BuildCompleteHandler`.
    if (!movement) {
      return;
    }
    if (movement.status !== 'outbound') {
      return;
    }

    // The settle seam (M2b.3): settles the *defender's* resources — ownership-free, since
    // there is no "calling account" for a scheduler-driven handler to check ownership
    // against; see `SettlementsService.settleSettlementDocUnchecked`'s own comment. `null`
    // means the target settlement is gone — §6's defended-but-impossible edge case.
    const targetDoc = await this.settlementsService.settleSettlementDocUnchecked(
      String(movement.toSettlementId),
      event.dueAt,
      session,
    );
    if (!targetDoc) {
      await this.resolveMissingTarget(movement, event, session);
      return;
    }

    const originDoc = await this.settlementModel.findById(movement.fromSettlementId, null, {
      session,
    });
    // Defensive, mirrors every other handler in this codebase: settlements are never deleted
    // in v1, so an attacker whose own home vanished mid-flight is unreachable in practice.
    // Nothing sane to apply here — leave the movement `outbound` rather than guessing; a
    // human operator would have to intervene, the same as a `buildComplete` event whose
    // settlement is gone.
    if (!originDoc) {
      return;
    }

    const attackerBuildings = toBuildingLevels(originDoc.buildings);
    const defenderBuildings = toBuildingLevels(targetDoc.buildings);

    const result = resolveScouting(this.config, {
      attackers: toTroopCounts(movement.units),
      defenderHomeTroops: toTroopCounts(targetDoc.troops),
      attackerRadioTowerLevel: currentLevelOf(attackerBuildings, 'radioTower'),
      defenderRadioTowerLevel: currentLevelOf(defenderBuildings, 'radioTower'),
      defenderResources: toPlainResourceValues(targetDoc.resources.values),
      defenderStorageCaps: calcStorageCaps(this.config, defenderBuildings),
      defenderBuildings,
    });

    // The attacker's own report: `scout` (with intel) when at least one scout survived,
    // `scoutFailed` (zero intel) when the whole force died — `result.intel.tier === 'none'`
    // is `resolveScouting`'s own single source of truth for "no intel was gathered", so the
    // report `type` is derived from it rather than re-deriving the same condition separately.
    await this.reportModel.create(
      [
        {
          accountId: movement.ownerAccountId,
          type: result.intel.tier === 'none' ? REPORT_TYPE_SCOUT_FAILED : REPORT_TYPE_SCOUT,
          read: false,
          payload: {
            movementId: String(movement._id),
            fromSettlementId: String(movement.fromSettlementId),
            toSettlementId: String(movement.toSettlementId),
            target: { x: movement.target.x, y: movement.target.y },
            atkPts: result.combat.atkPts,
            defPts: result.combat.defPts,
            lossFraction: result.combat.lossFraction,
            losses: toPlainUnitCounts(result.combat.losses),
            survivors: toPlainUnitCounts(result.combat.survivors),
            intel: result.intel,
            ...(result.intel.tier === 'none' ? { reason: 'allScoutsDead' } : {}),
          },
        },
      ],
      { session },
    );

    // The defender's counter-report (§8): iff they had at least one scout home at arrival.
    // Says nothing about what intel was obtained — only who scouted them.
    if (result.detected) {
      await this.reportModel.create(
        [
          {
            accountId: targetDoc.accountId,
            type: REPORT_TYPE_SCOUT_DETECTED,
            read: false,
            payload: {
              movementId: String(movement._id),
              attackerSettlementId: String(movement.fromSettlementId),
              attackerAccountId: String(movement.ownerAccountId),
              at: event.dueAt,
            },
          },
        ],
        { session },
      );
    }

    if (!result.combat.anySurvived) {
      // Total wipe (§8): the movement ends here, `done` — no `movementReturn` to schedule,
      // nobody is coming home. The defender's troops are never touched either way (defender
      // scouts never die on defence — see `resolveScoutCombat`'s own comment).
      const updated = await this.movementModel.findOneAndUpdate(
        { _id: movement._id, version: movement.version },
        { $set: { status: 'done', survivors: [], version: movement.version + 1 } },
        { session },
      );
      if (!updated) {
        throw new Error(
          `MovementArriveHandler: version conflict applying movement ${String(movement._id)}`,
        );
      }
      return;
    }

    const returnAt = computeReturnAt(movement.departAt, event.dueAt);
    const returnEvent = await this.eventScheduler.scheduleEvent(
      {
        type: MOVEMENT_RETURN_EVENT_TYPE,
        dueAt: returnAt,
        payload: { movementId: String(movement._id) },
      },
      session,
    );

    const updated = await this.movementModel.findOneAndUpdate(
      { _id: movement._id, version: movement.version },
      {
        $set: {
          status: 'returning',
          survivors: toPlainUnitCounts(result.combat.survivors),
          returnAt,
          returnEventId: returnEvent._id,
          version: movement.version + 1,
        },
      },
      { session },
    );
    if (!updated) {
      throw new Error(
        `MovementArriveHandler: version conflict applying movement ${String(movement._id)}`,
      );
    }
  }

  // The M2-defensive edge case (§6): the target settlement is gone by the time the scouts
  // arrive — cannot happen under M2's own rules (settlements are never deleted, destroyed or
  // relocated in v1), but the handler defends anyway rather than assuming it. There is no
  // defender to fight, so no combat resolves at all: the whole force turns around unharmed,
  // and the attacker gets a `scoutFailed` report explaining why (`reason: 'targetNotFound'`,
  // distinct from the combat-caused `'allScoutsDead'` — both share the `scoutFailed` `type`
  // since the report schema's `type` enum is fixed to the three kinds §8 specifies; the
  // `reason` field in the payload is what actually distinguishes them for the client).
  private async resolveMissingTarget(
    movement: MovementDocument,
    event: GameEventDocument,
    session: ClientSession,
  ): Promise<void> {
    await this.reportModel.create(
      [
        {
          accountId: movement.ownerAccountId,
          type: REPORT_TYPE_SCOUT_FAILED,
          read: false,
          payload: {
            movementId: String(movement._id),
            fromSettlementId: String(movement.fromSettlementId),
            target: { x: movement.target.x, y: movement.target.y },
            reason: 'targetNotFound',
          },
        },
      ],
      { session },
    );

    const returnAt = computeReturnAt(movement.departAt, event.dueAt);
    const returnEvent = await this.eventScheduler.scheduleEvent(
      {
        type: MOVEMENT_RETURN_EVENT_TYPE,
        dueAt: returnAt,
        payload: { movementId: String(movement._id) },
      },
      session,
    );

    const updated = await this.movementModel.findOneAndUpdate(
      { _id: movement._id, version: movement.version },
      {
        $set: {
          status: 'returning',
          survivors: movement.units.map((u) => ({ unitType: u.unitType, count: u.count })),
          returnAt,
          returnEventId: returnEvent._id,
          version: movement.version + 1,
        },
      },
      { session },
    );
    if (!updated) {
      throw new Error(
        `MovementArriveHandler: version conflict applying movement ${String(movement._id)} ` +
          '(missing target)',
      );
    }
  }
}
