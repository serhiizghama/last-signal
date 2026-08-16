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

// Bridges "a report was durably written" to "push `reportArrived` to the owning account's
// sockets" — via a MongoDB change stream on the `reports` collection, not a direct call from
// `MovementArriveHandler` (or `resolveMissingTarget`) at the point each report is created.
//
// Why: `MovementArriveHandler.handle` runs *inside* the transaction `SchedulerService.dispatch`
// owns (`scheduler/scheduler.service.ts`, out of this step's scope) — that transaction only
// actually commits once `dispatch`'s own `session.withTransaction(...)` callback returns and
// the driver issues `commitTransaction()`, a point this module has no seam to hook into
// without either widening scope into the scheduler or racing the commit with a bare
// `setImmediate`/`.then()` guess (unsound: nothing observable distinguishes "about to commit"
// from "already committed" from inside the same transaction). Emitting from *inside* the
// handler, synchronously with the report writes, would therefore risk telling a client
// `reportArrived` for a report a concurrent `GET /api/reports/:id` — reading outside the
// transaction, hence outside its as-yet-uncommitted writes — cannot see yet, or (if the
// transaction later aborts, e.g. a version conflict elsewhere in the same handler run) will
// never see at all.
//
// A change stream sidesteps the problem entirely rather than solving it cleverly: MongoDB only
// ever delivers a change event once the write is durably committed and visible to a
// subsequent read (for a multi-document transaction, its change events are emitted together,
// only at commit — never for a transaction that aborts). So "received `reportArrived`" implies
// "a plain `findById` can already see this report" *by construction*, not by any ordering this
// module has to get right itself. It also means neither `MovementArriveHandler` nor
// `movements/**` needs to change at all: report writers stay entirely ignorant of realtime,
// exactly as the brief asks ("the arrival handler must not know socket.io exists").
@Injectable()
export class ReportsRealtimePublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReportsRealtimePublisher.name);
  private changeStream: ReturnType<Model<ReportDocument>['watch']> | undefined;

  // Explicit @Inject tokens — see `HealthController`'s comment: Vitest's esbuild transform
  // emits no decorator metadata, so DI cannot rely on `design:paramtypes`.
  constructor(
    @InjectModel(Report.name) private readonly reportModel: Model<ReportDocument>,
    @Inject(RealtimeGateway) private readonly gateway: RealtimeGateway,
  ) {}

  onModuleInit(): void {
    // Scoped to inserts only — `reports` are never updated except the `read` flag flip
    // (`ReportsService.getAndMarkRead`), which nobody needs to be pushed a realtime event for.
    const stream = this.reportModel.watch([{ $match: { operationType: 'insert' } }]);

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

    stream.on('error', (error: unknown) => {
      // Never lets an unhandled 'error' event crash the process (Node's `EventEmitter`
      // throws if 'error' has no listener) — expected during teardown (the replica set or
      // connection closing out from under an open stream), logged rather than swallowed
      // silently for the unexpected case.
      this.logger.error(
        'Report change stream error',
        error instanceof Error ? error.stack : String(error),
      );
    });

    this.changeStream = stream;
  }

  async onModuleDestroy(): Promise<void> {
    await this.changeStream?.close();
  }
}
