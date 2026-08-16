import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PlacementCounterDocument = HydratedDocument<PlacementCounter>;

// A single monotonically-increasing counter, atomically bumped via `$inc`, that seeds
// `PlacementService`'s deterministic outer-ring stride walk (see `placement.geometry.ts`).
// Exactly one document ever lives in this collection per `key` — in practice just one,
// `PLACEMENT_COUNTER_KEY` — the same "singleton document, matched by a fixed filter"
// pattern as `World`, but kept in its own collection rather than folded into `World`
// (round/world lifecycle isn't wired up yet, and this counter's only job is placement).
@Schema({ collection: 'placementCounters' })
export class PlacementCounter {
  @Prop({ type: String, required: true, unique: true })
  key!: string;

  @Prop({ type: Number, required: true, default: 0 })
  value!: number;
}

export const PlacementCounterSchema = SchemaFactory.createForClass(PlacementCounter);
