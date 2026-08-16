import type { ReportDocument, ReportType } from '../schemas/report.schema';

// The client's countdowns/timestamps are always driven from `serverTime`, run locally, never
// trusting the client's own clock — same convention as `MovementView`/`SettlementStateView`'s
// own `serverTime` field.
export interface ReportView {
  id: string;
  type: ReportType;
  read: boolean;
  createdAt: number;
  // Structured ids + numbers only, never prose (§8/M1 §15) — passed through exactly as
  // `MovementArriveHandler` wrote it; the client renders prose from these keys/ids.
  payload: Record<string, unknown>;
  serverTime: number;
}

// Pure reshape of a persisted report document into the wire view model.
//
// `doc.payload` is spread into a fresh object rather than returned by reference: `payload`'s
// `@Prop` type is `Mixed` (`schemas/report.schema.ts`), which — unlike a declared sub-schema
// such as `Settlement.resources` (see `toPlainResources`'s comment in
// `settlements/settlements.view.ts`) — Mongoose does hand back as a genuine plain object with
// no internal bookkeeping attached. The shallow copy here is a deliberately cheap defensive
// habit matching that file's convention (never let a response body alias a live Mongoose
// document's own storage), not a fix for an actual serialization hazard like `toPlainResources`
// guards against.
export function toReportView(doc: ReportDocument, now: number): ReportView {
  return {
    id: String(doc._id),
    type: doc.type,
    read: doc.read,
    createdAt: doc.createdAt,
    payload: { ...doc.payload },
    serverTime: now,
  };
}

export interface ReportsPageView {
  reports: ReportView[];
  // `null` once the account has no older reports left — the client's "load more" stops
  // offering another page.
  nextCursor: string | null;
  unreadCount: number;
  serverTime: number;
}
