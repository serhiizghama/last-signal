import { randomUUID } from 'node:crypto';

import type { GameConfig } from '@last-signal/game-core';
import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { NotificationsService } from '../../notifications/notifications.service';
import { EventSchedulerService } from '../../scheduler/event-scheduler.service';
import type { EventHandler } from '../../scheduler/event-handler.interface';
import type { GameEventDocument } from '../../schemas/event.schema';
import { NOTIFICATION_KIND_BUILD_COMPLETE } from '../../schemas/notification.schema';
import type { SettlementDocument } from '../../schemas/settlement.schema';
import { Settlement } from '../../schemas/settlement.schema';
import { promoteWaitingItems, toPlainQueueItem } from '../build-queue.util';
import { GAME_CONFIG } from '../../game-config/game-config.tokens';
import { ACTIVE_BUILD_SLOTS, BUILD_COMPLETE_EVENT_TYPE } from '../settlements.constants';
import { SettlementsService } from '../settlements.service';
import { currentLevelOf, nextFreeSlot, toBuildingLevels } from '../settlements.util';

interface BuildCompletePayload {
  settlementId: string;
  queueItemId: string;
}

// Applies a finished build: bumps the building to its queued target level (creating it at
// that level if this was its first level), drops the finished queue item, and promotes +
// schedules the next waiting item if a slot is now free.
//
// Idempotent per the `EventHandler` contract: if the queue item is already gone — the
// normal case on replay after a crash between this transaction committing and the event's
// `done` mark being read back, since both happen in the caller's transaction (see
// `SchedulerService.dispatch`) this can also just mean the item was cancelled in the
// meantime — `handle` is a no-op. It never re-applies a level bump for a missing item.
@Injectable()
export class BuildCompleteHandler implements EventHandler {
  readonly type = BUILD_COMPLETE_EVENT_TYPE;
  readonly supportedPayloadVersions = [1];

  constructor(
    @InjectModel(Settlement.name) private readonly settlementModel: Model<SettlementDocument>,
    @Inject(EventSchedulerService) private readonly eventScheduler: EventSchedulerService,
    @Inject(GAME_CONFIG) private readonly config: GameConfig,
    @Inject(ACTIVE_BUILD_SLOTS) private readonly activeBuildSlots: number,
    @Inject(SettlementsService) private readonly settlementsService: SettlementsService,
    @Inject(NotificationsService) private readonly notificationsService: NotificationsService,
  ) {}

