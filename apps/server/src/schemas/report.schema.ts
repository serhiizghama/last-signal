import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

// The three report kinds M2b.3 produces (`docs/M2_DESIGN_DECISIONS.md` §8) — a scouting
// mission with intel, a scouting mission with zero survivors (or a missing target — see
// `MovementArriveHandler`'s own comment), and the defender's counter-report when detected.
// Deeper report types (combat, trade, ...) are M3.
export type ReportType = 'scout' | 'scoutFailed' | 'scoutDetected';
const REPORT_TYPES: ReportType[] = ['scout', 'scoutFailed', 'scoutDetected'];

export const REPORT_TYPE_SCOUT: ReportType = 'scout';
export const REPORT_TYPE_SCOUT_FAILED: ReportType = 'scoutFailed';
export const REPORT_TYPE_SCOUT_DETECTED: ReportType = 'scoutDetected';

export type ReportDocument = HydratedDocument<Report>;

// A player's inbox entry (§8: "the server ships keys/ids, the client renders prose" — M1
// §15). Written only by scheduler handlers (`movements/handlers/*`) today; there is no
// player-facing write path for this collection.
@Schema({
  collection: 'reports',
  timestamps: { currentTime: () => Date.now() },
  versionKey: false,
})
export class Report {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Account', required: true, index: true })
  accountId!: Types.ObjectId;

  @Prop({ type: String, enum: REPORT_TYPES, required: true })
  type!: ReportType;

  @Prop({ type: Boolean, required: true, default: false })
  read!: boolean;

  // Structured ids + numbers only, never prose (§8/M1 §15) — see each report writer
  // (`movements/handlers/movement-arrive.handler.ts`) for the exact shape per `type`.
  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  payload!: Record<string, unknown>;

  @Prop({ type: Number })
  createdAt!: number;

  @Prop({ type: Number })
  updatedAt!: number;
}

export const ReportSchema = SchemaFactory.createForClass(Report);

// The inbox read order (§8) AND the cursor-pagination sort key (M2b.4): newest first, per
// account, with `_id` as the tiebreaker for reports sharing the same millisecond `createdAt`
// (routine here — an attacker's `scout`/`scoutFailed` report and the defender's
// `scoutDetected` counter-report are written in the same transaction, at the same `Date.now()`
// read). Without `_id` in the index, that tie would need an in-memory sort to resolve
// deterministically; with it, `{createdAt: -1, _id: -1}` is a single covered sort the
// `(createdAt, _id)` seek cursor (`ReportsService.listMine`) can walk page after page without
// ever skipping or repeating a row.
ReportSchema.index({ accountId: 1, createdAt: -1, _id: -1 });

// The unread-count lookup (§8) — partial so the index only ever covers the (small,
// ever-shrinking) set of actually-unread reports rather than every report ever written.
ReportSchema.index({ accountId: 1, read: 1 }, { partialFilterExpression: { read: false } });
