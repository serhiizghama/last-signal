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

export type OasisDocument = HydratedDocument<Oasis>;

// Farm oases: placed once at world generation (`WorldService.bootstrap`), deterministically
// from the world seed via `generateOases` in `game-core` (M2 §2). Inert in M2 — no
// defenders, no loot, no loot regeneration — those fields land in M3; this schema
// deliberately carries nothing beyond location and type so M3 can extend it without a
// migration touching what's already here. Visible to everyone (§5) — no ownership field.
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
}

export const OasisSchema = SchemaFactory.createForClass(Oasis);

// No two oases ever share a tile — the ultimate authority `generateOases`'s own
// minimum-distance rule is checked against, same "unique index as final authority" pattern
// as `Settlement`'s `{x, y}` index.
OasisSchema.index({ x: 1, y: 1 }, { unique: true });
