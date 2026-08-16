import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

export type EventStatus = 'due' | 'processing' | 'done' | 'failed';

const EVENT_STATUSES: EventStatus[] = ['due', 'processing', 'done', 'failed'];

export type GameEventDocument = HydratedDocument<GameEvent>;

// Named `GameEvent` rather than `Event` to avoid shadowing the ambient DOM
// `Event` global; the Mongo collection itself is still `events`. This is the
// scheduler's backbone — schema only here, the worker that claims and
// processes these is a later step.
@Schema({
  collection: 'events',
  timestamps: { currentTime: () => Date.now() },
})
export class GameEvent {
  @Prop({ type: String, required: true })
  type!: string;

  @Prop({ type: Number, required: true })
  dueAt!: number;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true, default: {} })
  payload!: Record<string, unknown>;

  // Bumped on breaking payload-shape changes so a deploy never chokes on
  // events that were already in flight under the old shape.
  @Prop({ type: Number, required: true, default: 1 })
  payloadVersion!: number;

  @Prop({ type: String, enum: EVENT_STATUSES, required: true, default: 'due' })
  status!: EventStatus;

  // Lease timestamp for stuck-event recovery; set when a worker claims the
  // event, cleared (or the doc moves to `done`/`failed`) once it finishes.
  @Prop({ type: Number })
  processingStartedAt?: number;

  @Prop({ type: Number, required: true, default: 0 })
  attempts!: number;

  @Prop({ type: String })
  lastError?: string;

  @Prop({ type: Number })
  createdAt!: number;

  @Prop({ type: Number })
  updatedAt!: number;
}

export const GameEventSchema = SchemaFactory.createForClass(GameEvent);

// The claim query: "give me the next due, not-yet-claimed event".
GameEventSchema.index({ status: 1, dueAt: 1 });
// The stuck-event sweep: "find events leased for too long".
GameEventSchema.index({ status: 1, processingStartedAt: 1 });
