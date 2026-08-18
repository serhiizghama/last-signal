import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

import { GRID_MAX, GRID_MIN } from './grid.constants';
import type { ResourceAmounts } from './settlement.schema';

// M2 shipped exactly one movement type (`scout`). M3 widens the union to the full six the
// plan always intended (`docs/M3_DESIGN_DECISIONS.md` §9): `raid`, `assault`, `support`,
// `settle`, `trade`. This was the whole point of a union rather than a hardcoded literal on
// the schema (M2's own comment on this field said so). Widening the *schema* enum here does
// not make any of the new five sendable today — `settle`/`trade` have no send path until
// M3d, and even `raid`/`assault`/`support` (M3c) only become reachable once their own
// command services exist. It is the command layer, not this schema, that gates which types
// a player can actually produce; the schema only needs to be permissive enough to store
// whatever the command layer is willing to write, which is why every type lands in one pass
// instead of being widened six times.
export type MovementType = 'scout' | 'raid' | 'assault' | 'support' | 'settle' | 'trade';
const MOVEMENT_TYPES: MovementType[] = ['scout', 'raid', 'assault', 'support', 'settle', 'trade'];
export const MOVEMENT_TYPE_SCOUT: MovementType = 'scout';
export const MOVEMENT_TYPE_RAID: MovementType = 'raid';
export const MOVEMENT_TYPE_ASSAULT: MovementType = 'assault';
export const MOVEMENT_TYPE_SUPPORT: MovementType = 'support';
export const MOVEMENT_TYPE_SETTLE: MovementType = 'settle';
export const MOVEMENT_TYPE_TRADE: MovementType = 'trade';

export type MovementStatus = 'outbound' | 'returning' | 'done' | 'cancelled';
const MOVEMENT_STATUSES: MovementStatus[] = ['outbound', 'returning', 'done', 'cancelled'];

// The target's coordinates at send time, bounded the same defensive way `Settlement.x`/`y`
// are (see that schema's comment) — kept alongside `toSettlementId`/`toOasisId` so a
// report/the client can show "scouted (12, -4)" without a second settlement-or-oasis lookup,
// regardless of which of the two the movement actually resolved to.
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

// What a raid/assault carries home (§6) — same shape as `ResourceAmountsValue`
// (`settlement.schema.ts`), declared locally rather than imported: this file already
// established its own convention of mirroring a settlement subdocument's *shape* rather than
// reaching across schema files for the class (see `MovementUnitEntry` above, which mirrors
// `SettlementTroopEntry` the same way), so this keeps that convention consistent within one
// file. Only the `ResourceAmounts` *type* is imported, for the field's TS shape below — no
// runtime coupling to `settlement.schema.ts`.
@Schema({ _id: false })
export class MovementLoot implements ResourceAmounts {
  @Prop({ type: Number, required: true, default: 0 })
  scrap!: number;

  @Prop({ type: Number, required: true, default: 0 })
  fuel!: number;

  @Prop({ type: Number, required: true, default: 0 })
  electronics!: number;

  @Prop({ type: Number, required: true, default: 0 })
  food!: number;
}

const MovementLootSchema = SchemaFactory.createForClass(MovementLoot);

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
  //
  // Optional as of M3c (§9): a `raid` or `scout` can now target a farm oasis instead of a
  // settlement — see `toOasisId` below. INVARIANT: exactly one of `toSettlementId` /
  // `toOasisId` is ever set on a given movement document; `target` (the coordinates, below)
  // is always set regardless of which one, so a report or the client can render "raided
  // (12, -4)" without a second lookup either way. Deliberately **not** enforced by a
  // Mongoose validator: this codebase's convention for cross-field invariants on these
  // schemas is a doc comment plus enforcement at the command layer (see e.g. `BuildingSlot`'s
  // "16 slots max ... enforced by the application layer, not the schema") rather than a
  // custom Mongoose validator function, and a same-document xor is exactly the shape that
  // convention already covers — the command layer (`MovementsService`'s send commands) is the
  // one place that already knows whether it resolved a settlement or an oasis, so it is also
  // the natural place to guarantee it sets exactly one.
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Settlement' })
  toSettlementId?: Types.ObjectId;

  // The target oasis's id (M3c, `docs/M3_DESIGN_DECISIONS.md` §10) — set instead of
  // `toSettlementId` when a `raid` or `scout` targets a farm oasis. See the invariant comment
  // on `toSettlementId` above.
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Oasis' })
  toOasisId?: Types.ObjectId;

  @Prop({ type: MovementTargetSchema, required: true })
  target!: MovementTarget;

  // The army that departed — fixed at send time, never mutated afterward. `survivors` below
  // is the live/resolved figure; keeping both lets a report or the client show "sent 10, lost
  // 6" rather than only ever seeing the post-combat number.
  @Prop({ type: [MovementUnitEntrySchema], required: true })
  units!: MovementUnitEntry[];

  // The building type (or the literal `'wall'`) an assault's siege units are ordered against
  // (§7) — set only on a `type === 'assault'` movement whose army includes siege units, and
  // read only by the siege pass at arrival; absent on every other movement. Plain `string`,
  // narrowed at read time exactly the way `SettlementTroopEntry.unitType` and
  // `BuildingSlot.type` already are (see either's own comment for why: the real, narrower
  // type lives in a `isXxx` narrowing helper at the read site, not on the schema).
  @Prop({ type: String })
  siegeTarget?: string;

  // Meaningless (and left `[]`) while `status` is still `outbound`. Populated the moment the
  // movement leaves `outbound`: cancelling sets it equal to `units` (nothing died — the
  // scouts never engaged), arrival sets it to the resolved combat survivors.
  @Prop({ type: [MovementUnitEntrySchema], required: true, default: [] })
  survivors!: MovementUnitEntry[];

  // What this raid/assault is carrying home (§6). Absent (`undefined`) for every movement
  // that never resolves a battle (scouts, `support`, and every movement created before this
  // field existed — no migration needed, same "absent reads back as never-set" convention as
  // `arriveEventId`/`returnEventId` below), and for a raid/assault right up until arrival:
  // it is computed once, at arrival, from the defender's *settled* resources and the
  // attacker's surviving carry capacity, then credited to the attacker's home settlement on
  // the **return** leg (not at arrival) — the return handler is what clamps it to storage
  // caps, since loot that would overflow the cap by the time the army gets home is lost, not
  // wasted retroactively (M1 §5's rule, extended here).
  @Prop({ type: MovementLootSchema })
  loot?: ResourceAmounts;

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
