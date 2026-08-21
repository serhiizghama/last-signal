import type { GameConfig } from '@last-signal/game-core';
import { HOUR_MS, calcNetFoodPerHour, resolveStarvation } from '@last-signal/game-core';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model, Types } from 'mongoose';

import { GAME_CONFIG } from '../../game-config/game-config.tokens';
import { NotificationsService } from '../../notifications/notifications.service';
import { EventSchedulerService } from '../../scheduler/event-scheduler.service';
import type { EventHandler } from '../../scheduler/event-handler.interface';
import type { GameEventDocument } from '../../schemas/event.schema';
import { NOTIFICATION_KIND_TROOPS_STARVING } from '../../schemas/notification.schema';
import type { ReportDocument } from '../../schemas/report.schema';
import { REPORT_TYPE_STARVATION, Report } from '../../schemas/report.schema';
import type { SettlementDocument, StationedContingent } from '../../schemas/settlement.schema';
import { Settlement } from '../../schemas/settlement.schema';
import { SettlementsService } from '../settlements.service';
import {
  STARVATION_FOOD_EMPTY_EPSILON,
  STARVATION_TICK_EVENT_TYPE,
} from '../settlements.constants';
import {
  computeStarvationDeadline,
  stationedContingentKey,
  toBuildingLevels,
  toTroopCounts,
  upkeepTroopsOf,
} from '../settlements.util';

interface StarvationTickPayload {
  settlementId: string;
}

// One stationed contingent, carrying both the opaque `key` `resolveStarvation` addresses it
// by and the real document fields needed to persist/report it back afterwards.
interface KeyedContingent {
  key: string;
  original: StationedContingent;
}

// Applies one hourly starvation tick (M3a.6, `docs/M3_DESIGN_DECISIONS.md` §4): re-settles
// the settlement to `event.dueAt`, re-checks the trigger (net Food < 0 and stored Food ~0),
// and — if it still holds — kills the weakest troops first (`resolveStarvation`, `game-core`)
// until net Food recovers, writes the loss reports, and either reschedules the next hourly
// tick or stops.
//
// Idempotency guard (the hard part — see the class's own extended comment below `handle`):
// `Settlement.lastStarvationTickAt` stamps the `dueAt` of the most recently *applied* tick.
// A replay of the same event (identical `event.dueAt`) finds this already `>= event.dueAt`
// and returns before touching anything — no settle, no kill, no report, no reschedule.
@Injectable()
export class StarvationTickHandler implements EventHandler {
  readonly type = STARVATION_TICK_EVENT_TYPE;
  readonly supportedPayloadVersions = [1];

  private readonly logger = new Logger(StarvationTickHandler.name);

  constructor(
    @InjectModel(Settlement.name) private readonly settlementModel: Model<SettlementDocument>,
    @InjectModel(Report.name) private readonly reportModel: Model<ReportDocument>,
    @Inject(EventSchedulerService) private readonly eventScheduler: EventSchedulerService,
    @Inject(SettlementsService) private readonly settlementsService: SettlementsService,
    @Inject(GAME_CONFIG) private readonly config: GameConfig,
    @Inject(NotificationsService) private readonly notificationsService: NotificationsService,
  ) {}

