import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

export type SessionDocument = HydratedDocument<Session>;

// Server-side session record backing the httpOnly cookie (§13 of the M1 design record: no
// JWT — sessions live in Mongo precisely so they're trivially revocable by deleting this
// document).
@Schema({
  collection: 'sessions',
  timestamps: { currentTime: () => Date.now() },
})
export class Session {
  // Opaque random token (`node:crypto` `randomBytes`, hex-encoded) — the exact value the
  // httpOnly cookie carries. Unique + the lookup key on every authenticated request.
  @Prop({ type: String, required: true, unique: true })
  sessionId!: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Account', required: true, index: true })
  accountId!: Types.ObjectId;

  // Deliberately a genuine BSON `Date`, unlike every other ms-numeric timestamp in this
  // codebase (see the Account/Settlement schema comments on why those are `Number`):
  // MongoDB's TTL monitor only ever sweeps `Date`-typed fields, and a TTL index on this
  // field is how the collection self-expires (see the index below) rather than needing a
  // manual sweep job.
  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  // Updated (best-effort, not transactional) on every request the session authenticates —
  // purely informational, nothing in the auth flow depends on it being exactly current.
  @Prop({ type: Number, required: true })
  lastSeenAt!: number;

  @Prop({ type: Number })
  createdAt!: number;

  @Prop({ type: Number })
  updatedAt!: number;
}

export const SessionSchema = SchemaFactory.createForClass(Session);

// `expireAfterSeconds: 0` means "expire exactly at the stored `expiresAt` instant" — the
// TTL monitor deletes the document once its own sweep (which runs roughly every 60s, not
// instantly) gets to it. That lag is fine for "stop accepting this cookie eventually"; it
// is NOT what makes revocation immediate — `AuthService.logout` and any explicit deletion
// of this document take effect the moment the delete commits, well before the TTL sweep
// would ever run.
SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
