import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { GRID_MAX, GRID_MIN } from './grid.constants';

// Single value today — farm oases are Food-flavoured only in v1 (M2 §2). Declared as an
// enum (rather than a bare `string`) so M3 can widen it (tiers, other resource flavours)
// with no schema shape change, only a wider enum.
export type OasisType = 'farm';

const OASIS_TYPES: OasisType[] = ['farm'];

// The one type this module ever writes — exported so `WorldService` doesn't hardcode the
// literal at the call site.
export const OASIS_TYPE_FARM: OasisType = 'farm';

// One entry per wildlife unit type in this oasis's live defender roster (§10). Same
// `{unitType, count}` shape as `SettlementTroopEntry` (`settlement.schema.ts`) and
// `MovementUnitEntry` (`movement.schema.ts`), declared locally rather than imported — those
// two files already established this codebase's convention for `_id: false` troop-list
// subdocuments: mirror the shape, don't reach across schema files for the class.
@Schema({ _id: false })
export class OasisDefenderEntry {
  @Prop({ type: String, required: true })
  unitType!: string;

  @Prop({ type: Number, required: true })
  count!: number;
}

const OasisDefenderEntrySchema = SchemaFactory.createForClass(OasisDefenderEntry);

// The oasis's accrued loot pool. Food-only in v1 (§10 draft: regenerates 120/h up to a 4000
// cap) — a subdocument rather than a bare `food: number` field specifically because §10 is
// explicit that this is a v1 scope limit, not a permanent one: a future resource-flavoured
// oasis type can add a sibling key here (e.g. `scrap`) with no field rename and no migration,
// where a bare number would have to be replaced outright.
@Schema({ _id: false })
export class OasisLoot {
  @Prop({ type: Number, required: true, default: 0 })
  food!: number;
}

const OasisLootSchema = SchemaFactory.createForClass(OasisLoot);

export type OasisDocument = HydratedDocument<Oasis>;

// Farm oases: placed once at world generation (`WorldService.bootstrap`), deterministically
// from the world seed via `generateOases` in `game-core` (M2 §2). Inert in M2 — no
// defenders, no loot, no loot regeneration. M3c (§10) adds that live state below, all
// defaulted so every oasis document written by M2's `generateOases` (coordinates + type
// only) stays valid with no migration: Mongoose applies each field's `default` on read for
// any document that predates it, exactly the way `Settlement.awayTroops`/`stationedTroops`
// already do (see that schema's own comment, §19.10). Visible to everyone (§5) — no
// ownership field.
@Schema({ collection: 'oases' })
export class Oasis {
  // Bounded to the grid the same defensive way `Settlement` bounds `x`/`y` (see that
  // schema's comment) — `generateOases` is the only write path today, but the schema
  // enforces the range as defense in depth regardless.
  @Prop({ type: Number, required: true, min: GRID_MIN, max: GRID_MAX })
  x!: number;

  @Prop({ type: Number, required: true, min: GRID_MIN, max: GRID_MAX })
  y!: number;

  @Prop({ type: String, enum: OASIS_TYPES, required: true })
  type!: OasisType;

  // Live defender roster (§10), settled lazily exactly like `SettlementResources` — any
  // command or handler that touches an oasis settles it first. `[]` is the correct value for
  // both "never settled since world generation" (see `lastRegenAt` below) *and* "settled, and
  // every defender died in the last battle before respawning" — the two cases are
  // distinguished by `lastRegenAt`, not by this field, which is why `[]` needs no separate
  // sentinel of its own.
  @Prop({ type: [OasisDefenderEntrySchema], required: true, default: [] })
  defenders!: OasisDefenderEntry[];

  // Accrued Food loot pool (§10), settled lazily up to `config.oasis.loot` cap (draft 4000).
  // See `OasisLoot`'s own comment for why this is a subdocument rather than a bare number.
  @Prop({ type: OasisLootSchema, required: true, default: () => ({ food: 0 }) })
  loot!: OasisLoot;

  // `null` means "never settled since world generation" — `generateOases` (M2 §2) writes
  // nothing but coordinates and `type`, and the `game-core` function that settles an oasis
  // (landing alongside this schema change, not in it — see the M3c brief) materialises it at
  // its full target composition on *first contact* rather than growing it from an empty
  // roster. That first-contact materialisation is exactly what makes `null` a safe default
  // requiring no migration: every oasis written before this field existed reads back as
  // "never settled", which is simply true, and the first command or handler to touch it does
  // the one-time materialisation instead of a background job having to backfill anything.
  @Prop({ type: Number, default: null })
  lastRegenAt!: number | null;

  // A second, independent regen clock — why two timestamps rather than reusing `lastRegenAt`
  // for both: Food accrues *continuously* (this field's sibling advances to `now` on every
  // settle, exactly like `SettlementResources.lastCalcAt`), but defenders regenerate in
  // *discrete* whole units — one of each type per `config.oasis` regen interval (draft 2h,
  // §10). If defender regen shared `lastRegenAt`, an oasis "settled" every few minutes by a
  // passing scout — a routine event, not an edge case — would have its regen clock reset to
  // `now` on every single settle, before a single 2h interval ever elapsed, and its garrison
  // would regenerate never. `lastDefenderRegenAt` instead only ever advances by whole
  // interval-lengths: the settle function computes how many intervals have elapsed since this
  // timestamp, applies that many defender ticks, and advances it by exactly that much,
  // leaving any partial interval to accrue for next time. §10's field list names only
  // `lastRegenAt`; this second field is what actually makes §10's stated "one unit per 2h"
  // mechanic true rather than a race against every scout that wanders past.
  @Prop({ type: Number, default: null })
  lastDefenderRegenAt!: number | null;

  // Optimistic-concurrency guard, same convention as `Settlement.version` / `Movement.version`
  // (see either schema's own comment) — every write that settles or otherwise touches this
  // oasis document goes through a version-guarded update.
  @Prop({ type: Number, required: true, default: 0 })
  version!: number;
}

export const OasisSchema = SchemaFactory.createForClass(Oasis);

// No two oases ever share a tile — the ultimate authority `generateOases`'s own
// minimum-distance rule is checked against, same "unique index as final authority" pattern
// as `Settlement`'s `{x, y}` index.
OasisSchema.index({ x: 1, y: 1 }, { unique: true });
