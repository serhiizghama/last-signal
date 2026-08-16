import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

export type Faction = 'raiders' | 'engineers' | 'nomads';
export type Side = 'beacon' | 'silence';

// Exported (not module-local) so `AccountsService` validates registration input against
// this exact list rather than a second, independently-drifting copy of the literals.
export const FACTIONS: Faction[] = ['raiders', 'engineers', 'nomads'];
export const SIDES: Side[] = ['beacon', 'silence'];

export type AccountDocument = HydratedDocument<Account>;

@Schema({
  collection: 'accounts',
  // `createdAt`/`updatedAt` below are explicitly typed `Number` (epoch ms),
  // so `currentTime` must return a number too — the whole codebase is
  // ms-based and mixing in `Date` here would reintroduce that drift.
  timestamps: { currentTime: () => Date.now() },
})
export class Account {
  // Cross-round player identity, present only for Telegram-linked accounts.
  // `sparse` so the many guest accounts (no tgId at all) never collide on
  // the unique index — only documents that actually set the field do.
  @Prop({ type: String, unique: true, sparse: true })
  tgId?: string;

  // Unique across every account (guest or registered) — see `AccountsService.register`'s
  // comment for why guest accounts get a random-suffixed placeholder name instead of a
  // fixed default, so this index can never spuriously reject two guests colliding.
  @Prop({ type: String, required: true, unique: true })
  name!: string;

  @Prop({ type: Boolean, required: true, default: true })
  isGuest!: boolean;

  // True for the ~135 inert accounts `NpcSeederService` creates at world start (M2a.5,
  // `docs/M2_DESIGN_DECISIONS.md` §4) — never set by any human-facing path. Exists so the
  // seeder can tell "already seeded" apart from "not yet" without a second collection, and
  // so M4's behaviour engine knows which accounts to tick. Deliberately excluded from
  // `AccountView`/every other client-facing shape (see that view's own comment) — an NPC
  // must be indistinguishable from a human in the game, so this field must never reach a
  // response body.
  @Prop({ type: Boolean, required: true, default: false, index: true })
  isNpc!: boolean;

  @Prop({ type: String, enum: FACTIONS })
  faction?: Faction;

  @Prop({ type: String, enum: SIDES })
  side?: Side;

  // Epoch ms.
  @Prop({ type: Number })
  sideChangedAt?: number;

  @Prop({ type: Number, required: true, default: 0 })
  contribution!: number;

  @Prop({ type: [String], required: true, default: [] })
  medals!: string[];

  @Prop({ type: MongooseSchema.Types.Mixed, required: true, default: {} })
  settings!: Record<string, unknown>;

  // Explicitly `Number`-typed so the `timestamps` option above (which calls
  // `currentTime()`, returning epoch ms) populates these as numbers instead
  // of Mongoose's usual `Date` default — see the schema-option comment.
  @Prop({ type: Number })
  createdAt!: number;

  @Prop({ type: Number })
  updatedAt!: number;
}

export const AccountSchema = SchemaFactory.createForClass(Account);
