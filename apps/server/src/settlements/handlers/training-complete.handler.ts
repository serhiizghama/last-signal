import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model, Types } from 'mongoose';

import { EventSchedulerService } from '../../scheduler/event-scheduler.service';
import type { EventHandler } from '../../scheduler/event-handler.interface';
import type { GameEventDocument } from '../../schemas/event.schema';
import type { SettlementDocument } from '../../schemas/settlement.schema';
import { Settlement } from '../../schemas/settlement.schema';
import { toPlainTrainingQueueItem } from '../training-queue.util';
import { TRAINING_COMPLETE_EVENT_TYPE } from '../settlements.constants';

interface TrainingCompletePayload {
  settlementId: string;
  orderId: string;
  // The order's `remainingCount` at the moment this specific event was scheduled — the
  // idempotency guard (see this class's own comment).
  remainingCountAtSchedule: number;
}

// Applies one unit of a finished training order (M2b.2, §7): credits one unit into
// `Settlement.troops` (creating the entry if this is the settlement's first unit of that
// type), decrements the order's `remainingCount`, and either schedules the next
// `trainingComplete` event (order still has units left) or drops the finished order
// entirely (this was the last one) — Travian-accurate one-at-a-time arrival, chained rather
// than computed lazily.
//
// Idempotency guard: unlike `BuildCompleteHandler`, "the queue item is gone" alone isn't a
// sufficient replay check here, because the *same* order id stays present across multiple
// chained events (only the final unit's completion removes it) — a naive "item still
// exists → apply" would double-credit a replay of any non-final unit. Instead the event
// payload carries the exact `remainingCount` the order had when *this* event was scheduled;
// `handle` only applies its effect when the persisted order's `remainingCount` still equals
// that number. A replay after this event already committed once finds `remainingCount`
// already decremented (the first, successful run advanced it) and no-ops — the same
// principle as `BuildCompleteHandler`'s "item already gone" check, just keyed on a field
// instead of the item's existence, because this handler's queue item outlives more than one
// event.
@Injectable()
export class TrainingCompleteHandler implements EventHandler {
  readonly type = TRAINING_COMPLETE_EVENT_TYPE;
  readonly supportedPayloadVersions = [1];

  constructor(
    @InjectModel(Settlement.name) private readonly settlementModel: Model<SettlementDocument>,
    @Inject(EventSchedulerService) private readonly eventScheduler: EventSchedulerService,
  ) {}

  async handle(event: GameEventDocument, session: ClientSession): Promise<void> {
    const payload = event.payload as unknown as TrainingCompletePayload;

    const doc = await this.settlementModel.findById(payload.settlementId, null, { session });
    // The settlement itself is gone — nothing left to apply this to. Defensive, not expected
    // in practice (settlements are never deleted in v1); mirrors `BuildCompleteHandler`.
    if (!doc) {
      return;
    }

    const itemIndex = doc.trainingQueue.findIndex((i) => i.id === payload.orderId);
    if (itemIndex === -1) {
      // The order was already fully delivered (its last unit's completion removed it) —
      // replay of that final event, or a stale duplicate. There is no cancel path for
      // training (orchestrator decision) that could otherwise explain a missing order.
      return;
    }
    const item = doc.trainingQueue[itemIndex];
    if (!item || item.remainingCount !== payload.remainingCountAtSchedule) {
      // Already advanced past what this event expects — a replay of a non-final unit's
      // completion after the first, successful run already decremented `remainingCount`.
      // See this class's own comment for why this check exists on top of "item missing".
      return;
    }

    // Explicit fields, not `{ ...t }` — see `toPlainTrainingQueueItem`'s comment for why a
    // Mongoose subdocument must never be spread into a plain array headed for a `$set`.
    const troops = doc.troops.map((t) => ({ unitType: t.unitType, count: t.count }));
    const troopIndex = troops.findIndex((t) => t.unitType === item.unitType);
    if (troopIndex === -1) {
      troops.push({ unitType: item.unitType, count: 1 });
    } else {
      const existing = troops[troopIndex];
      if (existing) {
        existing.count += 1;
      }
    }

    const remainingCount = item.remainingCount - 1;
    // Drop the finished item first — if this was the last unit, it stays dropped; if not,
    // the block below pushes back a fresh plain item with the advanced state.
    let trainingQueue = doc.trainingQueue
      .filter((i) => i.id !== payload.orderId)
      .map(toPlainTrainingQueueItem);

    if (remainingCount > 0) {
      // `event.dueAt`, not `Date.now()` — same reasoning as `BuildCompleteHandler`'s
      // identical comment: replay after downtime must resolve in game time (§12), so the
      // next unit's completion is anchored to when *this* one was due, not to whenever the
      // scheduler actually got around to processing it.
      const nextCompletesAt = event.dueAt + item.unitTrainTimeMs;
      const nextEvent = await this.eventScheduler.scheduleEvent(
        {
          type: TRAINING_COMPLETE_EVENT_TYPE,
          dueAt: nextCompletesAt,
          payload: {
            settlementId: String(doc._id),
            orderId: item.id,
            remainingCountAtSchedule: remainingCount,
          },
        },
        session,
      );
      trainingQueue = [
        ...trainingQueue,
        toPlainTrainingQueueItem({
          id: item.id,
          unitType: item.unitType,
          totalCount: item.totalCount,
          remainingCount,
          unitTrainTimeMs: item.unitTrainTimeMs,
          startedAt: item.startedAt,
          nextCompletesAt,
          cost: item.cost,
          eventId: nextEvent._id as Types.ObjectId,
        }),
      ];
    }
    // else: order fully delivered — stays removed above. No cancel path exists to
    // resurrect a finished order (orchestrator decision 2, `settlements.constants.ts`).

    const updated = await this.settlementModel.findOneAndUpdate(
      { _id: doc._id, version: doc.version },
      { $set: { troops, trainingQueue, version: doc.version + 1 } },
      { session },
    );
    if (!updated) {
      // A genuine version conflict — something else wrote to this settlement inside the
      // same window without going through this handler's read. Throwing lets the
      // scheduler's own retry/backoff handle it, same as `BuildCompleteHandler`.
      throw new Error(
        `TrainingCompleteHandler: version conflict applying settlement ${String(doc._id)}`,
      );
    }
  }
}
