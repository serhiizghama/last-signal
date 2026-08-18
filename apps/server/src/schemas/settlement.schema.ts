import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

import { GRID_MAX, GRID_MIN } from './grid.constants';

export interface ResourceAmounts {
  scrap: number;
  fuel: number;
  electronics: number;
  food: number;
}

// Resource values are floats, not integers (production accrues fractionally
// between event ticks) — every `Number` prop below stores as-is, no rounding.
@Schema({ _id: false })
export class ResourceAmountsValue implements ResourceAmounts {
  @Prop({ type: Number, required: true, default: 0 })
  scrap!: number;

  @Prop({ type: Number, required: true, default: 0 })
  fuel!: number;

  @Prop({ type: Number, required: true, default: 0 })
  electronics!: number;

  @Prop({ type: Number, required: true, default: 0 })
  food!: number;
}

const ResourceAmountsSchema = SchemaFactory.createForClass(ResourceAmountsValue);

// One entry per building slot. `id` is the application-assigned identifier
// for this building instance — deliberately not Mongo's `_id` (`_id: false`
// below), since these are addressed by the game logic, not by Mongo.
@Schema({ _id: false })
export class BuildingSlot {
  @Prop({ type: String, required: true })
  id!: string;

  @Prop({ type: String, required: true })
  type!: string;

  @Prop({ type: Number, required: true })
  level!: number;

  @Prop({ type: Number, required: true })
  slot!: number;
}

const BuildingSlotSchema = SchemaFactory.createForClass(BuildingSlot);

@Schema({ _id: false })
export class SettlementResources {
  @Prop({ type: ResourceAmountsSchema, required: true, default: () => ({}) })
  values!: ResourceAmounts;

  @Prop({ type: Number, required: true, default: 0 })
  lastCalcAt!: number;
}

const SettlementResourcesSchema = SchemaFactory.createForClass(SettlementResources);

@Schema({ _id: false })
export class BuildQueueItem {
  @Prop({ type: String, required: true })
  id!: string;

  @Prop({ type: String, required: true })
  type!: string;

  @Prop({ type: Number, required: true })
  targetLevel!: number;

  @Prop({ type: ResourceAmountsSchema, required: true })
  cost!: ResourceAmounts;

  @Prop({ type: Number, required: true })
  enqueuedAt!: number;

  @Prop({ type: Number, default: null })
  startedAt!: number | null;

  @Prop({ type: Number, default: null })
  completesAt!: number | null;

  // Set once the scheduler has enqueued the matching `buildComplete` event.
  @Prop({ type: MongooseSchema.Types.ObjectId })
  eventId?: Types.ObjectId;
}

const BuildQueueItemSchema = SchemaFactory.createForClass(BuildQueueItem);

// One entry per unit type present in the settlement's home garrison (M2 §6 schema note).
// Stationing (troops away from home, at another settlement) is M3 — every entry here is
// simply "at home". `_id: false` and explicit `@Prop` types, same shape as `BuildingSlot`
// above; `unitType` is a plain `string` for the same reason `BuildingSlot.type` is (see
// `settlements.util.ts`'s `isBuildingType` narrowing pattern — a `isUnitType` equivalent
// narrows this the same way once a command reads it, e.g. M2b's `sendMovement`).
@Schema({ _id: false })
export class SettlementTroopEntry {
  @Prop({ type: String, required: true })
  unitType!: string;

  @Prop({ type: Number, required: true })
  count!: number;
}

const SettlementTroopEntrySchema = SchemaFactory.createForClass(SettlementTroopEntry);

// A foreign contingent stationed here as support (M3 §3/§8, `docs/M3_DESIGN_DECISIONS.md`).
// `_id: false` and explicit `@Prop`s, same convention as every other subdocument on this
// schema. Nothing writes this array until the `support` movement ships in M3c — this step
// (M3a.4) only adds the field and reads it for upkeep (`upkeepTroopsOf`,
// `settlements.util.ts`), so `stationedTroops` is `[]` for every settlement today. The owner
// (`ownerAccountId`) and origin (`fromSettlementId`) tags exist for two reasons that both
// postdate this step: §8's recall/evict commands need to know who to send units back to and
// where, and a starvation/battle loss report (§15) needs to be addressed to the right
// supporter rather than the host.
@Schema({ _id: false })
export class StationedContingent {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Account', required: true })
  ownerAccountId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Settlement', required: true })
  fromSettlementId!: Types.ObjectId;

