import type { Resources } from '@last-signal/game-core';
import type { Types } from 'mongoose';

// The subset of `TrainingQueueItem` this module reads/writes — a genuine plain object,
// never a Mongoose (sub)document. Mirrors `BuildQueueItemData` in `build-queue.util.ts` —
// see that file's comment for why: spreading a Mongoose subdocument (or writing one back
// wholesale) drags its internal bookkeeping (which circularly references the connection)
// along with the schema fields, and both `res.json()` and the MongoDB driver's BSON
// encoder throw trying to serialize the result.
export interface TrainingQueueItemData {
  id: string;
  unitType: string;
  totalCount: number;
  remainingCount: number;
  unitTrainTimeMs: number;
  startedAt: number;
  nextCompletesAt: number;
  cost: Resources;
  eventId?: Types.ObjectId;
}

// Reads each named field individually (a getter access, which Mongoose documents support
// fine) and builds a genuine object literal — call this on every `TrainingQueueItem`
// subdocument before putting it back into a plain array headed for a `$set`/`$push`.
export function toPlainTrainingQueueItem(item: {
  id: string;
  unitType: string;
  totalCount: number;
  remainingCount: number;
  unitTrainTimeMs: number;
  startedAt: number;
  nextCompletesAt: number;
  cost: Resources;
  eventId?: Types.ObjectId;
}): TrainingQueueItemData {
  return {
    id: item.id,
    unitType: item.unitType,
    totalCount: item.totalCount,
    remainingCount: item.remainingCount,
    unitTrainTimeMs: item.unitTrainTimeMs,
    startedAt: item.startedAt,
    nextCompletesAt: item.nextCompletesAt,
    cost: {
      scrap: item.cost.scrap,
      fuel: item.cost.fuel,
      electronics: item.cost.electronics,
      food: item.cost.food,
    },
    eventId: item.eventId,
  };
}
