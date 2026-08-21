import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

// A terminal-status field, not an event-payload flag (§14, M3d.4) — the SAME idempotency
// shape `Movement.status`/`TradeOfferStatus` already use, and deliberately NOT a boolean
// tucked into the `marketExchange` event's own payload. Two reasons, both load-bearing:
// (1) idempotency — `MarketExchangeHandler`'s replay guard is "re-read this document, is it
// still `pending`?", the identical pattern every other scheduled-completion handler in this
// codebase follows (`TradeOfferExpireHandler`, `MovementArriveHandler`); an event payload is
// immutable once created, so it has nowhere to record "already applied" without inventing a
// second, competing idempotency mechanism just for this one feature. (2) the M3e Market tab
// needs to list an exchange **in progress**, with a countdown to `completesAt` — a real query
// (`{status: 'pending'}`, mirrors `MarketService.listOffers`'s own `{status: 'open'}`) that an
// event document (queryable only by the scheduler's own internal machinery, not a feature
// module) cannot serve.
export type MarketExchangeStatus = 'pending' | 'completed';
const MARKET_EXCHANGE_STATUSES: MarketExchangeStatus[] = ['pending', 'completed'];

export type MarketExchangeDocument = HydratedDocument<MarketExchange>;

// The world exchange (§14, M3d.4): a settlement converts `amount` of `from` into `to` at
// `exchangeOutput`'s fixed weighted rate minus the spread. Unlike a `TradeOffer`/`trade`
// movement, this has no counterparty and nothing travels the map (§14: "there is no
// counterparty to travel to") — it is a settlement-local operation with a scheduled
// completion, structurally closer to `TradeOffer`'s own lifecycle (post now, resolve later,
// terminal `status`) than to a `Movement`'s.
@Schema({
  collection: 'marketExchanges',
  timestamps: { currentTime: () => Date.now() },
  // The app owns its own optimistic-concurrency `version` field below, same convention as
  // every other mutable document here (`Settlement`, `Movement`, `TradeOffer`).
  versionKey: false,
})
export class MarketExchange {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Account', required: true, index: true })
  accountId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Settlement', required: true })
  settlementId!: Types.ObjectId;

  // Plain `string`s, narrowed at the read site via `isResourceKind` — the same "schema stores
  // the wire string, a command narrows it before calling into `game-core`" convention
  // `TradeOfferSide.resource` already established for this exact feature.
  @Prop({ type: String, required: true })
  from!: string;

  @Prop({ type: String, required: true })
  to!: string;

  // How much of `from` was deducted at creation (deduct-at-start — the same discipline
  // `TradeOffer.give` uses, M3d.2).
  @Prop({ type: Number, required: true })
  amount!: number;

  // `exchangeOutput(config, from, to, amount)` (`game-core`), captured once at creation
  // rather than recomputed from `GameConfig` when the completion handler runs — the same
  // "capture the value now, don't re-derive it later" reasoning `Movement.merchants`'s own
  // comment records: `valueWeights`/`exchangeSpread` could in principle be retuned while this
  // exchange is in flight, and the amount actually credited on completion must match what the
  // player was shown (and what was implicitly promised) at the moment they started it, not
  // whatever the config says `exchangeTripMs` later.
  @Prop({ type: Number, required: true })
  output!: number;

  // `merchantsNeededFor(config, faction, amount)` (`game-core`), captured at creation for the
  // identical reason `TradeOffer.merchantsNeeded` and `Movement.merchants` both capture theirs
  // — `MarketExchangeHandler` must free back exactly this many on completion, regardless of
  // any later Market-level or config change.
  @Prop({ type: Number, required: true })
  merchantsOccupied!: number;

  @Prop({ type: String, enum: MARKET_EXCHANGE_STATUSES, required: true, default: 'pending' })
  status!: MarketExchangeStatus;

  @Prop({ type: Number, required: true })
  startedAt!: number;

  // When `MarketExchangeHandler` is scheduled to run (`config.market.exchangeTripMs` after
  // `startedAt`) — the client's countdown target, same role `TradeOffer.expiresAt` plays for
  // an offer's own TTL.
  @Prop({ type: Number, required: true })
  completesAt!: number;

  // The scheduled `marketExchange` event's id — same bookkeeping role as
  // `TradeOffer.expireEventId`/`Movement.arriveEventId`. Kept even though nothing cancels an
  // exchange in flight today (§14 names no cancel path for this feature, unlike an offer's
  // player-issued cancel): every other "pending, scheduled" document in this codebase keeps
  // its own event id for the same reason, and inventing an exception here would be a
  // needless divergence for a field that costs nothing to keep.
  @Prop({ type: MongooseSchema.Types.ObjectId })
  completeEventId?: Types.ObjectId;

  // Optimistic-concurrency guard, same convention as every other mutable document in this
  // codebase (`docs/CONCURRENCY_PLAYBOOK.md`) — every write to this document (create,
  // complete) goes through a version-guarded `findOneAndUpdate`.
  @Prop({ type: Number, required: true, default: 0 })
  version!: number;

  @Prop({ type: Number })
  createdAt!: number;

  @Prop({ type: Number })
  updatedAt!: number;
}

export const MarketExchangeSchema = SchemaFactory.createForClass(MarketExchange);

// The Market tab's own read (M3e): this account's exchanges, most relevant (still pending)
// ones easiest to find. Mirrors `TradeOfferSchema`'s own `{status, createdAt}` compound index
// reasoning — `status` first as the highest-selectivity equality term.
MarketExchangeSchema.index({ accountId: 1, status: 1 });
