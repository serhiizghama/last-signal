import type { ResourceKind } from '@last-signal/game-core';

import type {
  MarketExchangeDocument,
  MarketExchangeStatus,
} from '../schemas/market-exchange.schema';
import type { TradeOfferDocument, TradeOfferStatus } from '../schemas/trade-offer.schema';

export interface TradeOfferSideView {
  resource: ResourceKind;
  amount: number;
}

// The client's countdowns are driven from `serverTime` + `expiresAt`, run locally, never the
// client's own clock — same convention as `MovementView`'s own `serverTime` field.
export interface TradeOfferView {
  id: string;
  fromSettlementId: string;
  give: TradeOfferSideView;
  want: TradeOfferSideView;
  merchantsNeeded: number;
  status: TradeOfferStatus;
  createdAt: number;
  expiresAt: number;
  serverTime: number;
}

// Pure reshape of a persisted offer document into the wire view model — mirrors
// `toMovementView`'s own "nothing here is computed by hand" convention. `resource` is cast
// back to `ResourceKind` rather than re-narrowed with `isResourceKind`: every document this
// function is ever handed was itself only ever written by `MarketService.createOffer` after
// that exact check already passed (the same trust `toMovementView` places in
// `doc.units[].unitType` already being a real `UnitType`).
export function toTradeOfferView(doc: TradeOfferDocument, now: number): TradeOfferView {
  return {
    id: String(doc._id),
    fromSettlementId: String(doc.fromSettlementId),
    give: { resource: doc.give.resource as ResourceKind, amount: doc.give.amount },
    want: { resource: doc.want.resource as ResourceKind, amount: doc.want.amount },
    merchantsNeeded: doc.merchantsNeeded,
    status: doc.status,
    createdAt: doc.createdAt,
    expiresAt: doc.expiresAt,
    serverTime: now,
  };
}

// The board (`GET /api/market/offers`, §14): offers are public between players (this is a
// marketplace) — widens `TradeOfferView` with exactly the three things the brief calls for
// so the client can show distance/counterparty/ownership without a second round trip:
// whether this is the caller's own offer, the origin settlement's coordinates, and its
// owner's display name.
export interface TradeOfferBoardEntryView extends TradeOfferView {
  mine: boolean;
  origin: { x: number; y: number };
  ownerName: string;
}

export interface TradeOfferBoardView {
  offers: TradeOfferBoardEntryView[];
  serverTime: number;
}

// `origin`/`ownerName` are passed in already resolved rather than looked up here — mirrors
// `toIncomingMovementView`'s own convention: the service is the one place that knows how the
// origin settlements + owners were batch-resolved (joined in memory, not per-offer queries —
// see `MarketService.listOffers`'s own comment), this function only reshapes what it's handed.
export function toTradeOfferBoardEntryView(
  doc: TradeOfferDocument,
  now: number,
  mine: boolean,
  origin: { x: number; y: number },
  ownerName: string,
): TradeOfferBoardEntryView {
  return { ...toTradeOfferView(doc, now), mine, origin, ownerName };
}

// The response body for a cancel (§14/M3d.2's own brief: "returns what was actually refunded
// and what was lost ... so a synchronous caller can see the clamp"). `refunded`/`lost` are
// bare numbers, not a four-resource `Resources` bundle like `MovementReturnHandler`'s own
// loot fields — an offer's `give` names exactly one resource, so there is only ever one
// number of each to report, not a bundle with three always-zero entries.
export interface TradeOfferCancelView {
  offer: TradeOfferView;
  refunded: number;
  lost: number;
}

// The response body for an accept (M3d.3, §14). `offer` reflects its new `'accepted'` status;
// the two movement ids let a synchronous caller (or an integration test) look either leg up
// immediately without a second round trip — deliberately named by DIRECTION
// (`offererToAccepter`/`accepterToOfferer`), not by "mine"/"theirs", since either party could
// in principle be the one reading this response back (only the accepter ever calls this
// route today, but the naming does not assume that will always stay true). Neither leg's
// `cargo`/`merchants`/`tradeOfferId` are echoed here — those are internal accounting fields
// (`Movement`'s own schema comments), not wire-facing view fields; a caller who wants a leg's
// own state reads it back through the ordinary movement views once M3e wires them up.
export interface TradeAcceptView {
  offer: TradeOfferView;
  offererToAccepterMovementId: string;
  accepterToOffererMovementId: string;
}

// The world exchange (§14, M3d.4) — what `POST /api/market/exchange` returns and what a
// future Market tab (M3e) reads to render "exchange in progress" with a countdown. Like
// `TradeOfferView`, the client's countdown is driven from `serverTime` + `completesAt`, run
// locally, never the client's own clock.
export interface MarketExchangeView {
  id: string;
  settlementId: string;
  from: ResourceKind;
  to: ResourceKind;
  amount: number;
  output: number;
  merchantsOccupied: number;
  status: MarketExchangeStatus;
  startedAt: number;
  completesAt: number;
  serverTime: number;
}

// Pure reshape of a persisted exchange document into the wire view model — mirrors
// `toTradeOfferView`'s own "nothing here is computed by hand" convention. `from`/`to` are
// cast back to `ResourceKind` rather than re-narrowed with `isResourceKind`: every document
// this function is ever handed was itself only ever written by `MarketService.startExchange`
// after that exact check already passed.
export function toMarketExchangeView(doc: MarketExchangeDocument, now: number): MarketExchangeView {
  return {
    id: String(doc._id),
    settlementId: String(doc.settlementId),
    from: doc.from as ResourceKind,
    to: doc.to as ResourceKind,
    amount: doc.amount,
    output: doc.output,
    merchantsOccupied: doc.merchantsOccupied,
    status: doc.status,
    startedAt: doc.startedAt,
    completesAt: doc.completesAt,
    serverTime: now,
  };
}
