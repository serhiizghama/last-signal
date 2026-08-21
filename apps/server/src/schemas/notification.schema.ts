import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

// The notification layer's own outbox (M3e.1, `docs/M3_DESIGN_DECISIONS.md` §16, owner
// decision 8): "M3 builds the layer, not the bot." Exactly six kinds ship in M3 — the same
// widenable-union convention `MovementType`/`ReportType` already establish (see either's own
// comment): the *schema* stays permissive enough to store whatever a future kind needs, and
// it is the write sites (§16's trigger table), not this file, that decide which kinds are
// actually ever enqueued today.
export type NotificationKind =
  | 'incomingAttack'
  | 'buildComplete'
  | 'trainingComplete'
  | 'battleReportArrived'
  | 'troopsStarving'
  | 'settlementFounded';
const NOTIFICATION_KINDS: NotificationKind[] = [
  'incomingAttack',
  'buildComplete',
  'trainingComplete',
  'battleReportArrived',
  'troopsStarving',
  'settlementFounded',
];

export const NOTIFICATION_KIND_INCOMING_ATTACK: NotificationKind = 'incomingAttack';
export const NOTIFICATION_KIND_BUILD_COMPLETE: NotificationKind = 'buildComplete';
export const NOTIFICATION_KIND_TRAINING_COMPLETE: NotificationKind = 'trainingComplete';
export const NOTIFICATION_KIND_BATTLE_REPORT_ARRIVED: NotificationKind = 'battleReportArrived';
export const NOTIFICATION_KIND_TROOPS_STARVING: NotificationKind = 'troopsStarving';
export const NOTIFICATION_KIND_SETTLEMENT_FOUNDED: NotificationKind = 'settlementFounded';

export type NotificationDocument = HydratedDocument<Notification>;

// One outbox row per (account, triggering effect) pair — written **in the same transaction**
// as the effect that causes it (§16's whole point: a notification must never exist for an
// effect that rolled back, and must never be lost for one that committed). `NotificationsService
// .enqueue` is the only writer; `NotificationDispatchService` (the drain loop) is the only
// updater, and only ever touches `deliveredAt`/`provider`.
@Schema({
  collection: 'notifications',
  timestamps: { currentTime: () => Date.now() },
  // The app has no optimistic-concurrency need here the way `Settlement`/`Movement` do: a
  // notification row is never read-modified-written by more than one command (it is created
  // once, by the triggering command's own transaction, and later updated exactly once, by the
  // dispatcher, guarded by `deliveredAt: { $exists: false }` in the update filter itself —
  // see `NotificationDispatchService`). `versionKey: false` for the same reason every other
  // schema in this codebase disables Mongoose's own `__v`: this app either needs its own
  // application-controlled `version` field (it doesn't, here) or nothing at all, never
  // Mongoose's implicit one.
  versionKey: false,
})
export class Notification {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Account', required: true, index: true })
  accountId!: Types.ObjectId;

  @Prop({ type: String, enum: NOTIFICATION_KINDS, required: true })
  kind!: NotificationKind;

  // Structured ids + numbers only, never prose — the same M1 §15 convention every report
  // payload already follows. Shape is per-kind; see each enqueue call site (§16's trigger
  // table) for what it actually carries.
  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  payload!: Record<string, unknown>;

  // Which provider(s) actually delivered this row, stamped together with `deliveredAt` by
  // `NotificationDispatchService` in the same write — an array, not a single string, because
  // M3 always drains a row through EVERY registered provider (in-app + the Telegram stub)
  // before marking it delivered at all (see that service's own comment for why "the row",
  // not "the provider", is the idempotency unit). Absent until delivered.
  @Prop({ type: [String] })
  provider?: string[];

  // Absent (not `null`) until the dispatcher successfully drains this row through every
  // registered provider — the same "absent means never happened" convention `Movement.loot`/
  // `arriveEventId` already use. Epoch ms, and — per §18's determinism rule, which applies to
  // every handler, not only combat ones — always `event.dueAt` from the dispatch event that
  // delivered it, never `Date.now()`.
  @Prop({ type: Number })
  deliveredAt?: number;

  @Prop({ type: Number })
  createdAt!: number;

  @Prop({ type: Number })
  updatedAt!: number;
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);

// The dispatcher's own drain query (`NotificationDispatchService`): "undelivered rows, oldest
// first". Partial, exactly like `ReportSchema`'s own unread index (`report.schema.ts`) and for
// the identical reason — the undelivered set is small and ever-shrinking (a healthy dispatcher
// drains it within one tick of it being written), so a partial index covers only the rows that
// query ever actually needs to scan, rather than every notification ever written.
NotificationSchema.index(
  { createdAt: 1 },
  { partialFilterExpression: { deliveredAt: { $exists: false } } },
);
