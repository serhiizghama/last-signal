import type { IncomingDetailTier } from '@last-signal/game-core';

import type { MovementDocument, MovementStatus, MovementType } from '../schemas/movement.schema';
import type { UnitCountEntry } from './movements.util';

// The client's countdowns are driven from `serverTime` + `arriveAt`/`returnAt`, run locally,
// and never trust the client's own clock — same convention as `SettlementStateView`'s own
// `serverTime` field (`settlements/settlements.view.ts`).
export interface MovementView {
  id: string;
  type: MovementType;
  fromSettlementId: string;
  // Exactly one of these two is ever present (M3c.7a, mirroring the schema's own documented
  // `toSettlementId`/`toOasisId` xor invariant — see `Movement.toSettlementId`'s comment):
  // `toSettlementId` for a settlement target, `toOasisId` for a farm oasis one. Both optional
  // rather than one required — before this step `toMovementView` unconditionally rendered
  // `toSettlementId: String(doc.toSettlementId)`, which for an oasis-targeted movement would
  // have serialised the literal string `"undefined"` instead of omitting the field.
  toSettlementId?: string;
  toOasisId?: string;
  target: { x: number; y: number };
  units: UnitCountEntry[];
  survivors: UnitCountEntry[];
  // Only ever set on an `assault` that actually carries siege units (§7) — see
  // `MovementsService.sendMovement` step 6. M3c.3 recorded this as debt: the field has been
  // on the schema since M3c.2 but was never exposed on the *owner's own* view, so a player
  // could not read back what their own assault was ordered against. M3c.8 closes it here —
  // deliberately NOT the same field the `/incoming` endpoint gates behind the `full` tier
  // (`IncomingMovementView.siegeTarget`): this is the sender's own movement, always visible
  // to them regardless of anyone's Radio Tower, while the incoming view's copy is the
  // *defender's* knowledge of an attack aimed at them and stays tier-gated. Two fields with
  // the same name on two different view types, two different visibility rules — no sharing.
  siegeTarget?: string;
  departAt: number;
  arriveAt: number;
  returnAt: number | null;
  status: MovementStatus;
  serverTime: number;
}

// Pure reshape of a persisted movement document into the wire view model — mirrors
// `buildSettlementStateView`'s own "nothing here is computed by hand" convention, just with
// no game-core formulas to call (a movement's own fields are already the whole view).
export function toMovementView(doc: MovementDocument, now: number): MovementView {
  return {
    id: String(doc._id),
    type: doc.type,
    fromSettlementId: String(doc.fromSettlementId),
    // Spread so whichever id is actually unset never lands in the response as the literal
    // string `"undefined"` — same "only ever set when meaningful" convention
    // `MovementsService.sendMovement` already applies to `siegeTarget`.
    ...(doc.toSettlementId !== undefined ? { toSettlementId: String(doc.toSettlementId) } : {}),
    ...(doc.toOasisId !== undefined ? { toOasisId: String(doc.toOasisId) } : {}),
    target: { x: doc.target.x, y: doc.target.y },
    units: doc.units.map((u) => ({ unitType: u.unitType, count: u.count })),
    survivors: doc.survivors.map((u) => ({ unitType: u.unitType, count: u.count })),
    ...(doc.siegeTarget !== undefined ? { siegeTarget: doc.siegeTarget } : {}),
    departAt: doc.departAt,
    arriveAt: doc.arriveAt,
    returnAt: doc.returnAt,
    status: doc.status,
    serverTime: now,
  };
}

// `GET /api/movements/incoming` (M3c.8, `docs/M3_DESIGN_DECISIONS.md` §12): the movements
// currently inbound to one of the CALLER's OWN settlements, detail gated per-movement by
// that specific target settlement's Radio Tower level. Every field beyond the base set is
// optional and only ever populated once `detailTier` says it may be — see
// `MovementsService.listIncoming`'s own comment for why the server enforces this by never
// setting the field at all (never by setting-then-trusting-the-client-to-hide-it): the exact
// security property `map.integration.spec.ts`'s leak guard already established for
// `GET /api/map`, applied here to a per-movement, per-tier payload instead of a flat one.
export interface IncomingMovementView {
  id: string;
  toSettlementId: string;
  arriveAt: number;
  // The origin tile + owner are `existence`-tier information (§12's table, top row) — always
  // present, at every tower level including 0.
  origin: { x: number; y: number };
  originSettlementId: string;
  ownerAccountId: string;
  ownerName: string;
  detailTier: IncomingDetailTier;
  // `raid`/`assault` are hostile; `support` is not (it is help, §8) — carried as its own
  // boolean rather than left for the client to infer from `type`, since `type` itself is
  // gated behind the `kind` tier and unavailable at `existence`, where the defender still
  // needs to know whether to be worried.
  hostile: boolean;
  // `kind` tier and up (§12) — always present for `support`, which is exempt from tiering
  // entirely (`MovementsService.listIncoming` forces `detailTier: 'full'` for it, so these
  // conditionals fall through the same way they would for a tower at the `full` threshold).
  type?: MovementType;
  unitCount?: number;
  // `full` tier only.
  units?: UnitCountEntry[];
  siegeTarget?: string;
}

export interface IncomingMovementsView {
  movements: IncomingMovementView[];
  serverTime: number;
}

// Pure reshape for one incoming movement — `origin`/`owner` are passed in already resolved
// rather than looked up here, mirroring `buildMapSettlementView`'s own convention: the
// service is the one place that knows how origin settlements/owners were batch-resolved
// (joined in memory, not per-movement queries — see `MovementsService.listIncoming`'s own
// comment for why), this function only reshapes what it's handed.
//
// `detailTier` decides which optional fields get set — and, critically, *only* which fields
// get set. There is no "set everything, let the client redact" path anywhere in this
// function: a `kind`-tier movement's returned object literally does not have a `units` key,
// full stop. That is the whole security property this endpoint exists to provide.
export function toIncomingMovementView(
  doc: MovementDocument,
  origin: { id: string; x: number; y: number; ownerAccountId: string; ownerName: string },
  detailTier: IncomingDetailTier,
  hostile: boolean,
): IncomingMovementView {
  const view: IncomingMovementView = {
    id: String(doc._id),
    // Always a settlement id: an oasis has no owner to be "inbound" *at* (§10), so
    // `MovementsService.listIncoming`'s query only ever matches movements whose
    // `toSettlementId` is set — see that method's own comment.
    toSettlementId: String(doc.toSettlementId),
    arriveAt: doc.arriveAt,
    origin: { x: origin.x, y: origin.y },
    originSettlementId: origin.id,
    ownerAccountId: origin.ownerAccountId,
    ownerName: origin.ownerName,
    detailTier,
    hostile,
  };
  if (detailTier === 'kind' || detailTier === 'full') {
    view.type = doc.type;
    view.unitCount = doc.units.reduce((total, u) => total + u.count, 0);
  }
  if (detailTier === 'full') {
    view.units = doc.units.map((u) => ({ unitType: u.unitType, count: u.count }));
    if (doc.siegeTarget !== undefined) {
      view.siegeTarget = doc.siegeTarget;
    }
  }
  return view;
}
