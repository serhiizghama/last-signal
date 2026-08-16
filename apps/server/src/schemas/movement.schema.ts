import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

import { GRID_MAX, GRID_MIN } from './grid.constants';

// M2 ships exactly one movement type (`docs/M2_DESIGN_DECISIONS.md` §6) — `settle`,
// `trade`/merchants and `support` are M3. A union (not a hardcoded literal on the schema) so
// M3 widens this array rather than changing the field's shape.
export type MovementType = 'scout';
const MOVEMENT_TYPES: MovementType[] = ['scout'];
export const MOVEMENT_TYPE_SCOUT: MovementType = 'scout';

export type MovementStatus = 'outbound' | 'returning' | 'done' | 'cancelled';
const MOVEMENT_STATUSES: MovementStatus[] = ['outbound', 'returning', 'done', 'cancelled'];

// The target's coordinates at send time, bounded the same defensive way `Settlement.x`/`y`
// are (see that schema's comment) — kept alongside `toSettlementId` so a report/the client
// can show "scouted (12, -4)" without a second settlement lookup.
@Schema({ _id: false })
export class MovementTarget {
  @Prop({ type: Number, required: true, min: GRID_MIN, max: GRID_MAX })
  x!: number;

  @Prop({ type: Number, required: true, min: GRID_MIN, max: GRID_MAX })
  y!: number;
}

const MovementTargetSchema = SchemaFactory.createForClass(MovementTarget);

// One entry per unit type in a marching army — same shape as `SettlementTroopEntry`
// (`settlement.schema.ts`), `_id: false`, explicit `@Prop` types.
@Schema({ _id: false })
export class MovementUnitEntry {
  @Prop({ type: String, required: true })
  unitType!: string;

  @Prop({ type: Number, required: true })
  count!: number;
}

const MovementUnitEntrySchema = SchemaFactory.createForClass(MovementUnitEntry);

export type MovementDocument = HydratedDocument<Movement>;

@Schema({
  collection: 'movements',
  timestamps: { currentTime: () => Date.now() },
  // The app owns its own optimistic-concurrency `version` field below, same convention as
  // `Settlement` — see that schema's own comment on why `__v` stays disabled.
  versionKey: false,
})
export class Movement {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Account', required: true, index: true })
  ownerAccountId!: Types.ObjectId;

  @Prop({ type: String, enum: MOVEMENT_TYPES, required: true })
  type!: MovementType;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Settlement', required: true })
  fromSettlementId!: Types.ObjectId;

  // The target settlement's id, resolved once at send time (M2b.3): arrival resolution reads
  // *this* settlement by id rather than re-resolving `target` by coordinate — settlements
  // never move or change hands in v1, so the two can never disagree, and an id lookup is a
  // single indexed `findById` instead of a coordinate scan.
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Settlement', required: true })
  toSettlementId!: Types.ObjectId;

  @Prop({ type: MovementTargetSchema, required: true })
  target!: MovementTarget;

  // The army that departed — fixed at send time, never mutated afterward. `survivors` below
  // is the live/resolved figure; keeping both lets a report or the client show "sent 10, lost
  // 6" rather than only ever seeing the post-combat number.
  @Prop({ type: [MovementUnitEntrySchema], required: true })
  units!: MovementUnitEntry[];

  // Meaningless (and left `[]`) while `status` is still `outbound`. Populated the moment the
  // movement leaves `outbound`: cancelling sets it equal to `units` (nothing died — the
  // scouts never engaged), arrival sets it to the resolved combat survivors.
  @Prop({ type: [MovementUnitEntrySchema], required: true, default: [] })
  survivors!: MovementUnitEntry[];

  @Prop({ type: Number, required: true })
  departAt!: number;

  @Prop({ type: Number, required: true })
  arriveAt!: number;

  // Set once the movement flips to `returning` (by cancel or by arrival); `null` before then.
  @Prop({ type: Number, default: null })
  returnAt!: number | null;

  @Prop({ type: String, enum: MOVEMENT_STATUSES, required: true, default: 'outbound' })
  status!: MovementStatus;

  // The scheduled `movementArrive` event's id, so cancelling can delete the right one
  // (`EventSchedulerService.cancelEvent`). Never read again once the movement leaves
  // `outbound` — there is no cancel path for the return leg in M2.
  @Prop({ type: MongooseSchema.Types.ObjectId })
  arriveEventId?: Types.ObjectId;

  // The scheduled `movementReturn` event's id, set once the movement flips to `returning`.
  @Prop({ type: MongooseSchema.Types.ObjectId })
  returnEventId?: Types.ObjectId;

  // Optimistic-concurrency guard, same convention as `Settlement.version` (see the
  // concurrency playbook, `docs/CONCURRENCY_PLAYBOOK.md`): every mutating write to this
  // document — send (creation, implicitly version 0), cancel, arrive, return — goes through a
  // version-guarded `findOneAndUpdate`. This is what keeps a racing cancel and a racing
  // arrival from double-applying: whichever commits first wins, the loser's write matches no
  // document and either retries (cancel, via `MovementsService.runCommand`) or gets picked up
  // by the scheduler's own retry/backoff (a handler's version conflict).
  @Prop({ type: Number, required: true, default: 0 })
  version!: number;

  @Prop({ type: Number })
  createdAt!: number;

  @Prop({ type: Number })
  updatedAt!: number;
}

export const MovementSchema = SchemaFactory.createForClass(Movement);

// The read pattern every caller needs (M2 §6 schema note): "this account's own movements,
// optionally filtered to a status" — `MovementsService.listMine`, `.cancelMovement`'s
// ownership check, and the scheduler-facing lookups all filter on exactly this pair.
MovementSchema.index({ ownerAccountId: 1, status: 1 });
