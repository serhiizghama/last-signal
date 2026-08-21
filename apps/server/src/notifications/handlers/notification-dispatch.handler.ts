import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { EventSchedulerService } from '../../scheduler/event-scheduler.service';
import type { EventHandler } from '../../scheduler/event-handler.interface';
import type { GameEventDocument } from '../../schemas/event.schema';
import type { NotificationDocument } from '../../schemas/notification.schema';
import { Notification } from '../../schemas/notification.schema';
import {
  NOTIFICATION_DISPATCH_BATCH_SIZE,
  NOTIFICATION_DISPATCH_EVENT_TYPE,
  NOTIFICATION_DISPATCH_INTERVAL_MS,
} from '../notifications.constants';
import { InAppNotificationProvider } from '../providers/in-app-notification.provider';
import { TelegramNotificationProvider } from '../providers/telegram-notification.provider';
import type { NotificationProvider } from '../providers/notification-provider.interface';

// The dispatcher (§16, Deliverable 3): drains undelivered outbox rows through every
// registered `NotificationProvider`, oldest first, and stamps `deliveredAt`/`provider` once a
// row has been handed to all of them.
//
// **How this is driven — the choice the brief asks to justify against the alternatives.**
// Three shapes were on the table:
//   1. A self-rescheduling `GameEvent`, exactly like `StarvationTickHandler`'s hourly tick or
//      `TrainingCompleteHandler`'s chained per-unit event — the shape this class uses.
//   2. A hook appended directly to `SchedulerService.runOnce()`'s own tick, bypassing the
//      `EventHandler`/`GameEvent` machinery entirely.
//   3. A MongoDB change stream on `notifications`, mirroring `ReportsRealtimePublisher`.
// (2) is rejected because it would make `scheduler/` — a module with zero knowledge of any
// specific feature today — directly aware of `notifications/`, the same layering `EventHandler`
// exists to avoid for every other feature; it also buys nothing (1) doesn't already give for
// free, since both ultimately ride the same 1s poll loop. (3) is rejected because a change
// stream only ever fires once per underlying insert — it has no notion of "retry this row
// later", so it cannot satisfy the brief's own row-level requirement ("a provider throwing
// must not strand the whole drain — isolate per row, log, leave the row undelivered for the
// next pass"): once a row's insert event has been delivered to the stream listener, a
// provider failure on it has no "next pass" to be picked up on again, short of bolting a
// second, poll-based retry sweep on top anyway — at which point the change stream is no
// longer the actual correctness mechanism, just an unnecessary low-latency nudge on top of
// one. (1) needs no new infrastructure (the plan's own constraint) — `GameEvent`/
// `EventHandlerRegistry`/`SchedulerService` already exist and already claim events strictly
// one at a time on a single process — so this handler gets "at most one drain in flight" for
// free, the same guarantee every other handler in this codebase already relies on, with zero
// new moving parts. Interval: `NOTIFICATION_DISPATCH_INTERVAL_MS` (2s) — see that constant's
// own comment for why, against the ~1-core/2GB VPS target and this project's "nothing ticks
// in the background outside the scheduler's own single poll loop" rule (§18/`docs/
// CONCURRENCY_PLAYBOOK.md` §4): this handler adds no second timer, it just makes the existing
// one carry one more recurring event type, the same way `StarvationTickHandler` already does.
//
// **This means §16's own justification for the `ReportsRealtimePublisher` resume fix — "the
// notification dispatcher makes push delivery load-bearing" — does not describe THIS
// dispatcher.** Delivery here never depends on any change stream staying alive; it depends
// only on the scheduler's poll loop, which this file already argued (above) is the more
// robust choice specifically because a change stream can't satisfy the row-level retry
// requirement. The resume fix still stands on its own merits (it closes a real, independent
// gap for `reportArrived`) — see that class's own comment for the corrected framing.
//
// **A player who is offline.** §16 does not ask for store-and-forward beyond the outbox row
// itself existing, and this handler doesn't attempt any — `InAppNotificationProvider.deliver`
// is fire-and-forget (see that class's own comment): a WS push to a disconnected account's
// empty room is not an error, just wasted (but cheap) work, and the row is still marked
// delivered. The durable outbox row is what makes that acceptable: the notification's
// *existence* is never lost, only this one delivery attempt's liveness — no different from
// `ReportsRealtimePublisher`'s own accepted gap for `reportArrived`.
//
// **At-least-once, idempotent at the row level, crash-safe.** `handle` runs inside the same
// transaction as its own `done` mark (`SchedulerService.dispatch`) — a crash before commit
// rolls both back, so a row this tick marked `deliveredAt` either lands durably marked or not
// at all; there is no partially-committed state to recover from. What is NOT
// transactional is the provider calls themselves: if the transaction's underlying commit
// retries internally (a `TransientTransactionError`, which `session.withTransaction` retries
// by re-running this whole callback), or if the process crashes between a provider call
// succeeding and this transaction committing, a provider can be invoked again for the same
// row on the next attempt. This is the accepted, explicitly-scoped cost of "at-least-once,
// idempotent at the row level" (the brief's own words): the ROW is never double-marked or
// lost, but an individual provider call (an extra WS emit, an extra stub log line) can
// duplicate — harmless for both of M3's providers, and exactly the same class of cost this
// codebase already accepts elsewhere (`ReportsRealtimePublisher`'s reconnect can re-deliver a
// change event it already pushed once).
@Injectable()
export class NotificationDispatchHandler implements EventHandler {
  readonly type = NOTIFICATION_DISPATCH_EVENT_TYPE;
  readonly supportedPayloadVersions = [1];

