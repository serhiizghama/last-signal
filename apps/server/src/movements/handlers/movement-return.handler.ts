import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import type { EventHandler } from '../../scheduler/event-handler.interface';
import type { GameEventDocument } from '../../schemas/event.schema';
import type { MovementDocument } from '../../schemas/movement.schema';
import { Movement } from '../../schemas/movement.schema';
import type { SettlementDocument } from '../../schemas/settlement.schema';
import { Settlement } from '../../schemas/settlement.schema';
import { MOVEMENT_RETURN_EVENT_TYPE } from '../movements.constants';
import { subtractUnitCounts } from '../movements.util';

interface MovementReturnPayload {
  movementId: string;
}

// Credits a movement's survivors back into its home settlement's `troops` (M2b.3,
// `docs/M2_DESIGN_DECISIONS.md` §6) and marks the movement `done`. The counterpart to
// `MovementArriveHandler` — this is the only handler that ever writes home `troops` back up;
// everything else in this module only ever deducts (`MovementsService.sendScouts`).
//
// Idempotency guard: re-checks `movement.status` — only `returning` means "this credit
// hasn't been applied yet". A replay finds `status` already `done` (this handler's own
// earlier, successful run advanced it) and no-ops, so a crash between commit and the event's
// `done` mark can never double-credit survivors. Same principle as
// `MovementArriveHandler`'s own guard.
@Injectable()
export class MovementReturnHandler implements EventHandler {
  readonly type = MOVEMENT_RETURN_EVENT_TYPE;
  readonly supportedPayloadVersions = [1];

  // Same pattern as `SchedulerService`'s own logger — the diagnostic surface for
  // `subtractUnitCounts`'s `shortfall` below (see that function's comment for why it clamps
  // rather than throws).
  private readonly logger = new Logger(MovementReturnHandler.name);

  constructor(
    @InjectModel(Movement.name) private readonly movementModel: Model<MovementDocument>,
    @InjectModel(Settlement.name) private readonly settlementModel: Model<SettlementDocument>,
  ) {}

  async handle(event: GameEventDocument, session: ClientSession): Promise<void> {
    const payload = event.payload as unknown as MovementReturnPayload;

    const movement = await this.movementModel.findById(payload.movementId, null, { session });
    if (!movement) {
      return;
    }
    if (movement.status !== 'returning') {
      return;
    }

    const homeDoc = await this.settlementModel.findById(movement.fromSettlementId, null, {
      session,
    });
    // Defensive, mirrors every other handler here: settlements are never deleted in v1, so
    // this is unreachable in practice. Nothing sane to credit — leave the movement
    // `returning` rather than guessing.
    if (!homeDoc) {
      return;
    }

    // Explicit fields, not `{ ...t }` — `t` is a Mongoose subdocument (see
    // `toPlainQueueItem`'s comment in `settlements/build-queue.util.ts` for why spreading one
    // is unsafe).
    const troops = homeDoc.troops.map((t) => ({ unitType: t.unitType, count: t.count }));
    for (const { unitType, count } of movement.survivors) {
      if (count <= 0) {
        continue;
      }
      const existing = troops.find((t) => t.unitType === unitType);
      if (existing) {
        existing.count += count;
      } else {
        troops.push({ unitType, count });
      }
    }

    // ...and remove the same survivors from `awayTroops` (M3a.4, §3) — they are home now,
    // not in transit, so this settlement stops paying their Food the instant they land.
    // Note carefully what this subtracts: exactly `movement.survivors`, not the movement's
    // original `units`. Anyone who died along the way was already removed from `awayTroops`
    // by `MovementArriveHandler` at the moment of death (dead troops were never "coming
    // home" to subtract here) — so what's left counted as away, by construction, is exactly
    // what this handler is crediting back into `troops` right now. In the normal case
    // `shortfall` is empty; a non-empty one means `awayTroops` had already drifted (e.g. a
    // movement sent before this step existed, whose `awayTroops` was never populated) —
    // logged, not thrown, so the survivors above are still credited home regardless (see
    // `subtractUnitCounts`'s own comment).
    const { result: awayTroops, shortfall } = subtractUnitCounts(
      homeDoc.awayTroops.map((t) => ({ unitType: t.unitType, count: t.count })),
      movement.survivors.map((u) => ({ unitType: u.unitType, count: u.count })),
    );
    if (shortfall.length > 0) {
      this.logger.error(
        `MovementReturnHandler: awayTroops drifted below zero crediting movement ` +
          `${String(movement._id)} home to settlement ${String(homeDoc._id)} — clamped at ` +
          `zero, shortfall: ${JSON.stringify(shortfall)}`,
      );
    }

    const updatedSettlement = await this.settlementModel.findOneAndUpdate(
      { _id: homeDoc._id, version: homeDoc.version },
      { $set: { troops, awayTroops, version: homeDoc.version + 1 } },
      { session },
    );
    if (!updatedSettlement) {
      // A genuine version conflict — something else wrote to this settlement inside the same
      // window without going through this handler's read. Throwing lets the scheduler's own
      // retry/backoff handle it, same as every other handler in this codebase.
      throw new Error(
        `MovementReturnHandler: version conflict crediting settlement ${String(homeDoc._id)}`,
      );
    }

    const updatedMovement = await this.movementModel.findOneAndUpdate(
      { _id: movement._id, version: movement.version },
      { $set: { status: 'done', version: movement.version + 1 } },
      { session },
    );
    if (!updatedMovement) {
      throw new Error(
        `MovementReturnHandler: version conflict applying movement ${String(movement._id)}`,
      );
    }
  }
}
