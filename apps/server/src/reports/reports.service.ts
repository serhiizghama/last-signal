import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';

import type { ReportDocument } from '../schemas/report.schema';
import { Report } from '../schemas/report.schema';
import { DEFAULT_REPORTS_LIMIT, MAX_REPORTS_LIMIT } from './reports.constants';
import { decodeReportCursor, encodeReportCursor } from './reports-cursor.util';
import { ReportNotFoundError } from './reports.errors';
import type { ReportsPageView, ReportView } from './reports.view';
import { toReportView } from './reports.view';

@Injectable()
export class ReportsService {
  constructor(@InjectModel(Report.name) private readonly reportModel: Model<ReportDocument>) {}

  // The caller's own inbox, newest first, cursor-paginated (§8/M2b.4 brief) — never anyone
  // else's (the `accountId` filter is the entire ownership boundary here; there is no
  // per-report ownership check to bypass the way `getAndMarkRead` needs one, since this never
  // takes a report id as input in the first place).
  async listMine(
    accountId: Types.ObjectId,
    cursorRaw: string | undefined,
    limitRaw: number | undefined,
    now: number,
  ): Promise<ReportsPageView> {
    const limit = Math.min(limitRaw ?? DEFAULT_REPORTS_LIMIT, MAX_REPORTS_LIMIT);

    // Not typed via mongoose's own `FilterQuery<T>` — this mongoose version doesn't export
    // one (see every other service in this codebase: filters are passed as plain object
    // literals throughout, never through a named filter type).
    const filter: { accountId: Types.ObjectId; $or?: Array<Record<string, unknown>> } = {
      accountId,
    };
    if (cursorRaw) {
      const cursor = decodeReportCursor(cursorRaw);
      // Seek past everything the previous page already returned: strictly older `createdAt`,
      // or the same `createdAt` with a strictly smaller `_id` — the exact tiebreak the
      // `{accountId, createdAt: -1, _id: -1}` index (`schemas/report.schema.ts`) is built to
      // serve without a blocking in-memory sort.
      filter['$or'] = [
        { createdAt: { $lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, _id: { $lt: new Types.ObjectId(cursor.id) } },
      ];
    }

    // Fetch one extra row rather than issuing a second `countDocuments` (or trusting
    // `docs.length === limit` to mean "there might be more" — that's also true when the
    // account has *exactly* `limit` reports total, which would wrongly hand back a
    // `nextCursor` that resolves to an empty page): if the `limit + 1`th row exists, there is
    // a next page and its cursor is the `limit`th row's own key; otherwise there isn't.
    const [docs, unreadCount] = await Promise.all([
      this.reportModel
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .limit(limit + 1),
      this.reportModel.countDocuments({ accountId, read: false }),
    ]);

    const hasMore = docs.length > limit;
    const page = hasMore ? docs.slice(0, limit) : docs;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeReportCursor({ createdAt: last.createdAt, id: String(last._id) })
        : null;

    return {
      reports: page.map((doc) => toReportView(doc, now)),
      nextCursor,
      unreadCount,
      serverTime: now,
    };
  }

  // Read-on-open (§8's own "read-on-open" wording): fetching a single report is what marks
  // it read, idempotently — a second fetch of the same report is a no-op write. No separate
  // `POST /:id/read` exists (or is needed): M2 has no "mark unread," no "mark all read," and
  // no read path other than opening a report, so a second endpoint would only ever duplicate
  // this one's own effect under a different verb.
  async getAndMarkRead(
    reportId: string,
    accountId: Types.ObjectId,
    now: number,
  ): Promise<ReportView> {
    this.assertValidId(reportId);

    const doc = await this.reportModel.findById(reportId);
    // Same "don't leak existence" convention as `SettlementNotFoundError`/
    // `MovementNotFoundError`: a report that exists but belongs to someone else answers
    // identically to one that doesn't exist at all — 404, never 403.
    if (!doc || !doc.accountId.equals(accountId)) {
      throw new ReportNotFoundError(reportId);
    }

    if (!doc.read) {
      await this.reportModel.updateOne({ _id: doc._id }, { $set: { read: true } });
      // Reflected locally rather than re-fetched — a single `updateOne` on an already-loaded
      // `read: boolean` can't race itself into a surprising value the way a version-guarded
      // multi-field command write could, so there's nothing a second read would catch that
      // this doesn't already know.
      doc.read = true;
    }

    return toReportView(doc, now);
  }

  private assertValidId(reportId: string): void {
    if (!Types.ObjectId.isValid(reportId)) {
      throw new ReportNotFoundError(reportId);
    }
  }
}
