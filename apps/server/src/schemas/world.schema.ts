import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type WorldSide = 'beacon' | 'silence';

const WORLD_SIDES: WorldSide[] = ['beacon', 'silence'];

@Schema({ _id: false })
export class SourceAccumulated {
  @Prop({ type: Number, required: true, default: 0 })
  beacon!: number;

  @Prop({ type: Number, required: true, default: 0 })
  silence!: number;
}

const SourceAccumulatedSchema = SchemaFactory.createForClass(SourceAccumulated);

@Schema({ _id: false })
export class SourceState {
  @Prop({ type: String, enum: WORLD_SIDES, default: null })
  holderSide!: WorldSide | null;

  @Prop({ type: Number, default: null })
  holderSince!: number | null;

  @Prop({ type: SourceAccumulatedSchema, required: true, default: () => ({}) })
  accumulated!: SourceAccumulated;
}

const SourceStateSchema = SchemaFactory.createForClass(SourceState);

@Schema({ _id: false })
export class TimelineEntry {
  @Prop({ type: Number, required: true })
  at!: number;

  @Prop({ type: String, required: true })
  kind!: string;
}

const TimelineEntrySchema = SchemaFactory.createForClass(TimelineEntry);

export type WorldDocument = HydratedDocument<World>;

// Singleton: exactly one document ever lives in the `world` collection.
// Explicit `collection: 'world'` because Mongoose would otherwise pluralize
// the class name to `worlds`.
@Schema({ collection: 'world' })
export class World {
  @Prop({ type: Number, required: true })
  roundNumber!: number;

  // 1..3.
  @Prop({ type: Number, required: true })
  act!: number;

  @Prop({ type: Number, required: true })
  startedAt!: number;

  @Prop({ type: SourceStateSchema, required: true, default: () => ({}) })
  source!: SourceState;

  @Prop({ type: [TimelineEntrySchema], required: true, default: [] })
  timeline!: TimelineEntry[];
}

export const WorldSchema = SchemaFactory.createForClass(World);