  @Prop({ type: [SettlementTroopEntrySchema], required: true, default: [] })
  troops!: SettlementTroopEntry[];
}

const StationedContingentSchema = SchemaFactory.createForClass(StationedContingent);

// One active scout-training order (M2b.2, `docs/M2_DESIGN_DECISIONS.md` §7). Shape mirrors
// `BuildQueueItem` above — `_id: false`, explicit `@Prop` types — but tracks a *batch*
// delivered one unit at a time via chained `trainingComplete` events rather than a single
// level flip: `totalCount`/`remainingCount` let the client render "next unit in MM:SS, N of
// M remaining", and `remainingCount` doubles as the idempotency guard the completion
// handler checks against the event payload's own copy of it (see
// `TrainingCompleteHandler`'s class comment) — a replay that finds `remainingCount` already
// advanced past what the event expects is a no-op.
@Schema({ _id: false })
export class TrainingQueueItem {
  @Prop({ type: String, required: true })
  id!: string;

  @Prop({ type: String, required: true })
  unitType!: string;

  @Prop({ type: Number, required: true })
  totalCount!: number;

  @Prop({ type: Number, required: true })
  remainingCount!: number;

  // Per-unit training time (ms), `calcTrainTimeMs`'s result captured at enqueue time — the
  // completion handler advances `event.dueAt` by this fixed amount to schedule the next
  // unit rather than re-deriving it from `GameConfig` on every chained event, so a config
  // retune mid-round can't change the timing of an order already in flight.
  @Prop({ type: Number, required: true })
  unitTrainTimeMs!: number;

  @Prop({ type: Number, required: true })
  startedAt!: number;

  // When the next unit is credited — the client's "next unit in MM:SS" countdown target.
  @Prop({ type: Number, required: true })
  nextCompletesAt!: number;

  @Prop({ type: ResourceAmountsSchema, required: true })
  cost!: ResourceAmounts;

  // Set once the scheduler has enqueued the matching `trainingComplete` event for the next
  // unit in this order.
  @Prop({ type: MongooseSchema.Types.ObjectId })
  eventId?: Types.ObjectId;
}

const TrainingQueueItemSchema = SchemaFactory.createForClass(TrainingQueueItem);

export type SettlementDocument = HydratedDocument<Settlement>;

@Schema({
  collection: 'settlements',
  timestamps: { currentTime: () => Date.now() },
  // The app owns its own optimistic-concurrency `version` field below;
  // disabling Mongoose's `__v` avoids ever confusing the two.
  versionKey: false,
})
export class Settlement {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Account', required: true, index: true })
  accountId!: Types.ObjectId;

  @Prop({ type: String, required: true })
  name!: string;

  // Bounded to the 61×61 grid (see `grid.constants.ts`) — application-layer placement
  // (`PlacementService`) is what actually chooses these, but the schema enforces the range
  // as defense in depth against any future write path that isn't it.
  @Prop({ type: Number, required: true, min: GRID_MIN, max: GRID_MAX })
  x!: number;

  @Prop({ type: Number, required: true, min: GRID_MIN, max: GRID_MAX })
  y!: number;

  // 16 slots max, one building instance per type in v1 — enforced by the
  // application layer, not the schema.
  @Prop({ type: [BuildingSlotSchema], required: true, default: [] })
  buildings!: BuildingSlot[];

  @Prop({ type: SettlementResourcesSchema, required: true, default: () => ({}) })
  resources!: SettlementResources;

  @Prop({ type: [BuildQueueItemSchema], required: true, default: [] })
  buildQueue!: BuildQueueItem[];

  // Home troops (M2 §6 schema note). `[]` for every settlement created through the normal
  // human flow today (`SettlementsService.createSettlement` never writes it — M2b's
  // `trainUnits`/movement handlers are the first real writers); NPC settlements are the
  // one exception, written directly by `NpcSeederService` at world genesis (M2a.5, §4:
  // "world genesis is god-mode by definition").
  @Prop({ type: [SettlementTroopEntrySchema], required: true, default: [] })
  troops!: SettlementTroopEntry[];

