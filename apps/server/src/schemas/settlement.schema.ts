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
