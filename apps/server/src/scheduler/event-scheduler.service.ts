import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model, Types } from 'mongoose';

import type { GameEventDocument } from '../schemas/event.schema';
import { GameEvent } from '../schemas/event.schema';

export interface ScheduleEventInput {
  type: string;
  dueAt: number;
  payload: Record<string, unknown>;
  // Defaults to 1. Callers introducing a breaking payload shape change bump
  // this and register the new version with the handler.
  payloadVersion?: number;
}

// The write-side counterpart to `SchedulerService`: how other modules enqueue
// an event. Accepts an optional session so a command can create its event
// inside the *same* transaction that spends the resources behind it — e.g.
// "deduct resources, schedule buildComplete" must commit or abort together.
@Injectable()
export class EventSchedulerService {
  constructor(@InjectModel(GameEvent.name) private readonly eventModel: Model<GameEventDocument>) {}

  async scheduleEvent(
    input: ScheduleEventInput,
    session?: ClientSession,
  ): Promise<GameEventDocument> {
    const [created] = await this.eventModel.create(
      [
        {
          type: input.type,
          dueAt: input.dueAt,
          payload: input.payload,
          payloadVersion: input.payloadVersion ?? 1,
        },
      ],
      { session },
    );

    // `create([...])` with an array argument always resolves one document
    // per input element, so this is unreachable in practice — narrows the
    // type for TypeScript rather than guarding a real runtime case.
    if (!created) {
      throw new Error('EventSchedulerService: event creation returned no document');
    }

    return created;
  }

  // Cancels a still-pending event (used by `SettlementsService.cancelBuild` to drop the
  // `buildComplete` scheduled for the cancelled item). Deletion rather than a `cancelled`
  // status: nothing ever reads a dead event again, so there is no reason to keep a row
  // around for it, and it keeps the `EventStatus` enum free of a status the scheduler
  // itself never needs to reason about. Not filtered on `status: 'due'` — if the scheduler
  // has already claimed the event (`processing`) and is mid-dispatch, this delete and that
  // dispatch's own writes race normally at the transaction level like any other concurrent
  // write to the same document, which is exactly what the concurrency playbook (§11)
  // expects every caller to be safe under.
  async cancelEvent(eventId: Types.ObjectId, session?: ClientSession): Promise<void> {
    await this.eventModel.deleteOne({ _id: eventId }, { session });
  }
}
