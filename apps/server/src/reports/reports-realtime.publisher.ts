import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, Types } from 'mongoose';

import { RealtimeGateway } from '../realtime/realtime.gateway';
import type { ChangeStreamResumeTokenDocument } from '../schemas/change-stream-resume-token.schema';
import { ChangeStreamResumeToken } from '../schemas/change-stream-resume-token.schema';
import type { ReportDocument, ReportType } from '../schemas/report.schema';
import { Report } from '../schemas/report.schema';

// The one shape this publisher actually reads off a `reports` insert's change-stream event —
// deliberately narrower than the MongoDB driver's own `ChangeStreamInsertDocument<T>`. That
// type lives in the `mongodb` package, which isn't a direct dependency of this package.json
// (only a transitive one, via `mongoose`) — reaching past `mongoose`'s own re-export
// (`mongoose.mongo`) for it would be borrowing a type surface this module doesn't own for the
// sake of four fields. A local interface, kept in sync with what `MovementArriveHandler`
// actually writes (`accountId`, `type`, `createdAt`, `_id`), is simpler and doesn't need
// `.watch()`'s own generics touched at all.
interface ReportInsertChangeEvent {
  operationType: string;
  fullDocument?: {
    _id: Types.ObjectId;
    accountId: Types.ObjectId;
    type: ReportType;
    createdAt: number;
  };
  // The change event's OWN resume token (distinct from `fullDocument._id`, the report's own
  // id) — every change stream event carries one, per the MongoDB change-stream protocol.
  // Opaque by design (see `ChangeStreamResumeToken.token`'s own comment); typed loosely here
  // since nothing in this file inspects its shape, only stores and later replays it verbatim
  // as `resumeAfter`.
  _id: Record<string, unknown>;
}

// Reconnect backoff: exponential, seeded low, capped — mirrors `SchedulerService`'s own
// `computeBackoffMs`/`MAX_BACKOFF_MS` (`scheduler/scheduler.service.ts`) exactly, same
// rationale (retries land on a later tick rather than hammering a still-down Mongo, or the
// logs, in a tight loop).
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

