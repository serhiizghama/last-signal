import { randomUUID } from 'node:crypto';

import type { GameConfig } from '@last-signal/game-core';
import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { EventSchedulerService } from '../../scheduler/event-scheduler.service';
import type { EventHandler } from '../../scheduler/event-handler.interface';
import type { GameEventDocument } from '../../schemas/event.schema';
import type { SettlementDocument } from '../../schemas/settlement.schema';
import { Settlement } from '../../schemas/settlement.schema';
import { promoteWaitingItems, toPlainQueueItem } from '../build-queue.util';
import { GAME_CONFIG } from '../../game-config/game-config.tokens';
import { ACTIVE_BUILD_SLOTS, BUILD_COMPLETE_EVENT_TYPE } from '../settlements.constants';
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
    const existingIndex = buildings.findIndex((b) => b.type === item.type);
    if (existingIndex === -1) {
      buildings.push({
        id: randomUUID(),
        type: item.type,
        level: item.targetLevel,
        slot: nextFreeSlot(buildings),
      });
    } else {
      const existing = buildings[existingIndex];
      if (existing) {
        existing.level = item.targetLevel;
      }
    }

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

    const updated = await this.settlementModel.findOneAndUpdate(
      { _id: doc._id, version: doc.version },
      { $set: { buildings, buildQueue: remainingQueue, version: doc.version + 1 } },
      { session },
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
  }
}
