import type { GameConfig, Resources } from '@last-signal/game-core';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { GAME_CONFIG } from '../../game-config/game-config.tokens';
import type { EventHandler } from '../../scheduler/event-handler.interface';
import type { GameEventDocument } from '../../schemas/event.schema';
import type { MovementDocument } from '../../schemas/movement.schema';
import { Movement } from '../../schemas/movement.schema';
import type { ReportDocument } from '../../schemas/report.schema';
import {
  REPORT_TYPE_ASSAULT,
  REPORT_TYPE_OASIS_RAID,
  REPORT_TYPE_RAID,
  REPORT_TYPE_TRADE,
  Report,
} from '../../schemas/report.schema';
import type { SettlementDocument } from '../../schemas/settlement.schema';
import { Settlement } from '../../schemas/settlement.schema';
import { SettlementsService } from '../../settlements/settlements.service';
import { toBuildingLevels } from '../../settlements/settlements.util';
import { MOVEMENT_RETURN_EVENT_TYPE } from '../movements.constants';
import { creditResourcesClamped, subtractUnitCounts } from '../movements.util';

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
// the same `raid`/`assault` report the arrival already wrote. M3c.7b widens this to a second
// source of `movement.loot`: `OasisBattleArrivalResolver` sets it too (Food only, §10), on an
// `oasisRaid` report instead of a `raid`/`assault` one — see the report lookup below, which
// now has to know about both shapes.
//
// M3d.3 (§14) widens this a second time for `trade`'s round trip — a fundamentally different
// shape from a raid's, which is why it gets its own paragraph rather than folding into the
// one above: a trade movement never fights, so `movement.survivors`/`movement.units` are
// always `[]` (the loop crediting `troops` and the `subtractUnitCounts` call against
// `awayTroops` below are already correct no-ops for it, by construction — nothing to special-
// case) and it never carries `loot` (`if (movement.loot)` below is already `false` for it).
// What a trade return actually does: (1) if `movement.cargo` is STILL set — meaning this leg
// never delivered (cancelled before arrival, or `TradeArrivalResolver.resolveMissingTarget`'s
// "destination gone" edge case) — credit it home, clamped, via the SAME
// `creditResourcesClamped` helper the (now-refactored) loot block below uses, rather than a
// third copy of that arithmetic; a NORMALLY delivered trade's `cargo` was already credited to
// the destination and cleared by `TradeArrivalResolver.resolveArrival`, so this block is a
// no-op for the common case. (2) free `movement.merchants` back into the home settlement's
// `busyMerchants`, floored at 0 (§14: "occupied for the whole round trip and freed on
// return"). (3) upsert the trade's own report — see the dedicated comment at that call site
// for why an upsert, not this file's usual `.create()`/single-`findOneAndUpdate`, is needed
// here specifically.
//
// Idempotency guard: re-checks `movement.status` — only `returning` means "this credit
// hasn't been applied yet". A replay finds `status` already `done` (this handler's own
// earlier, successful run advanced it) and no-ops, so a crash between commit and the event's
// `done` mark can never double-credit survivors (or loot/cargo/merchants). Same principle as
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

    const buildings = toBuildingLevels(homeDoc.buildings);

    // §6/M1 §5: credit `movement.loot` (set only by `BattleArrivalResolver`/
    // `OasisBattleArrivalResolver` when a raid/assault actually took something), clamped per
    // resource to this settlement's own storage caps via the shared `creditResourcesClamped`
    // helper (`movements.util.ts` — extracted in M3d.3 from what used to be this block's own
    // inline arithmetic, behaviour unchanged, now also reused below for a trade's `cargo`).
    // `delivered` is what actually lands in `resources.values`; `lost` is whatever overflowed
    // the cap — not banked, not retroactively wasted elsewhere, just gone (same "production
    // halts at cap" rule M1 §5 already applies). `delivered[kind] + lost[kind] ===
    // movement.loot[kind]` by construction.
    //
    // §14 (M3d.3): a trade movement's `cargo` follows the identical rule, but only when it is
    // STILL SET at return — see this class's own header comment for why that only happens on
    // an undelivered leg (cancelled, or a missing destination). A normally-delivered trade's
    // `cargo` was already cleared by `TradeArrivalResolver.resolveArrival`, so this `else if`
    // is a no-op for the common case, exactly as it must be. `loot` and `cargo` can never both
    // be set on the same movement (raid/assault vs. trade are disjoint movement types), so an
    // `if`/`else if` — not two independent `if`s — is the correct shape, and it also keeps
    // `newResourceValues` unambiguous.
    let newResourceValues = homeDoc.resources.values;
    let lootDelivered: Resources | null = null;
    let lootLost: Resources | null = null;
    let creditedResources = false;
    if (movement.loot) {
      const loot: Resources = {
        scrap: movement.loot.scrap,
        fuel: movement.loot.fuel,
        electronics: movement.loot.electronics,
        food: movement.loot.food,
      };
      const { values, delivered, lost } = creditResourcesClamped(
        this.config,
        buildings,
        homeDoc.resources.values,
        loot,
      );
      newResourceValues = values;
      lootDelivered = delivered;
      lootLost = lost;
      creditedResources = true;
    } else if (movement.cargo) {
      const cargo: Resources = {
        scrap: movement.cargo.scrap,
        fuel: movement.cargo.fuel,
        electronics: movement.cargo.electronics,
        food: movement.cargo.food,
      };
      const { values } = creditResourcesClamped(
        this.config,
        buildings,
        homeDoc.resources.values,
        cargo,
      );
      newResourceValues = values;
      creditedResources = true;
    }

    // §14 (M3d.3): free `movement.merchants` back into `busyMerchants`, floored at 0 — mirrors
    // `subtractUnitCounts`'s own "clamp and log, never throw" reasoning (`movements.util.ts`):
    // an army/merchant count that drifted must not strand the return. Absent for every
    // non-`trade` movement (`movement.merchants` is `undefined`), so `newBusyMerchants` is
    // simply `homeDoc.busyMerchants` unchanged for them.
    let newBusyMerchants = homeDoc.busyMerchants;
    if (movement.merchants) {
      const freed = Math.min(homeDoc.busyMerchants, movement.merchants);
      if (freed < movement.merchants) {
        this.logger.error(
          `MovementReturnHandler: busyMerchants drifted below zero freeing movement ` +
            `${String(movement._id)} at settlement ${String(homeDoc._id)} — clamped at zero, ` +
            `short by ${movement.merchants - freed}`,
        );
      }
      newBusyMerchants = homeDoc.busyMerchants - freed;
    }

    const updatedSettlement = await this.settlementModel.findOneAndUpdate(
      { _id: homeDoc._id, version: homeDoc.version },
      {
        $set: {
          troops,
          awayTroops,
          // Not touching `resources.lastCalcAt` — `settleSettlementDocUnchecked` above already
          // settled it to `event.dueAt`; re-stamping it here would double-count production.
          ...(creditedResources ? { 'resources.values': newResourceValues } : {}),
          busyMerchants: newBusyMerchants,
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

    // §15 gives one report per raid — `raid`/`assault` for a settlement target,
    // `oasisRaid` for an oasis one (M3c.7b) — and does not allocate a second report type for
    // the loot's eventual fate either way: the overflow loss is part of the story of that one
    // raid, not a new event, and a second report here would double every raid in the player's
    // inbox. So the overflow is recorded by updating the report the arrival resolver already
    // wrote (found by its own `payload.movementId` + `accountId`) rather than minting a new
    // one. Reports have no `version` field (unlike Settlement/Movement) — this report is only
    // ever written once, at arrival, and only ever updated once, here, so there is nothing else
    // that could race this write.
    if (movement.loot && lootDelivered && lootLost) {
      const updatedReport = await this.reportModel.findOneAndUpdate(
        {
          accountId: movement.ownerAccountId,
          type: { $in: [REPORT_TYPE_RAID, REPORT_TYPE_ASSAULT, REPORT_TYPE_OASIS_RAID] },
          'payload.movementId': String(movement._id),
        },
        { $set: { 'payload.lootDelivered': lootDelivered, 'payload.lootLost': lootLost } },
        { session },
      );
      if (!updatedReport) {
        // Structurally shouldn't happen: `movement.loot` is only ever set by
        // `BattleArrivalResolver` (which always writes exactly one `raid`/`assault` report for
        // the attacker) or `OasisBattleArrivalResolver` (which always writes exactly one
        // `oasisRaid` report for the attacker, M3c.7b) — one of these three report types always
        // accompanies loot, written in the same transaction, before the movement ever reaches
        // `returning`.
        throw new Error(
          `MovementReturnHandler: no raid/assault/oasisRaid report found for movement ` +
            `${String(movement._id)} (account ${String(movement.ownerAccountId)}) while crediting loot`,
        );
      }
    }

    // §14/§15 (M3d.3): this leg's own merchants are home — one half of the trade's single
    // report per party (§15: "trade — both parties — resources delivered, merchants freed").
    // `movement.tradeOfferId` is absent for every non-`trade` movement, so this block is
    // skipped for all of them.
    //
    // **Why `upsert: true` here, uniquely in this codebase.** Every other report write in
    // this module is a plain `.create()` (a fresh event, one writer) or a `findOneAndUpdate`
    // with NO `upsert` (the loot block above: the report it updates is GUARANTEED to already
    // exist, because the same resolver that set `movement.loot` always also wrote that report,
    // in the same earlier transaction — see the loot-update comment above). A trade's report
    // has no such guarantee of write order: it is jointly produced by TWO independent
    // `Movement` documents — `TradeArrivalResolver.resolveArrival` (on the OTHER leg, writing
    // "resources delivered" the moment cargo lands) and this handler (on THIS leg, writing
    // "merchants freed" the moment its own merchants come home) — and §14's faction-flavoured
    // merchant speeds (`merchant.speedByFaction`) mean neither is guaranteed to happen before
    // the other: a Nomad accepter's fast return leg can beat a Raider offerer's slow delivery
    // leg home, or vice versa. Whichever of the two writers reaches `payload.tradeOfferId`
    // first must CREATE the report; whichever reaches it second must UPDATE the same one.
    // `findOneAndUpdate(..., { upsert: true })` is exactly "create if absent, update if
    // present" in one atomic operation, which is what makes this race-order-independent
    // without either side needing to know which one runs first. `$setOnInsert` only ever
    // supplies the fields the OTHER write path is responsible for (so a first-write-wins
    // arrival never clobbers a first-write-wins return, and vice versa) — see
    // `TradeArrivalResolver.resolveArrival`'s matching comment for its own half of this pair.
    //
    // **This is safe only because the two writers can never be SIMULTANEOUS, not merely
    // unordered.** There is no unique index on `(accountId, type, payload.tradeOfferId)` — two
    // genuinely concurrent upserts on that key would each see "absent" and each insert, leaving
    // TWO report documents instead of one. What rules that out is §18's single-process
    // scheduler claiming and dispatching events strictly one at a time (§18: "recorded here so
    // nobody 'optimizes' the scheduler into parallel workers without first designing per-
    // settlement ordering") — this arrival and this return can never be mid-flight together, so
    // "unordered" here only ever means "either could be first," never "both at once." This
    // upsert is therefore another load-bearing dependent of that same scheduler property,
    // alongside the ones §18 already names.
    if (movement.tradeOfferId) {
      await this.reportModel.findOneAndUpdate(
        {
          accountId: movement.ownerAccountId,
          type: REPORT_TYPE_TRADE,
          'payload.tradeOfferId': String(movement.tradeOfferId),
        },
        {
          // `read: false` here too, not only in `$setOnInsert`: if the arrival side already
          // created this report and the player already read it, THIS write adds genuinely new
          // information ("your merchants are home") and should re-surface it as unread —
          // the same "an update is itself notification-worthy" reasoning M2b.4's read-on-open
          // model already assumes for a freshly-created report.
          $set: { read: false, 'payload.merchantsFreed': true },
          $setOnInsert: {
            accountId: movement.ownerAccountId,
            type: REPORT_TYPE_TRADE,
            'payload.tradeOfferId': String(movement.tradeOfferId),
          },
        },
        { session, upsert: true },
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
