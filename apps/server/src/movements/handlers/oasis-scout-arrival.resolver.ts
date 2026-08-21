import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { EventSchedulerService } from '../../scheduler/event-scheduler.service';
import type { GameEventDocument } from '../../schemas/event.schema';
import type { MovementDocument } from '../../schemas/movement.schema';
import { Movement, MOVEMENT_TYPE_SCOUT } from '../../schemas/movement.schema';
import type { OasisDocument } from '../../schemas/oasis.schema';
import type { ReportDocument } from '../../schemas/report.schema';
import { REPORT_TYPE_SCOUT, REPORT_TYPE_SCOUT_FAILED, Report } from '../../schemas/report.schema';
import { MOVEMENT_RETURN_EVENT_TYPE } from '../movements.constants';
import { computeReturnAt, turnAroundOutboundMovement } from '../movements.util';
import type { OasisArrivalResolver } from './oasis-arrival-resolver.interface';

// Resolves a scout movement's arrival at a farm oasis (M3c.7a, `docs/M3_DESIGN_DECISIONS.md`
// §10) — the oasis-target sibling of `ScoutArrivalResolver`, modelled on it for structure and
// comment style, but deliberately much simpler, because §10 says so explicitly: "Scouting an
// oasis is now allowed: the report shows the defender composition and the current Food pool.
// No intel tiers — there is nothing deeper to gate." Concretely, this resolver skips every
// step `ScoutArrivalResolver` needs for a settlement target:
//
// - **No scout-vs-scout combat.** An oasis has no scouts of its own; its wildlife garrison is
//   defence-only against a real battle (`scoutAttack: 0`/`scoutDefense: 0` in the catalogue,
//   §1/§10) — there is nothing on the oasis side that can contest a scouting mission at all.
//   Nothing dies, the whole force always survives, `movement.units`/the origin's
//   `awayTroops` are both left completely untouched (nobody died, and nobody is home yet
//   either), and the movement always turns around.
// - **No detection and no counter-report** — there is no owner to report to (§10: oases are
//   "still not annexable... no ownership field").
// - **No tiers.** This resolver never calls `resolveScouting`/`incomingDetailTier` or any
//   other scouting intel-tier helper — there is only one shape of report to write, always.
// - **One report, the existing `scout` type.** §15's report table lists
//   `scout`/`scoutFailed`/`scoutDetected` as "unchanged from M2" and allocates no new type
//   for oasis scouting — this resolver reuses `REPORT_TYPE_SCOUT` (and, for the missing-
//   target edge case below, `REPORT_TYPE_SCOUT_FAILED`) rather than minting a distinct kind,
//   and carries a `targetKind: 'oasis'` discriminator in the payload so the M3e report
//   renderer can tell an oasis scout report from a settlement one without inspecting which id
//   field is present.
@Injectable()
export class OasisScoutArrivalResolver implements OasisArrivalResolver {
  readonly types = [MOVEMENT_TYPE_SCOUT] as const;

  constructor(
    @InjectModel(Movement.name) private readonly movementModel: Model<MovementDocument>,
    @InjectModel(Report.name) private readonly reportModel: Model<ReportDocument>,
    @Inject(EventSchedulerService) private readonly eventScheduler: EventSchedulerService,
  ) {}

  async resolveArrival(
    movement: MovementDocument,
    targetDoc: OasisDocument,
    event: GameEventDocument,
    session: ClientSession,
  ): Promise<void> {
    // Structured ids + numbers only, never prose (§15/M1 §15). `defenders`/`food` are read
    // straight off `targetDoc` — the shared `MovementArriveHandler` preamble already settled
    // it to `event.dueAt` via `OasisService.settleOasisDocUnchecked` before this resolver
    // ever runs, so this is the exact composition/pool a scout standing there at that instant
    // would see. `targetDoc.defenders` is reshaped off its Mongoose subdocument array into
    // plain objects here (the same hazard `toPlainQueueItem`'s comment describes,
    // `settlements/build-queue.util.ts`) since it is headed for a report `payload`, not read
    // back into a formula.
    await this.reportModel.create(
      [
        {
          accountId: movement.ownerAccountId,
          type: REPORT_TYPE_SCOUT,
          read: false,
          payload: {
            movementId: String(movement._id),
            fromSettlementId: String(movement.fromSettlementId),
            toOasisId: String(movement.toOasisId),
            target: { x: movement.target.x, y: movement.target.y },
            defenders: targetDoc.defenders.map((d) => ({ unitType: d.unitType, count: d.count })),
            food: targetDoc.loot.food,
            targetKind: 'oasis',
          },
        },
      ],
      { session },
    );

    // Every unit the army left home with turns around unharmed (see this class's own
    // top-of-file comment for why) — reuses the exact `computeReturnAt` + `scheduleEvent` +
    // version-guarded update shape `ScoutArrivalResolver` uses for its own no-losses case.
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
        `OasisScoutArrivalResolver: version conflict applying movement ${String(movement._id)}`,
      );
    }
  }

  // The M2-defensive edge case (§6/§10): the target oasis is gone by the time the scouts
  // arrive — cannot happen under v1's own rules (oases are never deleted), but the handler
  // defends anyway rather than assuming it. Byte-for-byte the same shape
  // `ScoutArrivalResolver.resolveMissingTarget` uses for a missing settlement: a
  // `scoutFailed` report with `reason: 'targetNotFound'`, then
  // `turnAroundOutboundMovement`.
  async resolveMissingTarget(
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

    await turnAroundOutboundMovement(
      movement,
      event,
      this.eventScheduler,
      this.movementModel,
      session,
    );
  }
}
