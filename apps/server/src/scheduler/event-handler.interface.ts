import type { ClientSession } from 'mongoose';

import type { GameEventDocument } from '../schemas/event.schema';

// Contract every scheduler-dispatched handler must satisfy. Handlers must be
// idempotent: a crash between the worker's claim and its transaction commit
// means the same event can be handed to `handle` more than once, so a
// handler is expected to re-check state rather than blindly reapply effects.
export interface EventHandler {
  // Matches `GameEvent.type`. The registry rejects two handlers claiming the
  // same type.
  readonly type: string;

  // Payload shapes this handler knows how to interpret. The worker refuses
  // to dispatch an event whose `payloadVersion` isn't listed here — straight
  // to `failed`, no retry, since retrying can't fix a structurally unknown
  // payload.
  readonly supportedPayloadVersions: readonly number[];

  // Runs inside the same transaction as the event's `done` mark, so effects
  // and the mark commit — or roll back — together. `handle` must perform
  // every write through `session` for that guarantee to hold.
  handle(event: GameEventDocument, session: ClientSession): Promise<void>;
}