// Bridges "a report was durably written" to "push `reportArrived` to the owning account's
// sockets" — via a MongoDB change stream on the `reports` collection, not a direct call from
// `MovementArriveHandler` (or `resolveMissingTarget`) at the point each report is created.
//
// Why a change stream at all: `MovementArriveHandler.handle` runs *inside* the transaction
// `SchedulerService.dispatch` owns (`scheduler/scheduler.service.ts`, out of this step's
// scope) — that transaction only actually commits once `dispatch`'s own
// `session.withTransaction(...)` callback returns and the driver issues `commitTransaction()`,
// a point this module has no seam to hook into without either widening scope into the
// scheduler or racing the commit with a bare `setImmediate`/`.then()` guess (unsound: nothing
// observable distinguishes "about to commit" from "already committed" from inside the same
// transaction). MongoDB only ever delivers a change event once a write is durably committed
// and visible to a subsequent read (a multi-document transaction's change events are emitted
// together, only at commit — never for a transaction that aborts). So "received
// `reportArrived`" implies "a plain `findById` can already see this report" *by construction*,
// not by any ordering this module has to get right itself. It also means neither
// `MovementArriveHandler` nor `movements/**` needs to change at all: report writers stay
// entirely ignorant of realtime, exactly as the brief asks ("the arrival handler must not know
// socket.io exists").
//
// Self-healing (added after a real outage: a transient Mongo connection-pool error killed the
// stream permanently until process restart, silently — recorded as accepted M2 debt, then
// reopened as a real bug once it reproduced against real load). `openStream` is a small
// supervisor: any `error` or unexpected `close` schedules exactly one reconnect attempt after
// an exponential backoff (never two overlapping timers, never two overlapping streams — see
// `scheduleReconnect`'s guard), indefinitely — this is deliberately not a bounded retry count
// like `SchedulerService`'s own event-handler retries; realtime has no "give up and mark
// failed" state to fall back to, so it must keep trying to converge back to "streaming" for as
// long as the process runs. Successfully reconnecting resets the backoff (the `ready` event —
// see the class comment on `ReportsRealtimePublisher.openStream` below) and logs the recovery,
// not just the failure, so an operator watching logs can tell the system healed itself.
//
// Resume token vs. reopen fresh — WHAT CHANGED AND WHY (M3e.1, `docs/M3_DESIGN_DECISIONS.md`
// §16/§19.9). Through M2/M3d this publisher always reopened fresh rather than resuming: a
// resumed stream is strictly more correct (no missed inserts across an outage), but MongoDB
// can refuse to resume once the resume point ages out of the oplog (`ChangeStreamHistoryLost`)
// — an outage long enough to matter is exactly the case most likely to hit that — so resuming
// would still need a fresh-reopen fallback behind it regardless, doubling the failure modes
// this supervisor had to reason about for a push whose own payload was, at the time, *only* a
// freshness nudge: `ReportsService`/`GET /api/reports` was the real source of truth, and a
// client that missed a push still converged the next time it listed/polled.
//
// §16 justifies this fix by saying "the notification dispatcher makes push delivery load-
// bearing" — worth reading precisely, since it is a claim about a DIFFERENT push path, not
// this one. `NotificationDispatchHandler` (`notifications/handlers/notification-dispatch
// .handler.ts`) is driven by a self-rescheduling `GameEvent` through the ordinary scheduler
// poll loop, not by a change stream at all — see that class's own "how this is driven"
// comment. So notification delivery does not actually depend on THIS stream staying alive.
// What §16's argument gets right regardless: this fix closes a real, independent gap
// (M2b.4 — a transient Mongo connection-pool error silently killing `reportArrived` pushes
// until a manual restart) that was worth closing on its own merits, and the resume mechanism
// itself is genuinely reusable infrastructure (`ChangeStreamResumeToken`) the notification
// side could adopt later if it ever grows a stream-driven delivery path. The doubled failure
// modes that argued against resuming in M2/M3d are accepted here because the fix is now cheap
// and proven, not because this stream turned out to be load-bearing for notifications.
//
// **Resumed on every reopen — cold boot AND reconnect — with the fresh-reopen fallback kept
// behind it for `ChangeStreamHistoryLost`.** `onModuleInit` reads the persisted token from
// `ChangeStreamResumeToken` ONCE, before the very first `.watch()` call, and caches it in
// `cachedResumeToken`; every later reopen (a `scheduleReconnect` timer firing) reads that same
// in-memory field, kept fresh by every observed `change` event, rather than re-querying Mongo
// each time (the in-memory copy is always at least as current as the persisted one, since
// every write to the collection is paired with an in-memory update first — see the `change`
// listener below). A pm2/systemd restart on deploy is the case this actually pays for: it
// typically takes low single-digit seconds, comfortably inside the oplog's retention window,
// which is exactly when resuming succeeds and a report inserted during the restart still
// reaches its owner without a manual refetch. A genuinely long outage instead surfaces as
// `ChangeStreamHistoryLost` once the resume point ages out of the oplog — caught below,
// clearing the token so the NEXT reopen falls back to a plain, tokenless watch instead of
// retrying a doomed `resumeAfter` forever. That fallback's own accepted cost stays exactly as
// stated where it's handled: whatever was inserted between the last successfully-processed
// change and that reopen is missed, the same gap the pre-fix design accepted for EVERY outage,
// now scoped to the rarer case where an outage outlasted the oplog window.
@Injectable()
export class ReportsRealtimePublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReportsRealtimePublisher.name);
  private changeStream: ReturnType<Model<ReportDocument>['watch']> | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectAttempts = 0;
  // In-memory cache of the resume position — seeded once from the persisted
  // `ChangeStreamResumeToken` in `onModuleInit`, then kept current by every `change` event.
  // Read synchronously by `openStream`, both at cold boot and at every reconnect, so a reopen
  // never has to make a second Mongo round trip just to know where to resume from.
  // `undefined` means "no known position" (nothing was ever persisted, or a token was just
  // cleared after `ChangeStreamHistoryLost`) — the resume-less, reopen-fresh case, unchanged
  // from before this fix.
  private cachedResumeToken: Record<string, unknown> | undefined;
  private static readonly STREAM_NAME = 'reports';
  // Set once, in `onModuleDestroy`, and never unset — the one flag every async callback
  // (`error`, unexpected `close`, the reconnect timer itself) checks before doing anything
  // that would otherwise resurrect a stream or a timer after shutdown.
  private stopped = false;

  // Explicit @Inject tokens — see `HealthController`'s comment: Vitest's esbuild transform
  // emits no decorator metadata, so DI cannot rely on `design:paramtypes`.
  constructor(
    @InjectModel(Report.name) private readonly reportModel: Model<ReportDocument>,
    @Inject(RealtimeGateway) private readonly gateway: RealtimeGateway,
    @InjectModel(ChangeStreamResumeToken.name)
    private readonly resumeTokenModel: Model<ChangeStreamResumeTokenDocument>,
  ) {}

  // Async so the very first `.watch()` call — cold boot, not a reconnect — can also resume,
  // per the class comment. NestJS awaits `onModuleInit` hooks during bootstrap (the same
  // pattern `WorldService.onModuleInit` already uses in this codebase), so this genuinely
  // blocks the rest of app startup on one indexed `findOne` — negligible, and worth it for a
  // deploy-restart to resume cleanly instead of silently reopening fresh.
  async onModuleInit(): Promise<void> {
    try {
      const persisted = await this.resumeTokenModel.findOne({
        streamName: ReportsRealtimePublisher.STREAM_NAME,
      });
      this.cachedResumeToken = persisted?.token;
    } catch (error) {
      // Reading the persisted token itself failed (Mongo still settling right at boot, say) —
      // fall back to a fresh, tokenless first stream rather than blocking startup on a second
      // Mongo call that might keep failing. Logged so an operator can tell "resumed" from
      // "gave up and opened fresh" apart in the logs.
      this.logger.warn(
        'Could not read the persisted report change-stream resume token at boot — opening fresh',
        error instanceof Error ? error.stack : String(error),
      );
    }
    this.openStream();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    await this.changeStream?.close();
  }

  // Opens one change stream and wires its listeners — called once from `onModuleInit`, then
  // again every time `scheduleReconnect`'s timer fires. Each call's listeners close over this
  // call's own local `stream`, never `this.changeStream` — so a straggling event from a stream
  // this supervisor has already moved on from can't be mistaken for one from the current
  // stream (there's nothing to mistake it *for*: the closure only ever acts on the instance it
  // was attached to).
  private openStream(): void {
    // Scoped to inserts only — `reports` are never updated except the `read` flag flip
    // (`ReportsService.getAndMarkRead`), which nobody needs to be pushed a realtime event for.
    // `resumeAfter` only when `cachedResumeToken` actually holds something — `onModuleInit`
    // seeds it from the persisted token before the very first call here, and every later
    // reopen keeps it current via the `change` listener below, so this reads correctly at
    // cold boot and at every reconnect alike (see the class comment).
    const stream = this.reportModel.watch(
      [{ $match: { operationType: 'insert' } }],
      this.cachedResumeToken ? { resumeAfter: this.cachedResumeToken } : {},
    );
    this.changeStream = stream;

    stream.on('change', (change: ReportInsertChangeEvent) => {
      // Cached synchronously (before anything async) and persisted best-effort — see the
      // class comment for why only the in-memory copy is ever read back by `openStream`.
      // Updated even for a change with no `fullDocument` below (shouldn't happen for an
      // insert-only stream, but there's no reason to skip advancing the position over it).
      this.cachedResumeToken = change._id;
      void this.persistResumeToken(change._id);

      const doc = change.fullDocument;
      if (!doc) {
        return;
      }
      // Minimal payload (§ M2b.4 brief): enough for the client to invalidate its reports
      // query/badge, not the whole report — the client re-fetches the full report (and marks
      // it read) via `GET /api/reports/:id` when the player actually opens it.
      this.gateway.emitToAccount(doc.accountId, 'reportArrived', {
        id: String(doc._id),
        type: doc.type,
        createdAt: doc.createdAt,
      });
    });

    // Fires once the underlying driver stream is actually established and receiving from the
    // server (`mongoose`'s `ChangeStream` wrapper emits this after its own connect promise
    // resolves) — the genuine "we're back" signal, as opposed to merely "we called `.watch()`
    // again," which is why backoff resets here and nowhere earlier.
    stream.on('ready', () => {
      if (this.reconnectAttempts > 0) {
        this.logger.log(`Report change stream reopened after ${this.reconnectAttempts} attempt(s)`);
      }
      this.reconnectAttempts = 0;
    });

    stream.on('error', (error: unknown) => {
      this.logger.error(
        'Report change stream error',
        error instanceof Error ? error.stack : String(error),
      );
      // The fresh-reopen fallback the class comment promises: once the resume point has aged
      // out of the oplog, resuming from it can never succeed — retrying the same `resumeAfter`
      // forever would just reproduce this exact error every time. Clearing the cached (and
      // persisted) token here means the NEXT `openStream` call (`scheduleReconnect`, below)
      // falls back to a plain, tokenless watch — the accepted cost stated in the class comment:
      // whatever was inserted between the last successfully-processed change and this reopen
      // is missed, exactly the same gap the pre-fix design accepted for EVERY outage, now
      // scoped to the rarer case where an outage outlasted the oplog window.
      if (this.isChangeStreamHistoryLost(error)) {
        this.cachedResumeToken = undefined;
        void this.clearPersistedResumeToken();
      }
      this.handleStreamDown(stream);
    });

    // A `close` this supervisor didn't itself cause (`onModuleDestroy`, guarded by `stopped`
    // below) means the stream died without necessarily raising `error` first (e.g. the
    // underlying connection was simply dropped) — still needs recovery, same as `error`.
    stream.on('close', () => {
      if (!this.stopped) {
        this.handleStreamDown(stream);
      }
    });
  }

  // `ChangeStreamHistoryLost` (MongoDB error code 286) — the one error this supervisor treats
  // differently from any other transient failure: every other `error`/`close` retries the SAME
  // resume position (correct — the position is still good, just temporarily unreachable),
  // while this one means the position itself is no longer valid and must be abandoned. Checked
  // by `codeName`/`code` rather than an `instanceof` against a driver error class: this file
  // has no direct dependency on the `mongodb` driver package (only the transitive one via
  // `mongoose` — the same reasoning `ReportInsertChangeEvent`'s own comment already gives for
  // not reaching past `mongoose` for a driver type), so a loose structural check is this file's
  // existing convention, not a new one.
  private isChangeStreamHistoryLost(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
      return false;
    }
    const { code, codeName } = error as { code?: unknown; codeName?: unknown };
    return codeName === 'ChangeStreamHistoryLost' || code === 286;
  }

  // Best-effort durable copy of `cachedResumeToken` (see the class comment for what it's
  // for today, and what it deliberately isn't wired to do yet). Never awaited by the `change`
  // listener that calls it — a slow or failing write here must not delay processing the next
  // change event — and its own failure is logged, not thrown: the in-memory cache remains
  // authoritative for this process's own remaining lifetime regardless of whether this
  // particular write lands.
  private async persistResumeToken(token: Record<string, unknown>): Promise<void> {
    try {
      await this.resumeTokenModel.updateOne(
        { streamName: ReportsRealtimePublisher.STREAM_NAME },
        { $set: { token } },
        { upsert: true },
      );
    } catch (error) {
      this.logger.warn(
        'Failed to persist the report change-stream resume token',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async clearPersistedResumeToken(): Promise<void> {
    try {
      await this.resumeTokenModel.deleteOne({ streamName: ReportsRealtimePublisher.STREAM_NAME });
    } catch (error) {
      this.logger.warn(
        'Failed to clear the stale report change-stream resume token',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private handleStreamDown(stream: ReturnType<Model<ReportDocument>['watch']>): void {
    // Best-effort: a stream that already errored/closed on its own has nothing left to clean
    // up server-side, so a redundant `.close()` here is expected to no-op, not throw — but
    // guarded anyway rather than letting a rejection become an unhandled promise rejection.
    stream.close().catch(() => {});
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    // Never two overlapping timers (a `change`-then-`close` or `error`-then-`close` pair for
    // the same failure would otherwise double-schedule) and never once shutdown has started.
    if (this.stopped || this.reconnectTimer) {
      return;
    }

    this.reconnectAttempts += 1;
    const delayMs = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** (this.reconnectAttempts - 1),
      RECONNECT_MAX_DELAY_MS,
    );
    this.logger.warn(
      `Reopening report change stream in ${delayMs}ms (attempt ${this.reconnectAttempts})`,
    );

    const timer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openStream();
    }, delayMs);
    // Never keeps the process alive on its own — mirrors `SchedulerService`'s own poll timer
    // (`scheduler/scheduler.service.ts`) for the identical reason: only in-flight work should.
    timer.unref();
    this.reconnectTimer = timer;
  }
}
