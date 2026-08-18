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

  // Beginner protection deadline, epoch ms (M3c, `docs/M3_DESIGN_DECISIONS.md` §11):
  // stamped to `now + config.protection.durationMs` (draft 72h) the moment this account's
  // *first* settlement is created (`SettlementsService.createSettlement`, inside the same
  // transaction as the settlement write). `undefined` for every account that has never
  // founded — including every NPC account, deliberately: `NpcSeederService` writes NPC
  // settlements via `insertMany` directly against the `settlements` collection, bypassing
  // `createSettlement` entirely, so no NPC ever gets stamped here (see the stamping call
  // site's own comment for why protecting them would break §0's raid-economy bounds).
  //
  // While `Date.now() < protectedUntil` holds, no foreign movement may target any of this
  // account's settlements — raid, assault, scout and support are all rejected at send
  // (enforcement is a later M3c step; this field only exists and gets stamped so far). It
  // lifts early, before the deadline, the instant this account sends its own first `raid` or
  // `assault` at another account's settlement — scouting and raiding an *oasis* do **not**
  // lift it, §11's deliberate asymmetry so a new player following M2c's onboarding loop
  // ("train a scout, send it") never loses protection by following the tutorial. Not
  // extendable, not purchasable, does not pause.
  @Prop({ type: Number })
  protectedUntil?: number;

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