  // Own units currently in transit — any movement, any leg, outbound or returning (M3 §3).
  // This is a **denormalized counter**, not a derived view: its entire purpose is keeping
  // Food upkeep a pure function of ONE settlement document (`upkeepTroopsOf` unions this with
  // `troops` and `stationedTroops` below at every upkeep call site), so a command never has to
  // cross-read every in-flight `Movement` document just to know what its own settlement owes
  // in Food. It is maintained inside the SAME transaction as every send / arrive / return
  // (`MovementsService.sendMovement`, `MovementArriveHandler`, `MovementReturnHandler`) —
  // units move `troops → awayTroops` at send, back to `troops` on return, and losses are
  // removed from `awayTroops` the instant they die rather than waiting for the return leg.
  // Letting this drift from what the in-flight movements actually hold would silently
  // re-open the exact exploit this field exists to close: before M3a.4, upkeep was computed
  // from `troops` alone, so marching an army out made its Food cost vanish
  // (`docs/M3_DESIGN_DECISIONS.md` §3, §19.1). `[]` for every settlement created before this
  // field existed — no migration needed, Mongoose applies `default: []` on read (§19.10).
  @Prop({ type: [SettlementTroopEntrySchema], required: true, default: [] })
  awayTroops!: SettlementTroopEntry[];

  // Foreign units stationed here as support, one entry per supporting contingent (M3 §3/§8).
  // The host settlement pays this Food (owner decision 6) — see `upkeepTroopsOf`. Nothing
  // writes this array yet: the `support` movement that populates it is M3c. `[]` for every
  // settlement today, including ones created before this field existed (no migration needed,
  // same as `awayTroops` above, §19.10).
  @Prop({ type: [StationedContingentSchema], required: true, default: [] })
  stationedTroops!: StationedContingent[];

  // Active training orders (M2b.2, §7; generalized to the full roster in M3a.5, §2). At
  // most `MAX_ACTIVE_ORDERS_PER_BUILDING` (1) entries *per training building* at a time,
  // three buildings wide — an array, not a single optional field, so this widened the same
  // way `buildQueue` already supports more than one item: no schema migration needed.
  @Prop({ type: [TrainingQueueItemSchema], required: true, default: [] })
  trainingQueue!: TrainingQueueItem[];

  // The `dueAt` of the most recently *applied* `starvationTick` (M3a.6,
  // `docs/M3_DESIGN_DECISIONS.md` §4) — `StarvationTickHandler`'s idempotency guard: a
  // replay of the same event (identical `event.dueAt`) finds this already stamped
  // `>= event.dueAt` and no-ops before touching anything else. `null` until this
  // settlement's first starvation tick ever applies (no migration needed, same convention
  // as `awayTroops`/`stationedTroops` above).
  @Prop({ type: Number, default: null })
  lastStarvationTickAt!: number | null;

  // The currently scheduled `starvationTick` event for this settlement, or `null` when net
  // Food is >= 0 (nothing pending). Mirrors `BuildQueueItem.eventId`/
  // `TrainingQueueItem.eventId`'s role: lets `SettlementsService`'s lazy-scheduling choke
  // point (`settleDoc`, M3a.6 §4) cancel-and-reschedule a moved deadline instead of
  // enqueuing a duplicate tick on every command that happens to settle a starving
  // settlement.
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null })
  pendingStarvationEventId!: Types.ObjectId | null;

  // The `dueAt` `pendingStarvationEventId` was last scheduled for — carried alongside the id
  // so `settleDoc` can tell "the deadline moved" from "unchanged, don't reschedule" without a
  // second read of the `events` collection on every command that touches this settlement.
  @Prop({ type: Number, default: null })
  pendingStarvationDueAt!: number | null;

  // Optimistic-concurrency guard: incremented by every command that mutates
  // this document (see docs/M1_DESIGN_DECISIONS.md, "Concurrency playbook").
  @Prop({ type: Number, required: true, default: 0 })
  version!: number;

  @Prop({ type: Number })
  createdAt!: number;

  @Prop({ type: Number })
  updatedAt!: number;
}

export const SettlementSchema = SchemaFactory.createForClass(Settlement);

// Two settlements can never share a tile.
SettlementSchema.index({ x: 1, y: 1 }, { unique: true });
