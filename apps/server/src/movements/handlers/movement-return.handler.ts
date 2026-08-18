import type { GameConfig, Resources } from '@last-signal/game-core';
import {
  RESOURCE_KINDS,
  addResources,
  calcStorageCaps,
  emptyResources,
} from '@last-signal/game-core';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { GAME_CONFIG } from '../../game-config/game-config.tokens';
import type { EventHandler } from '../../scheduler/event-handler.interface';
import type { GameEventDocument } from '../../schemas/event.schema';
import type { MovementDocument } from '../../schemas/movement.schema';
import { Movement } from '../../schemas/movement.schema';
import type { ReportDocument } from '../../schemas/report.schema';
import { REPORT_TYPE_ASSAULT, REPORT_TYPE_RAID, Report } from '../../schemas/report.schema';
import type { SettlementDocument } from '../../schemas/settlement.schema';
import { Settlement } from '../../schemas/settlement.schema';
import { SettlementsService } from '../../settlements/settlements.service';
import { toBuildingLevels } from '../../settlements/settlements.util';
import { MOVEMENT_RETURN_EVENT_TYPE } from '../movements.constants';
import { subtractUnitCounts } from '../movements.util';

interface MovementReturnPayload {
  movementId: string;
}

// Credits a movement's survivors back into its home settlement's `troops` (M2b.3,
// `docs/M2_DESIGN_DECISIONS.md` §6) and marks the movement `done`. The counterpart to
// `MovementArriveHandler` — this is the only handler that ever writes home `troops` back up;
// everything else in this module only ever deducts (`MovementsService.sendMovement`). M3c.5a
// adds the other half of a raid/assault's round trip: crediting `movement.loot` (set by
// `BattleArrivalResolver` at arrival), clamped to this settlement's own storage caps —
// whatever overflows the cap is lost, not banked (§6/M1 §5) — with the loss reported back on
// the same `raid`/`assault` report the arrival already wrote.
//
// Idempotency guard: re-checks `movement.status` — only `returning` means "this credit
// hasn't been applied yet". A replay finds `status` already `done` (this handler's own
// earlier, successful run advanced it) and no-ops, so a crash between commit and the event's
// `done` mark can never double-credit survivors (or loot). Same principle as
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
    @InjectModel(Report.name) private readonly reportModel: Model<ReportDocument>,
    @Inject(SettlementsService) private readonly settlementsService: SettlementsService,
    @Inject(GAME_CONFIG) private readonly config: GameConfig,
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

    // The settle seam (M2b.3), same one `MovementArriveHandler` uses for the defender —
    // settled to `event.dueAt`, never `Date.now()` (§18). This matters more here than it did
    // before M3c.5a: loot is about to be credited onto `resources.values` and clamped against
    // `resources.storageCaps`-derived caps, and comparing either against a stale,
    // not-yet-settled figure would be wrong. A plain `findById` (what this handler used
    // before this step) would have done exactly that.
    const homeDoc = await this.settlementsService.settleSettlementDocUnchecked(
      String(movement.fromSettlementId),
      event.dueAt,
      session,
    );
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

    // §6/M1 §5: credit `movement.loot` (set only by `BattleArrivalResolver` when a raid/
    // assault actually took something — every scout/support return has no `loot` at all and
    // this whole block is skipped for them, unchanged from before this step), clamped per
    // resource to this settlement's own storage caps. `delivered` is what actually lands in
    // `resources.values`; `lost` is whatever overflowed the cap — not banked, not retroactively
    // wasted elsewhere, just gone (same "production halts at cap" rule M1 §5 already applies).
    // `delivered[kind] + lost[kind] === movement.loot[kind]` by construction below.
    let newResourceValues = homeDoc.resources.values;
    let lootDelivered: Resources | null = null;
    let lootLost: Resources | null = null;
    if (movement.loot) {
      const loot: Resources = {
        scrap: movement.loot.scrap,
        fuel: movement.loot.fuel,
        electronics: movement.loot.electronics,
        food: movement.loot.food,
      };
      const caps = calcStorageCaps(this.config, toBuildingLevels(homeDoc.buildings));
      const grown = addResources(homeDoc.resources.values, loot);
      const credited = emptyResources();
      const delivered = emptyResources();
      const lost = emptyResources();
      for (const kind of RESOURCE_KINDS) {
        credited[kind] = Math.min(caps[kind], grown[kind]);
        delivered[kind] = credited[kind] - homeDoc.resources.values[kind];
        lost[kind] = grown[kind] - credited[kind];
      }
      newResourceValues = credited;
      lootDelivered = delivered;
      lootLost = lost;
    }

    const updatedSettlement = await this.settlementModel.findOneAndUpdate(
      { _id: homeDoc._id, version: homeDoc.version },
      {
        $set: {
          troops,
          awayTroops,
          // Not touching `resources.lastCalcAt` — `settleSettlementDocUnchecked` above already
          // settled it to `event.dueAt`; re-stamping it here would double-count production.
          ...(movement.loot ? { 'resources.values': newResourceValues } : {}),
          version: homeDoc.version + 1,
        },
      },
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

    // §15 gives one `raid`/`assault` report per raid and does not allocate a second report
    // type for the loot's eventual fate — the overflow loss is part of the story of that one
    // raid, not a new event, and a second report here would double every raid in the player's
    // inbox. So the overflow is recorded by updating the report `BattleArrivalResolver` already
    // wrote at arrival (found by its own `payload.movementId` + `accountId`) rather than
    // minting a new one. Reports have no `version` field (unlike Settlement/Movement) — this
    // report is only ever written once, at arrival, and only ever updated once, here, so there
    // is nothing else that could race this write.
    if (movement.loot && lootDelivered && lootLost) {
      const updatedReport = await this.reportModel.findOneAndUpdate(
        {
          accountId: movement.ownerAccountId,
          type: { $in: [REPORT_TYPE_RAID, REPORT_TYPE_ASSAULT] },
          'payload.movementId': String(movement._id),
        },
        { $set: { 'payload.lootDelivered': lootDelivered, 'payload.lootLost': lootLost } },
        { session },
      );
      if (!updatedReport) {
        // Structurally shouldn't happen: `movement.loot` is only ever set by
        // `BattleArrivalResolver`, which always writes exactly one `raid`/`assault` report for
        // the attacker in the same transaction, before the movement ever reaches `returning`.
        throw new Error(
          `MovementReturnHandler: no raid/assault report found for movement ` +
            `${String(movement._id)} (account ${String(movement.ownerAccountId)}) while crediting loot`,
        );
      }
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
