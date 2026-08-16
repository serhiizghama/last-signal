import type { BuildingType, GameConfig, Resources } from '@last-signal/game-core';
import { calcBuildTimeMs } from '@last-signal/game-core';
import type { ClientSession, Types } from 'mongoose';

import type { EventSchedulerService } from '../scheduler/event-scheduler.service';
import { BUILD_COMPLETE_EVENT_TYPE } from './settlements.constants';

// The subset of `BuildQueueItem` this module reads/writes — a genuine plain object, never a
// Mongoose (sub)document. `startBuild` builds these fresh already; `cancelBuild` and the
// `buildComplete` handler must run every item they read off a loaded settlement through
// `toPlainQueueItem` first (see its own comment for why that matters).
export interface BuildQueueItemData {
  id: string;
  type: string;
  targetLevel: number;
  cost: Resources;
  enqueuedAt: number;
  startedAt: number | null;
  completesAt: number | null;
  eventId?: Types.ObjectId;
}

// Mongoose (sub)documents are not plain objects — spreading one (`{ ...item }`) or writing
// it back wholesale pulls in Mongoose's own internal bookkeeping properties (which
// circularly reference the connection) alongside the schema fields, and both `res.json()`
// and the MongoDB driver's BSON encoder throw trying to serialize the result. Reading each
// named field individually (a getter access, which Mongoose documents support fine) and
// building a genuine object literal avoids that entirely — call this on every `BuildQueueItem`
// subdocument before putting it back into a plain array headed for a `$set`/`$push`.
export function toPlainQueueItem(item: {
  id: string;
  type: string;
  targetLevel: number;
  cost: Resources;
  enqueuedAt: number;
  startedAt: number | null;
  completesAt: number | null;
  eventId?: Types.ObjectId;
}): BuildQueueItemData {
  return {
    id: item.id,
    type: item.type,
    targetLevel: item.targetLevel,
    cost: {
      scrap: item.cost.scrap,
      fuel: item.cost.fuel,
      electronics: item.cost.electronics,
      food: item.cost.food,
    },
    enqueuedAt: item.enqueuedAt,
    startedAt: item.startedAt,
    completesAt: item.completesAt,
    eventId: item.eventId,
  };
}

// Promotes up to `slotsToFill` of the earliest still-waiting items (`startedAt === null`,
// in existing array order — the queue is append-only, so array order is enqueue order) to
// active, scheduling each one's `buildComplete` event inside the caller's transaction.
// Shared by `SettlementsService.cancelBuild` (a slot frees up when the cancelled item was
// active) and the `buildComplete` handler (a slot frees up when the active item finishes) —
// this is the one place that logic lives.
//
// `now` is deliberately a parameter rather than read internally: the handler passes the
// completed event's `dueAt`, not wall-clock time, so a promoted build's `startedAt` reflects
// when the previous one finished in game time, not when the scheduler got around to
// processing it after a restart (§12: replay resolves strictly in `dueAt` order, no
// fast-forward).
//
// Expects `queue` already normalised via `toPlainQueueItem` — see that function's comment.
export async function promoteWaitingItems(
  queue: readonly BuildQueueItemData[],
  slotsToFill: number,
  commandCenterLevel: number,
  config: GameConfig,
  eventScheduler: EventSchedulerService,
  settlementId: string,
  now: number,
  session: ClientSession,
): Promise<BuildQueueItemData[]> {
  const result = [...queue];
  let remainingSlots = slotsToFill;

  for (let i = 0; i < result.length && remainingSlots > 0; i += 1) {
    const item = result[i];
    if (!item || item.startedAt !== null) {
      continue;
    }

    const buildTimeMs = calcBuildTimeMs(
      config,
      item.type as BuildingType,
      item.targetLevel,
      commandCenterLevel,
    );
    const completesAt = now + buildTimeMs;
    const event = await eventScheduler.scheduleEvent(
      {
        type: BUILD_COMPLETE_EVENT_TYPE,
        dueAt: completesAt,
        payload: { settlementId, queueItemId: item.id },
      },
      session,
    );

    result[i] = { ...item, startedAt: now, completesAt, eventId: event._id as Types.ObjectId };
    remainingSlots -= 1;
  }

  return result;
}
