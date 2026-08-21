import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

// A terminal-status field, not deletion (§14, M3d.2) — mirrors `Movement.status`'s own
// comment exactly: the board query (`MarketService.listOffers`) stays a simple
// `{status: 'open'}` filter, and expiry/cancel are idempotent under replay because a
// replayed handler or a losing concurrent command finds `status !== 'open'` and no-ops,
// rather than a document that has vanished and tells the caller nothing about why.
// `'accepted'` is written by M3d.3's `MarketService.acceptOffer` — the offer's actual
// terminal status once someone takes it, as opposed to `'cancelled'`/`'expired'`, which both
// still refund the `give` side; an accepted offer refunds nothing, because its resources are
// already committed to the two `trade` movements in flight (§14).
export type TradeOfferStatus = 'open' | 'cancelled' | 'expired' | 'accepted';
const TRADE_OFFER_STATUSES: TradeOfferStatus[] = ['open', 'cancelled', 'expired', 'accepted'];

// One side of an offer — `give` or `want` (§14). `_id: false`, explicit `@Prop` types, same
// convention as every other subdocument in this codebase (`MovementTarget`,
// `SettlementTroopEntry`). `resource` is a plain `string`, narrowed at the read site via
// `isResourceKind` (`settlements.util.ts`) — the same "schema stores the wire string, a
// command narrows it before calling into `game-core`" convention `SettlementTroopEntry
// .unitType` and `BuildingSlot.type` already established for their own enums.
@Schema({ _id: false })
export class TradeOfferSide {
  @Prop({ type: String, required: true })
  resource!: string;

  @Prop({ type: Number, required: true })
  amount!: number;
}

const TradeOfferSideSchema = SchemaFactory.createForClass(TradeOfferSide);

export type TradeOfferDocument = HydratedDocument<TradeOffer>;

// A player-posted offer on the Market board (§14, M3d.2). The offered (`give`) resources are
// deducted from `fromSettlementId` at creation — mirroring M1 §6's "deduct at enqueue" and
// removing the entire class of "the offer is no longer funded by the time somebody accepts
// it" race — so an offer sitting `open` on the board is always fully funded; the only failure
// mode `MarketService`'s (M3d.3) acceptance flow can hit against it is merchant availability
// (owner decision E), never resources.
@Schema({
  collection: 'tradeOffers',
  timestamps: { currentTime: () => Date.now() },
  // The app owns its own optimistic-concurrency `version` field below, same convention as
  // every other mutable document here (`Settlement`, `Movement`) — see either's own comment
  // for why `__v` stays disabled.
  versionKey: false,
})
export class TradeOffer {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Account', required: true, index: true })
  accountId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Settlement', required: true })
  fromSettlementId!: Types.ObjectId;

  @Prop({ type: TradeOfferSideSchema, required: true })
  give!: TradeOfferSide;

  @Prop({ type: TradeOfferSideSchema, required: true })
  want!: TradeOfferSide;

  // `merchantsNeededFor(config, faction, give.amount)` (`game-core`, §14), captured once at
  // creation against the offerer's own faction and `give.amount` — not recomputed later,
  // because an account's faction never changes after registration (§13 of the M1 record) and
  // `give.amount` is fixed for the life of the offer. Unread by anything in M3d.2 (owner
  // decision E: an open offer reserves no merchants); persisted now so M3d.3's acceptance
  // flow has a number already computed against the right inputs, rather than re-deriving it
  // from data neither this step nor that one otherwise owns keeping in sync.
  @Prop({ type: Number, required: true })
  merchantsNeeded!: number;

  @Prop({ type: String, enum: TRADE_OFFER_STATUSES, required: true, default: 'open' })
  status!: TradeOfferStatus;

  @Prop({ type: Number, required: true })
  expiresAt!: number;

  // The scheduled `tradeOfferExpire` event's id, so `MarketService.cancelOffer` can delete
  // the pending one before it ever fires — same role `Movement.arriveEventId` /
  // `BuildQueueItem.eventId` play for their own scheduled follow-ups.
  @Prop({ type: MongooseSchema.Types.ObjectId })
  expireEventId?: Types.ObjectId;

  // Optimistic-concurrency guard, same convention as every other mutable document in this
  // codebase (`docs/CONCURRENCY_PLAYBOOK.md`) — every write to this document (create,
  // cancel, expire) goes through a version-guarded `findOneAndUpdate`.
  @Prop({ type: Number, required: true, default: 0 })
  version!: number;

  @Prop({ type: Number })
  createdAt!: number;

  @Prop({ type: Number })
  updatedAt!: number;
}

export const TradeOfferSchema = SchemaFactory.createForClass(TradeOffer);

// The board read (§14/M3d.2): every OPEN offer, newest first. One compound index rather than
// two separate ones — `status` first, since it is the equality term with by far the highest
// selectivity (at any moment nearly every offer that has ever existed is cancelled/expired/
// accepted, and only a small live set is actually `open`), then `createdAt` descending as the
// board's own sort key — covers `MarketService.listOffers`'s exact query
// (`{status: 'open'}`, sorted newest-first) with no in-memory sort, the same "index matches
// the one real read pattern" reasoning `ReportSchema`'s own cursor index gives for its shape.
TradeOfferSchema.index({ status: 1, createdAt: -1 });