  async handle(event: GameEventDocument, session: ClientSession): Promise<void> {
    const payload = event.payload as unknown as StarvationTickPayload;

    const doc = await this.settlementModel.findById(payload.settlementId, null, { session });
    // The settlement itself is gone — nothing left to apply this to. Defensive, not expected
    // in practice (settlements are never deleted in v1); mirrors every other handler.
    if (!doc) {
      return;
    }

    // The idempotency guard, checked *before* anything else runs (including the settle
    // step) so a replay is a true no-op — zero writes, not just a logically inert one. See
    // this class's own comment for why comparing against `event.dueAt` is airtight.
    if (doc.lastStarvationTickAt != null && doc.lastStarvationTickAt >= event.dueAt) {
      return;
    }

    // Settle to `event.dueAt`, never `Date.now()` (hard constraint, §12: a downtime replay
    // must resolve in game time). Reuses the existing scheduler-driven, ownership-free settle
    // seam (`settleSettlementDocUnchecked`'s own comment explains why there is no "calling
    // account" for a handler to check ownership against) — deliberately the *resource-only*
    // settle, with none of `SettlementsService.ensureStarvationSchedule`'s lazy-scheduling
    // side effect: this handler is itself the thing that owns rescheduling its own follow-up
    // (see below), and letting the generic lazy-scheduler also touch the event it's
    // currently applying is exactly the self-referential bug that method's own comment
    // documents.
    const settled = await this.settlementsService.settleSettlementDocUnchecked(
      payload.settlementId,
      event.dueAt,
      session,
    );
    if (!settled) {
      return;
    }

    const buildings = toBuildingLevels(settled.buildings);
    const troops = upkeepTroopsOf(settled);
    const netFoodPerHour = calcNetFoodPerHour(this.config, buildings, troops);
    // `<=`, not `< `, and against `STARVATION_FOOD_EMPTY_EPSILON` rather than a bare `0` —
    // see that constant's own comment: `settleResources` already clamps stored Food at
    // `Math.max(0, ...)`, so this is belt-and-suspenders against float representation error,
    // not a real tolerance band.
    const storedFoodEmpty = settled.resources.values.food <= STARVATION_FOOD_EMPTY_EPSILON;

    if (netFoodPerHour >= 0 || !storedFoodEmpty) {
      // The trigger no longer holds — net Food recovered, or stored Food hasn't actually run
      // out yet (a big refund could have landed between scheduling and this tick firing). No
      // kills, no reports — but this handler still owns deciding this settlement's next
      // starvation deadline itself (see `SettlementsService.ensureStarvationSchedule`'s own
      // comment for why the generic lazy-scheduler does NOT run as a side effect of the
      // settle call above): clear the pending fields if truly recovered, or schedule a fresh
      // future tick for whenever Food is now projected to run out, anchored off
      // `event.dueAt` — never `Date.now()`. `computeStarvationDeadline` is the exact same
      // pure formula `ensureStarvationSchedule` uses, so the two can never disagree.
      const target = computeStarvationDeadline(
        this.config,
        buildings,
        { values: settled.resources.values, lastCalcAt: settled.resources.lastCalcAt },
        troops,
        event.dueAt,
      );
      let nextPendingEventId: Types.ObjectId | null = null;
      let nextPendingDueAt: number | null = null;
      if (target !== null) {
        const nextEvent = await this.eventScheduler.scheduleEvent(
          {
            type: STARVATION_TICK_EVENT_TYPE,
            dueAt: target,
            payload: { settlementId: String(settled._id) },
          },
          session,
        );
        nextPendingEventId = nextEvent._id as Types.ObjectId;
        nextPendingDueAt = target;
      }
      // No `cancelEvent` call for the event just processed either way: the scheduler's own
      // `dispatch` loop marks it `done` in the same transaction the instant this method
      // returns (`SchedulerService.dispatch`) — there is nothing left to cancel.

      const updated = await this.settlementModel.findOneAndUpdate(
        { _id: settled._id, version: settled.version },
        {
          $set: {
            lastStarvationTickAt: event.dueAt,
            pendingStarvationEventId: nextPendingEventId,
            pendingStarvationDueAt: nextPendingDueAt,
            version: settled.version + 1,
          },
        },
        { session },
      );
      if (!updated) {
        throw new Error(
          `StarvationTickHandler: version conflict clearing settlement ${String(settled._id)}`,
        );
      }
      return;
    }

    const contingents: KeyedContingent[] = settled.stationedTroops.map((contingent) => ({
      key: stationedContingentKey(contingent.ownerAccountId, contingent.fromSettlementId),
      original: contingent,
    }));
    const byKey = new Map(contingents.map((c) => [c.key, c.original]));

    const result = resolveStarvation(this.config, {
      buildings,
      troops: toTroopCounts(settled.troops),
      // Still fed in for the upkeep union (in-transit troops keep paying Food, M3a.4) — but
      // `resolveStarvation` never kills from it (owner decision 2026-08-17, amending §4: the
      // resurrect-on-return defect this closes, and the accepted trade, are documented on
      // `StarvationInput.awayTroops`'s own doc comment in `game-core`). This settlement's
      // `awayTroops` field is therefore never written below — it is simply left untouched.
      awayTroops: toTroopCounts(settled.awayTroops),
      stationed: contingents.map((c) => ({ key: c.key, troops: toTroopCounts(c.original.troops) })),
    });

    await this.writeReports(settled, result, byKey, event.dueAt, session);

    // A contingent that lost every unit is dropped from the document entirely (the caller's
    // decision, per `resolveStarvation`'s own doc comment) — but only after its report (just
    // above) already captured the loss against its own, still-real `{owner, origin}` pair.
    const remainingStationed = result.remaining.stationed
      .map((s) => {
        const original = byKey.get(s.key);
        if (!original) {
          this.logger.error(
            `StarvationTickHandler: resolveStarvation returned an unknown stationed key ` +
              `"${s.key}" for settlement ${String(settled._id)} — dropping it defensively.`,
          );
          return null;
        }
        return {
          ownerAccountId: original.ownerAccountId,
          fromSettlementId: original.fromSettlementId,
          troops: s.troops,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null && c.troops.length > 0);

    // Reschedule the next hourly tick iff net Food is still negative — whether because
    // everything killable is now gone and building upkeep alone still outruns production
    // (`resolved: false`), or any other reason it's still negative. `event.dueAt + HOUR_MS`,
    // not `Date.now() + HOUR_MS`: chained off game time, same rule as every other scheduled
    // follow-up in this codebase (`TrainingCompleteHandler`, `BuildCompleteHandler`).
    let pendingStarvationEventId: Types.ObjectId | null = null;
    let pendingStarvationDueAt: number | null = null;
    if (result.netFoodPerHourAfter < 0) {
      const nextDueAt = event.dueAt + HOUR_MS;
      const nextEvent = await this.eventScheduler.scheduleEvent(
        {
          type: STARVATION_TICK_EVENT_TYPE,
          dueAt: nextDueAt,
          payload: { settlementId: String(settled._id) },
        },
        session,
      );
      pendingStarvationEventId = nextEvent._id as Types.ObjectId;
      pendingStarvationDueAt = nextDueAt;
    }
    // else: net Food recovered — no follow-up scheduled, `pendingStarvationEventId` stays
    // `null`. No `cancelEvent` call needed for the event just processed either way: the
    // scheduler's own `dispatch` loop marks it `done` in the same transaction the instant
    // this method returns (`SchedulerService.dispatch`), so there is nothing left to cancel.

    const updated = await this.settlementModel.findOneAndUpdate(
      { _id: settled._id, version: settled.version },
      {
        $set: {
          troops: result.remaining.troops,
          stationedTroops: remainingStationed,
          lastStarvationTickAt: event.dueAt,
          pendingStarvationEventId,
          pendingStarvationDueAt,
          version: settled.version + 1,
        },
      },
      { session },
    );
    if (!updated) {
      throw new Error(
        `StarvationTickHandler: version conflict applying settlement ${String(settled._id)}`,
      );
    }
  }

  // Writes the settlement owner's report (everything that died here, including a
  // per-supporter breakdown of any stationed losses) and, separately, one report per
  // affected supporter covering only their own contingent's losses (§15: "their own
  // contingent's losses only"). Writes nothing when nothing died, for either party.
  private async writeReports(
    settled: SettlementDocument,
    result: ReturnType<typeof resolveStarvation>,
    byKey: Map<string, StationedContingent>,
    at: number,
    session: ClientSession,
  ): Promise<void> {
    const killedStationed = result.killed.stationed.filter((s) => s.troops.length > 0);
    const anyKilled = result.killed.troops.length > 0 || killedStationed.length > 0;
    if (!anyKilled) {
      return;
    }

    const settlementId = String(settled._id);
    const stationedForOwner = killedStationed.map((s) => {
      const original = byKey.get(s.key);
      return {
        ownerAccountId: original ? String(original.ownerAccountId) : null,
        fromSettlementId: original ? String(original.fromSettlementId) : null,
        troops: s.troops,
      };
    });

    const reports: Array<{
      accountId: Types.ObjectId;
      type: typeof REPORT_TYPE_STARVATION;
      read: boolean;
      payload: Record<string, unknown>;
    }> = [
      {
        accountId: settled.accountId,
        type: REPORT_TYPE_STARVATION,
        read: false,
        payload: {
          settlementId,
          at,
          killedTroops: result.killed.troops,
          killedStationed: stationedForOwner,
        },
      },
    ];

    for (const contingent of killedStationed) {
      const original = byKey.get(contingent.key);
      if (!original) {
        // Structurally shouldn't happen — `byKey` is built from the exact same
        // `settled.stationedTroops` that produced every key `resolveStarvation` can return.
        // `handle`'s own `remainingStationed` step logs this same defensive case again for
        // its own array — deliberately not deduplicated across the two call sites, since
        // each is independently responsible for not silently dropping data it can't place.
        this.logger.error(
          `StarvationTickHandler: no stationed contingent found for key "${contingent.key}" ` +
            `while writing the supporter report for settlement ${String(settled._id)}.`,
        );
        continue;
      }
      reports.push({
        accountId: original.ownerAccountId,
        type: REPORT_TYPE_STARVATION,
        read: false,
        payload: {
          settlementId,
          fromSettlementId: String(original.fromSettlementId),
          at,
          killedTroops: contingent.troops,
        },
      });
    }

    // `ordered: true` is required by this Mongoose version whenever `create()` is called
    // with both a session and more than one document (the owner report plus one per
    // affected supporter) — every other handler in this codebase only ever creates one
    // report at a time, so this requirement never came up before.
    const created = await this.reportModel.create(reports, { session, ordered: true });

    // §16's `troopsStarving` trigger — one per recipient, mirroring the report list above
    // exactly (the settlement owner, plus each affected supporter): the same 1:1 shape
    // `BattleArrivalResolver`/`OasisBattleArrivalResolver` use for `battleReportArrived` via
    // `NotificationsService.enqueueForReports`, but a distinct kind — a starving supporter's
    // troops dying is not a "battle report" (§15/§16 name it separately).
    for (const report of created) {
      await this.notificationsService.enqueue(
        report.accountId,
        NOTIFICATION_KIND_TROOPS_STARVING,
        { reportId: String(report._id) },
        session,
      );
    }
  }
}
