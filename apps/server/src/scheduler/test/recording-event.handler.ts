import type { ClientSession, Connection } from 'mongoose';

import type { GameEventDocument } from '../../schemas/event.schema';
import type { EventHandler } from '../event-handler.interface';

// Test-only handler for scheduler.spec.ts. Not registered in production
// wiring (nothing in AppModule/SchedulerModule references this file) — this
// directory is named `test/` specifically because tsconfig.build.json
// excludes it, so it never ships in `dist`.
//
// It proves the engine end-to-end without depending on any real feature
// handler: on each `handle()` call it writes a document (through the
// transaction's session) recording that it ran, then — if told to — throws,
// so tests can assert that the write rolls back together with the `done`
// mark.
export class RecordingEventHandler implements EventHandler {
  readonly type = 'testRecord';
  readonly supportedPayloadVersions = [1];

  readonly handledEventIds: string[] = [];
  private failuresRemaining = 0;

  constructor(private readonly connection: Connection) {}

  // Makes the next `n` calls to `handle()` throw after writing their effect
  // record, simulating a transiently failing handler.
  failNextAttempts(n: number): void {
    this.failuresRemaining = n;
  }

  // Clears per-test state; call from `afterEach` so tests don't leak into
  // one another.
  reset(): void {
    this.handledEventIds.length = 0;
    this.failuresRemaining = 0;
  }

  async handle(event: GameEventDocument, session: ClientSession): Promise<void> {
    await this.connection
      .collection('scheduler-test-effects')
      .insertOne({ eventId: event._id, payload: event.payload }, { session });

    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error('RecordingEventHandler: deliberate test failure');
    }

    this.handledEventIds.push(String(event._id));
  }
}
