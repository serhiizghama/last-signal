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
//
// **`settle` (M3d.1) and `trade` (M3d.3) have since gained real producers** — recorded here
// rather than rewriting the paragraph above, which is still an accurate account of the
// widening's own reasoning at M3c.2. `settle` is created by `MovementsService.sendMovement`,
// the ordinary send path. `trade` is NOT — see `MovementsService.sendMovement`'s own comment
// on `SENDABLE_MOVEMENT_TYPES` (`movements.util.ts`): a `trade` movement carries `cargo`
// (resources), never `units`, and always comes paired with a sibling leg created in the same
// transaction, which is a shape only `MarketService.acceptOffer`
// (`POST /api/market/offers/:id/accept`) knows how to construct correctly. A player can never
// hand-assemble one through the generic movement endpoint.
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

// What a `trade` movement carries (M3d.3, `docs/M3_DESIGN_DECISIONS.md` §14) — a settlement's
// merchants moving resources by agreement rather than a raid's units taking them by force.
// Same `ResourceAmounts` shape as `MovementLoot` above, and declared locally for the exact
// same reason that class is: this file's own established convention (see `MovementLoot`'s
// comment) is to mirror a subdocument's *shape*, not reach across schema files for the class
// or alias an existing local one. A separate `MovementCargo` class — not a second field typed
// against `MovementLootSchema` — is deliberate even though the shape coincides today: `loot`
// and `cargo` are different concepts that happen to share a shape by coincidence (both are "a
// bundle of the four resources"), the same way `MovementUnitEntry` and
// `SettlementTroopEntry` share a shape without being the same class; aliasing them would make
// a future divergence (e.g. `cargo` growing a field `loot` never needs) an awkward split
// instead of a one-line addition to an already-independent class.
@Schema({ _id: false })
export class MovementCargo implements ResourceAmounts {
  @Prop({ type: Number, required: true, default: 0 })
  scrap!: number;

  @Prop({ type: Number, required: true, default: 0 })
  fuel!: number;

  @Prop({ type: Number, required: true, default: 0 })
  electronics!: number;

  @Prop({ type: Number, required: true, default: 0 })
  food!: number;
}

const MovementCargoSchema = SchemaFactory.createForClass(MovementCargo);

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
  // settlement — see `toOasisId` below. INVARIANT (widened in M3d.1, §13): **at most one** of
  // `toSettlementId`/`toOasisId` is ever set on a given movement document; a `settle`
  // movement sets **neither**, because its target is a bare tile that does not exist as a
  // document yet — there is nothing for either field to reference until
  // `SettleArrivalResolver` either creates the settlement there (on success) or never does
  // (on failure, the convoy simply turns around). `target` (the coordinates, below) is
  // always set regardless of which of the three shapes a movement has, so a report or the
  // client can render "founded (12, -4)" / "raided (12, -4)" without a second lookup either
  // way. Deliberately **not** enforced by a Mongoose validator: this codebase's convention
  // for cross-field invariants on these schemas is a doc comment plus enforcement at the
  // command layer (see e.g. `BuildingSlot`'s "16 slots max ... enforced by the application
  // layer, not the schema") rather than a custom Mongoose validator function, and this
  // at-most-one invariant is exactly the shape that convention already covers — the command
  // layer (`MovementsService.sendMovement`) is the one place that already knows whether it
  // resolved a settlement, an oasis, or a bare tile, so it is also the natural place to
  // guarantee it sets at most one.
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

  // What a `trade` movement is carrying (M3d.3, §14) — absent for every other movement type,
  // exactly like `loot`/`siegeTarget` above ("only ever set when meaningful"). Set once, at
  // creation (`MarketService.acceptOffer`), to the exact `give`/`want` side the accepted offer
  // names — unlike `loot`, which is computed at *arrival* from the battle, a trade's cargo is
  // fixed the instant the two legs are created, since there is no fight to resolve it against.
  //
  // **Delivery timing differs from loot, and that difference is load-bearing for replay
  // safety.** Loot is taken at arrival and credited home on the RETURN leg (`loot` stays set
  // the whole trip). Cargo is the opposite: `TradeArrivalResolver.resolveArrival` credits it
  // into the TARGET the moment the movement arrives (§14 — merchants deliver, they don't loot)
  // and then **clears this field** (`$unset`) in that same write. That clear is what lets
  // `MovementReturnHandler` — which, for every OTHER movement type, only ever *reads* a
  // resource-bearing field — tell "already delivered, nothing more to do" (`cargo` absent)
  // apart from "never delivered, must ride home instead" (`cargo` still present): a cancelled
  // trade leg (§9's 90s window, supported for `trade` — see `TradeArrivalResolver`'s own
  // file comment for why) or `TradeArrivalResolver.resolveMissingTarget`'s "destination gone"
  // edge case both turn the movement around WITHOUT ever reaching `resolveArrival`, so `cargo`
  // is left untouched — present — for `MovementReturnHandler` to credit home on return,
  // clamped to the origin's own storage caps exactly like loot (`creditResourcesClamped`,
  // `movements.util.ts`, shared by both paths so there is only one copy of that arithmetic).
  @Prop({ type: MovementCargoSchema })
  cargo?: ResourceAmounts;

  // How many merchants this leg's round trip occupies (M3d.3, §14) — captured once, at
  // creation, the same reasoning `TrainingQueueItem.unitTrainTimeMs` records for its own
  // "capture the value now, don't recompute it later": a Market level (and so
  // `merchantsFromMarketLevel`) can be retuned or the settlement's Market destroyed by a siege
  // mid-round-trip, and the RETURN leg (`MovementReturnHandler`) must free back exactly the
  // number of merchants this leg actually tied up at acceptance, not whatever the config or
  // the settlement's current Market level would say today. Absent for every non-`trade`
  // movement — merchants are not units and never march with `units` above.
  @Prop({ type: Number })
  merchants?: number;

  // The originating `TradeOffer`'s id (M3d.3, §14) — set only on the two `trade` movements one
  // accepted offer spawns (`MarketService.acceptOffer`). Exists for one reason: §15 gives
  // `trade` reports to "both parties", exactly one each — not one per leg-event — but the two
  // facts that make up that one report ("resources delivered", known at ONE leg's ARRIVAL, and
  // "merchants freed", known at the OTHER leg's own RETURN) live on two different `Movement`
  // documents with no other field in common, and §14's faction-flavoured merchant speeds mean
  // neither event is guaranteed to happen before the other. `payload.tradeOfferId` is the
  // shared key `TradeArrivalResolver`/`MovementReturnHandler` upsert the SAME report document
  // against, whichever of the two reaches it first — see `TradeArrivalResolver`'s own comment
  // for the full reasoning, including why an upsert (not this codebase's usual single-writer
  // `.create()`) is the one appropriate exception here: unlike every other report in this
  // codebase, this is the only one with two independent writers whose relative order the game
  // rules do not fix.
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'TradeOffer' })
  tradeOfferId?: Types.ObjectId;

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