  private readonly logger = new Logger(NotificationDispatchHandler.name);

  // Fixed, constructor-injected list — mirrors `MovementArriveHandler`'s own "concrete
  // classes injected directly, collected into a plain array/map at construction" convention
  // (see that class's own comment) rather than a generic multi-provider DI token: M3 ships
  // exactly two providers and both always run for every row (§16 names no per-provider
  // toggle, only per-kind ones), so there is nothing a more general registration mechanism
  // would buy here.
  private readonly providers: readonly NotificationProvider[];

  constructor(
    @InjectModel(Notification.name) private readonly notificationModel: Model<NotificationDocument>,
    @Inject(EventSchedulerService) private readonly eventScheduler: EventSchedulerService,
    @Inject(InAppNotificationProvider) inAppProvider: InAppNotificationProvider,
    @Inject(TelegramNotificationProvider) telegramProvider: TelegramNotificationProvider,
  ) {
    this.providers = [inAppProvider, telegramProvider];
  }

  async handle(event: GameEventDocument, session: ClientSession): Promise<void> {
    const rows = await this.notificationModel
      .find({ deliveredAt: { $exists: false } }, null, { session })
      .sort({ createdAt: 1 })
      .limit(NOTIFICATION_DISPATCH_BATCH_SIZE);

    for (const row of rows) {
      try {
        const deliveredThrough: string[] = [];
        for (const provider of this.providers) {
          await provider.deliver({
            id: String(row._id),
            accountId: row.accountId,
            kind: row.kind,
            payload: row.payload,
            createdAt: row.createdAt,
          });
          deliveredThrough.push(provider.name);
        }
        // `event.dueAt`, never `Date.now()` (§18's determinism rule — applies to every
        // handler, not only combat ones). Guarded by the same `deliveredAt: { $exists:
        // false }` this row was selected by, so a row already stamped by a — structurally
        // impossible under this project's single-process scheduler, but cheap to guard
        // anyway — concurrent drain is never re-stamped.
        await this.notificationModel.updateOne(
          { _id: row._id, deliveredAt: { $exists: false } },
          { $set: { deliveredAt: event.dueAt, provider: deliveredThrough } },
          { session },
        );
      } catch (error) {
        // Isolated to this one row (the brief's own requirement): logged, left undelivered,
        // and the loop moves on — a bad row (or a transient provider failure) must never
        // strand every other row queued behind it.
        this.logger.error(
          `NotificationDispatchHandler: delivering notification ${String(row._id)} ` +
            `(kind="${row.kind}") failed — left undelivered for the next pass`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    // The heartbeat never stops: a fresh `notificationDispatch` event is always scheduled,
    // regardless of how this tick's rows fared — there is no "done, nothing left to do"
    // terminal state for this handler the way `StarvationTickHandler`'s hourly tick has one.
    // A full batch schedules the next tick at the SAME `dueAt` (still immediately claimable
    // by `SchedulerService.runOnce`'s own claim-loop within this very tick — see the class
    // comment) rather than waiting a full interval, so a backlog (e.g. after downtime) drains
    // across consecutive claims instead of trickling out one interval at a time.
    const nextDueAt =
      rows.length === NOTIFICATION_DISPATCH_BATCH_SIZE
        ? event.dueAt
        : event.dueAt + NOTIFICATION_DISPATCH_INTERVAL_MS;
    await this.eventScheduler.scheduleEvent(
      { type: NOTIFICATION_DISPATCH_EVENT_TYPE, dueAt: nextDueAt, payload: {} },
      session,
    );
  }
}
