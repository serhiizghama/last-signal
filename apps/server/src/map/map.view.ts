import { isBeginnerProtected } from '@last-signal/game-core';

import type { AccountDocument, Faction, Side } from '../schemas/account.schema';
import type { OasisDocument, OasisType } from '../schemas/oasis.schema';
import type { SettlementDocument } from '../schemas/settlement.schema';
import type { WorldDocument } from '../schemas/world.schema';

// World header for `GET /api/map` (M2a.6, `docs/M2_DESIGN_DECISIONS.md` §5). `serverTime`
// follows the same convention as `SettlementStateView.serverTime` (`settlements.view.ts`):
// every response carries the server's own clock so the client drives countdowns/derived state
// against it, never its own.
//
// `source` is deliberately omitted rather than shipped as an always-`null` field: the Signal
// Source has no location until M5's Act 2 reveal (§2), and M5 owns designing its own
// client-facing shape (holder side, accumulated progress, ...) once there is something real to
// describe. A field that is permanently `null` for the whole of M2 would commit the wire
// contract to a guess the client has no use for yet; adding it in M5 is a backward-compatible
// addition to this view, not a breaking change.
export interface MapWorldView {
  seed: string;
  roundNumber: number;
  act: number;
  serverTime: number;
}

// One settlement, public fields only (§5: "everything on the map is public" — coordinates,
// name, owner name, faction and side). Internals — resources, buildings, build queue, troops —
// are obtainable only by scouting (M2b) and must never appear here; an NPC-seeded settlement
// must be indistinguishable from a human one, so this carries no `isNpc` and nothing else that
// could give one away. `ownerFaction`/`ownerSide` are optional because `Account.faction`/`side`
// themselves are (a guest can found a settlement before registering — see
// `settlement-creation.integration.spec.ts`'s happy-path test), mirroring `AccountView`'s own
// optionality for the same fields.
//
// `ownerAccountId` rides along even though nothing here renders it directly: it lets the
// client highlight the caller's own settlements against its own (already-known, from
// `GET /api/auth/me`) account id without a second round trip. Account ids are opaque ObjectId
// strings and carry no private information on their own.
//
// `protectedUntil` (M3c.8, §11/§19.8) is the ONE deliberate, scoped exception to "an NPC must
// be indistinguishable from a human one" above: §11 requires the map to mark a beginner-
// protected settlement "so nobody wastes a march", which is a real, functionally necessary
// asymmetry between a freshly-founded human account (protected) and an NPC (never protected,
// `Account.protectedUntil` is always `undefined` for them — that schema field's own comment
// explains why). §19.8 is explicit that this is the *only* addition permitted here: "must not
// be relaxed to show protection status plus anything else." Present only while protection is
// still actually in effect (`isBeginnerProtected` at the time this view is built) — an
// account whose 72 h has already lapsed goes back to being indistinguishable from an NPC, the
// same as it always was; the field is not left dangling with a stale past timestamp forever
// just because the account happens to have founded through the normal path once. Optional and
// raw-timestamp, not a precomputed `isProtected: boolean` — the client derives the badge (and
// can run its own countdown) via the same `isBeginnerProtected(protectedUntil, serverTime)`
// this file uses server-side, never a boolean this view would otherwise have to invent.
export interface MapSettlementView {
  id: string;
  x: number;
  y: number;
  name: string;
  ownerAccountId: string;
  ownerName: string;
  ownerFaction?: Faction;
  ownerSide?: Side;
  protectedUntil?: number;
}

// One oasis (§2, §8): public and inert in M2 — coordinates and type only, nothing to scout or
// defend yet. Terrain itself never appears anywhere in this view — it is derived client-side
// from the world seed (`terrainAt` in `game-core`), never stored or shipped.
export interface MapOasisView {
  x: number;
  y: number;
  type: OasisType;
}

export interface MapView {
  world: MapWorldView;
  settlements: MapSettlementView[];
  oases: MapOasisView[];
}

export function buildMapWorldView(world: WorldDocument, now: number): MapWorldView {
  return {
    seed: world.seed,
    roundNumber: world.roundNumber,
    act: world.act,
    serverTime: now,
  };
}

export function buildMapOasisView(oasis: OasisDocument): MapOasisView {
  return { x: oasis.x, y: oasis.y, type: oasis.type };
}

// Pure reshape of a settlement document plus its already-resolved owner account into the wire
// view. `owner` is passed in rather than looked up here — `MapService` is the one place that
// knows how ownership was batch-resolved (see its own comment for why: two queries joined in
// memory, not a per-settlement lookup). `now` is needed only for the `protectedUntil` gate
// below — every other field here is a plain, timeless reshape.
export function buildMapSettlementView(
  settlement: SettlementDocument,
  owner: AccountDocument,
  now: number,
): MapSettlementView {
  return {
    id: String(settlement._id),
    x: settlement.x,
    y: settlement.y,
    name: settlement.name,
    ownerAccountId: String(owner._id),
    ownerName: owner.name,
    ownerFaction: owner.faction,
    ownerSide: owner.side,
    // Spread so the key is genuinely absent (not present-with-`undefined`, which JSON would
    // drop anyway but which would still show up in an `Object.keys` comparison against a
    // Mongoose-document spread) whenever protection isn't currently in effect — see this
    // field's own doc comment on `MapSettlementView` above for why "currently" matters.
    ...(isBeginnerProtected(owner.protectedUntil, now)
      ? { protectedUntil: owner.protectedUntil }
      : {}),
  };
}
