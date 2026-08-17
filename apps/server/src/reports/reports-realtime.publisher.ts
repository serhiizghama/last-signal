import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, Types } from 'mongoose';

import { RealtimeGateway } from '../realtime/realtime.gateway';
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
// Resume token vs. reopen fresh (deliberate choice, not an oversight): this publisher reopens
// fresh rather than resuming from the last-seen resume token. A resumed stream is strictly
// more correct (no missed inserts across the outage window), but MongoDB can refuse to resume
// once the resume point has aged out of the oplog (`ChangeStreamHistoryLost`), which an outage
// long enough to matter is exactly the case most likely to hit — so resuming would still need
// a fresh-reopen fallback behind it, doubling the failure modes this supervisor has to reason
// about for a feature whose own payload is *already* a mere freshness nudge, not a source of
// truth (`ReportsService`/`GET /api/reports` is; a client that missed a push still converges
// the next time it lists/polls). Reopening fresh accepts a plain, statable cost instead: **a
// report inserted while the stream is down gets no `reportArrived` push** — the client's own
// refetch (opening the Reports tab, or its own periodic query invalidation) is the backstop,
// not a resume-token replay.
@Injectable()
export class ReportsRealtimePublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReportsRealtimePublisher.name);
  private changeStream: ReturnType<Model<ReportDocument>['watch']> | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectAttempts = 0;
  // Set once, in `onModuleDestroy`, and never unset — the one flag every async callback
  // (`error`, unexpected `close`, the reconnect timer itself) checks before doing anything
  // that would otherwise resurrect a stream or a timer after shutdown.
  private stopped = false;

  // Explicit @Inject tokens — see `HealthController`'s comment: Vitest's esbuild transform
  // emits no decorator metadata, so DI cannot rely on `design:paramtypes`.
  constructor(
    @InjectModel(Report.name) private readonly reportModel: Model<ReportDocument>,
    @Inject(RealtimeGateway) private readonly gateway: RealtimeGateway,
  ) {}

  onModuleInit(): void {
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
    const stream = this.reportModel.watch([{ $match: { operationType: 'insert' } }]);
    this.changeStream = stream;

    stream.on('change', (change: ReportInsertChangeEvent) => {
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
