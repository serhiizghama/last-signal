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
  // Fixed filter value every read/write in `WorldService` matches on
  // (`WORLD_SINGLETON_KEY` in `world/world.constants.ts`) — the same "singleton document,
  // matched by a fixed filter, uniqueness enforced by a unique index" pattern M1b's
  // `PlacementCounter` used before M2a.4's spawn policy made it dead. The unique index below is what
  // makes two concurrent bootstrap attempts (`WorldService.bootstrap`) race-safe: at most
  // one `create` with this value can ever succeed; the loser gets a duplicate-key error
  // (`isDuplicateKeyError`) it treats as "someone else already bootstrapped" rather than a
  // real failure, instead of two world documents silently coexisting.
  @Prop({ type: String, required: true, unique: true })
  key!: string;

  // The world generation seed (M2 §2): both server and client derive terrain
  // deterministically from this via `terrainAt(config, seed, x, y)` in `game-core` — no
  // tile documents are ever stored. Also the seed `generateOases` derives the `oases`
  // collection from at bootstrap time.
  @Prop({ type: String, required: true })
  seed!: string;

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

  // `null` until `NpcSeederService` finishes seeding this world's NPC population (M2a.5,
  // §4), then the epoch ms it did. The idempotency + race-safety guard: seeding is claimed
  // via an atomic conditional update (`findOneAndUpdate({ key, npcsSeededAt: null }, ...)`)
  // on this exact field — the same "conditional update on the singleton document" shape
  // `key`'s own unique index gives `WorldService.createWorld`'s bootstrap race. A fresh
  // document (every `regenerate` call creates one) starts back at `null`, since NPC
  // accounts/settlements from the previous seed are deleted along with it — see
  // `WorldService.regenerate`'s comment.
  @Prop({ type: Number, default: null })
  npcsSeededAt!: number | null;
}

export const WorldSchema = SchemaFactory.createForClass(World);
