import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

export type ChangeStreamResumeTokenDocument = HydratedDocument<ChangeStreamResumeToken>;

// Durable storage for a change-stream supervisor's own resume position (M3e.1,
// `docs/M3_DESIGN_DECISIONS.md` §16/§19.9) — one row per named stream, matched by
// `streamName` the same "singleton document, matched by a fixed filter" shape `World.key`
// already establishes (see that schema's own comment), rather than a custom string `_id`:
// keeping every schema in this codebase on Mongo's own auto `_id` avoids a second convention
// for "how a document is addressed" existing side by side with the first.
//
// `token` is opaque — the MongoDB driver's own `ResumeToken` shape (`{ _data: string }` in
// practice, but never relied on beyond "pass it back to `.watch()` as `resumeAfter`"), so it
// is stored as `Mixed` rather than modelled field-by-field, the same way `GameEvent.payload`
// and `Report.payload` are.
@Schema({
  collection: 'changeStreamResumeTokens',
  timestamps: { currentTime: () => Date.now() },
  versionKey: false,
})
export class ChangeStreamResumeToken {
  @Prop({ type: String, required: true, unique: true })
  streamName!: string;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  token!: Record<string, unknown>;

  @Prop({ type: Number })
  createdAt!: number;

  @Prop({ type: Number })
  updatedAt!: number;
}

export const ChangeStreamResumeTokenSchema = SchemaFactory.createForClass(ChangeStreamResumeToken);
