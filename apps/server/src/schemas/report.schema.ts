import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

// The report kinds shipped so far: the three M2b.3 produces
// (`docs/M2_DESIGN_DECISIONS.md` §8) — a scouting mission with intel, a scouting mission
// with zero survivors (or a missing target — see `MovementArriveHandler`'s own comment),
// and the defender's counter-report when detected — plus `starvation` (M3a.6,
// `docs/M3_DESIGN_DECISIONS.md` §4/§15): written to a settlement's owner and to each
// supporter whose stationed contingent lost units on an hourly starvation tick. M3c
// (§15) adds the six kinds combat/oases produce: `raid`/`assault` (written for the
// attacker), `defense` (the same battle, written for the defending settlement's owner),
// `supportLoss` (written to a supporter whose stationed contingent took casualties),
// `oasisRaid` (an oasis raid's own report — defenders met, losses, Food taken),
// and `buildingDestroyed` (written to the defender when a siege pass knocks a level off).
// M3d.1 adds `settle` — written to the sender, carrying either the newly founded
// settlement's id or the reason the founding failed (§13/§15). M3d.3 adds `trade` — written
// to both parties of an accepted offer (§14/§15) — the last of §15's eleven kinds; **every
// report type §15 names now exists.**
export type ReportType =
  | 'scout'
  | 'scoutFailed'
  | 'scoutDetected'
  | 'starvation'
  | 'raid'
  | 'assault'
  | 'defense'
  | 'supportLoss'
  | 'oasisRaid'
  | 'buildingDestroyed'
  | 'settle'
  | 'trade';
const REPORT_TYPES: ReportType[] = [
  'scout',
  'scoutFailed',
  'scoutDetected',
  'starvation',
  'raid',
  'assault',
  'defense',
  'supportLoss',
  'oasisRaid',
  'buildingDestroyed',
  'settle',
  'trade',
];

export const REPORT_TYPE_SCOUT: ReportType = 'scout';
export const REPORT_TYPE_SCOUT_FAILED: ReportType = 'scoutFailed';
export const REPORT_TYPE_SCOUT_DETECTED: ReportType = 'scoutDetected';
export const REPORT_TYPE_STARVATION: ReportType = 'starvation';
export const REPORT_TYPE_RAID: ReportType = 'raid';
export const REPORT_TYPE_ASSAULT: ReportType = 'assault';
export const REPORT_TYPE_DEFENSE: ReportType = 'defense';
export const REPORT_TYPE_SUPPORT_LOSS: ReportType = 'supportLoss';
export const REPORT_TYPE_OASIS_RAID: ReportType = 'oasisRaid';
export const REPORT_TYPE_BUILDING_DESTROYED: ReportType = 'buildingDestroyed';
export const REPORT_TYPE_SETTLE: ReportType = 'settle';
export const REPORT_TYPE_TRADE: ReportType = 'trade';

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
