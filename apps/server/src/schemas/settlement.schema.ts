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
  // `trainScouts`/movement handlers are the first real writers); NPC settlements are the
  // one exception, written directly by `NpcSeederService` at world genesis (M2a.5, §4:
  // "world genesis is god-mode by definition").
  @Prop({ type: [SettlementTroopEntrySchema], required: true, default: [] })
  troops!: SettlementTroopEntry[];

  // Active scout-training orders (M2b.2, §7). At most `MAX_ACTIVE_TRAINING_ORDERS` (1 in
  // M2, `settlements.constants.ts`) entries at a time — an array, not a single optional
  // field, so M3 (the remaining 12 units, deeper queues) can widen the cap without a schema
  // migration, the same way `buildQueue` already supports more than one item.
  @Prop({ type: [TrainingQueueItemSchema], required: true, default: [] })
  trainingQueue!: TrainingQueueItem[];

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