  async handle(event: GameEventDocument, session: ClientSession): Promise<void> {
    const payload = event.payload as unknown as BuildCompletePayload;

    const doc = await this.settlementModel.findById(payload.settlementId, null, { session });
    // The settlement itself is gone — nothing left to apply this to. Not expected in
    // practice (settlements are never deleted in v1) but defensive rather than throwing,
    // since throwing here would just dead-letter after 3 pointless retries.
    if (!doc) {
      return;
    }

    const itemIndex = doc.buildQueue.findIndex((i) => i.id === payload.queueItemId);
    if (itemIndex === -1) {
      // Already applied (replay) or the build was cancelled in the meantime — no-op.
      return;
    }
    const item = doc.buildQueue[itemIndex];
    if (!item) {
      return;
    }

    // Explicit fields, not `{ ...b }`: `b` is a Mongoose subdocument, and spreading one
    // drags its internal bookkeeping (which circularly references the connection) along
    // with the schema fields — see `toPlainQueueItem`'s comment in `build-queue.util.ts`
    // for the same issue on queue items.
    const buildings = doc.buildings.map((b) => ({
      id: b.id,
      type: b.type,
      level: b.level,
      slot: b.slot,
    }));
    // §7 (M3c.5b, `docs/M3_DESIGN_DECISIONS.md`): "on completion the handler sets `level =
    // min(item.targetLevel, currentLevel + 1)`, so a queued '→ L8' that finds the building at
    // L5 [knocked down by a siege pass mid-build] delivers L6, not a free three-level jump."
    // `completesAt` is unaffected (fixed at enqueue, M1) — only the level landed is capped.
    // `currentLevel` is the building's level *right now* (0 when this is its first-ever
    // build, including a first build queued before the building existed at all) — the exact
    // same "0 when absent" `currentLevelOf` already uses elsewhere, so the two conventions
    // can't drift.
    const existingIndex = buildings.findIndex((b) => b.type === item.type);
    if (existingIndex === -1) {
      buildings.push({
        id: randomUUID(),
        type: item.type,
        level: Math.min(item.targetLevel, 1),
        slot: nextFreeSlot(buildings),
      });
    } else {
      const existing = buildings[existingIndex];
      if (existing) {
        existing.level = Math.min(item.targetLevel, existing.level + 1);
      }
    }
    // Read back rather than re-derived by hand — correct regardless of which branch above
    // ran, and reused below for the `buildComplete` notification payload (§16).
    const newLevel = buildings.find((b) => b.type === item.type)?.level ?? item.targetLevel;

    let remainingQueue = doc.buildQueue
      .filter((i) => i.id !== payload.queueItemId)
      .map(toPlainQueueItem);
    const commandCenterLevel = currentLevelOf(toBuildingLevels(buildings), 'commandCenter');
    const activeCount = remainingQueue.filter((i) => i.startedAt !== null).length;
    const slotsToFill = this.activeBuildSlots - activeCount;

    if (slotsToFill > 0) {
      // `event.dueAt`, not `Date.now()`: the promoted build's start time is the instant
      // this one finished in game time, not whenever the scheduler happened to process it
      // (§12 — replay resolves strictly in `dueAt` order, no fast-forward).
      remainingQueue = await promoteWaitingItems(
        remainingQueue,
        slotsToFill,
        commandCenterLevel,
        this.config,
        this.eventScheduler,
        String(doc._id),
        event.dueAt,
        session,
      );
    }

    // `returnDocument: 'after'` — unlike before M3a.6, the updated doc is now needed for the
    // `ensureStarvationSchedule` call below, not just for the null-check.
    const updated = await this.settlementModel.findOneAndUpdate(
      { _id: doc._id, version: doc.version },
      { $set: { buildings, buildQueue: remainingQueue, version: doc.version + 1 } },
      { session, returnDocument: 'after' },
    );
    if (!updated) {
      // A genuine version conflict here means something else wrote to this settlement
      // inside the same window without going through this handler's read — throwing lets
      // the scheduler's own retry/backoff (§12: 3 attempts, then dead-letter) handle it,
      // rather than this handler inventing a second retry mechanism.
      throw new Error(
        `BuildCompleteHandler: version conflict applying settlement ${String(doc._id)}`,
      );
    }

    // M3a.6, `docs/M3_DESIGN_DECISIONS.md` §4: a finished build can change Food upkeep (a
    // Greenhouse Farm landing recovers it, any other building landing adds to it) exactly
    // like a command would, and this handler doesn't otherwise funnel through
    // `SettlementsService.settleSettlementDoc` — so it must arm/reschedule/clear the
    // settlement's starvation tick itself. `event.dueAt`, not `Date.now()`, anchors the
    // check to when the build actually completed in game time. See
    // `ensureStarvationSchedule`'s own comment for why calling it here (unlike from
    // `StarvationTickHandler`) carries no self-cancellation risk.
    await this.settlementsService.ensureStarvationSchedule(updated, event.dueAt, session);

    // §16's `buildComplete` trigger — one per finished queue item (never per level, since a
    // queue item and a level-up are the same thing on this side of the M1 §6 build-queue
    // rule: one active build at a time targets exactly one level).
    await this.notificationsService.enqueue(
      updated.accountId,
      NOTIFICATION_KIND_BUILD_COMPLETE,
      { settlementId: String(updated._id), buildingType: item.type, level: newLevel },
      session,
    );
  }
}
