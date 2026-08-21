import type {
  BuildingLevels,
  BuildingType,
  GameConfig,
  ResourceKind,
  Resources,
  TroopCounts,
  UnitType,
} from '@last-signal/game-core';
import {
  BUILDING_TYPES,
  RESOURCE_KINDS,
  SETTLEMENT_SLOTS,
  UNIT_TYPES,
  calcNetFoodPerHour,
  msUntilEmpty,
  unionTroops,
} from '@last-signal/game-core';
import type { Types } from 'mongoose';

import type { BuildingSlot } from '../schemas/settlement.schema';

// The schema stores `type` as a plain `string` (Mongoose has no way to type a subdocument
// field against game-core's `BuildingType` union) — this is the one narrowing point every
// command funnels through before calling a game-core formula.
export function isBuildingType(value: string): value is BuildingType {
  return (BUILDING_TYPES as readonly string[]).includes(value);
}

// Same narrowing as `isBuildingType`, for `Settlement.troops[].unitType` /
// `trainUnits`'s request body — the schema comment on `SettlementTroopEntry` points here.
export function isUnitType(value: string): value is UnitType {
  return (UNIT_TYPES as readonly string[]).includes(value);
}

// Same narrowing again, for `TradeOffer.give`/`.want`'s `resource` field
// (`schemas/trade-offer.schema.ts`, M3d.2, §14) — that schema stores `resource` as a plain
// `string` for the same reason `SettlementTroopEntry.unitType` does (see that field's own
// schema comment): `MarketService` is the one place that narrows it before calling into any
// `game-core` market formula (`weightedResourceValue`, `isOfferRatioLegal`,
// `merchantsNeededFor`).
export function isResourceKind(value: string): value is ResourceKind {
  return (RESOURCE_KINDS as readonly string[]).includes(value);
}

// Adapts a settlement's persisted building list (`{id, type, level, slot}`, `type: string`)
// to the `BuildingLevels` shape every game-core formula accepts. Callers are expected to
// have already validated `type` via `isBuildingType` upstream (e.g. DTO/command validation);
// this is a pure reshape, not a second validation pass.
export function toBuildingLevels(
  buildings: ReadonlyArray<{ type: string; level: number }>,
): BuildingLevels {
  return buildings.map((b) => ({ type: b.type as BuildingType, level: b.level }));
}

// Adapts a settlement's persisted troop list (`{unitType, count}`, `unitType: string`) to
// the `TroopCounts` shape every game-core economy formula now accepts (§7's Food-upkeep
// hook: `calcNetRates`, `calcNetFoodPerHour`, `settleResources`, `wouldStarveSettlement`).
// Same "pure reshape, caller already validated" contract as `toBuildingLevels` above —
// entries here are only ever written by `TrainingCompleteHandler` and `NpcSeederService`,
// both of which only ever write real `UnitType` values.
export function toTroopCounts(
  troops: ReadonlyArray<{ unitType: string; count: number }>,
): TroopCounts {
  return troops.map((t) => ({ unitType: t.unitType as UnitType, count: t.count }));
}

// The union of a settlement's three troop lists — `troops` (home), `awayTroops` (in
// transit), `stationedTroops` (hosted for an ally) — which is what Food upkeep is actually
// charged on (M3a.4, `docs/M3_DESIGN_DECISIONS.md` §3). This is the single named helper for
// that union rather than an inline `unionTroops(...)` at each call site on purpose: there
// are four upkeep call sites (`settleDoc`, `startBuild`'s starvation gate, `trainUnits`'s
// starvation gate, `buildSettlementStateView`'s rate/food display) and they must never
// disagree — the whole bug class this step exists to fix was exactly "one call site forgot a
// list" (before this step, upkeep read `troops` alone, so marching an army away silently
// dropped its Food cost to zero, §19.1). A future fourth list — none is planned — gets added
// here once, not audited across four call sites by hand.
export function upkeepTroopsOf(doc: {
  troops: ReadonlyArray<{ unitType: string; count: number }>;
  awayTroops: ReadonlyArray<{ unitType: string; count: number }>;
  stationedTroops: ReadonlyArray<{ troops: ReadonlyArray<{ unitType: string; count: number }> }>;
}): TroopCounts {
  return unionTroops(
    toTroopCounts(doc.troops),
    toTroopCounts(doc.awayTroops),
    ...doc.stationedTroops.map((contingent) => toTroopCounts(contingent.troops)),
  );
}

// The union of a settlement's home troops and every stationed contingent's troops — what is
// physically present to defend this settlement in a battle (§5, already implemented this way
// in `BattleArrivalResolver`) and, per §8, what must also count for the host's scout defence
// and detection (M3c.6 closes the obligation `upkeepTroopsOf`'s own M3a.4 comment recorded:
// "M3c must widen this to include `targetDoc.stationedTroops` once the `support` movement can
// actually populate it" — `SupportArrivalResolver` now does, so `ScoutArrivalResolver` uses
// this helper instead of `troops` alone). Deliberately its OWN helper, not `upkeepTroopsOf`
// with a flag: the two answer genuinely different questions over genuinely different subsets
// of the same three lists — upkeep is charged the instant a unit leaves home, so it MUST
// include `awayTroops` (§3); defence/detection is about who is physically here right now, so
// it must NOT — a unit marching elsewhere cannot fight or watch for the settlement it left.
export function defenceTroopsOf(doc: {
  troops: ReadonlyArray<{ unitType: string; count: number }>;
  stationedTroops: ReadonlyArray<{ troops: ReadonlyArray<{ unitType: string; count: number }> }>;
}): TroopCounts {
  return unionTroops(
    toTroopCounts(doc.troops),
    ...doc.stationedTroops.map((contingent) => toTroopCounts(contingent.troops)),
  );
}

// The opaque, stable, replay-safe `key` `resolveStarvation` (`game-core`, M3a.6 §4) needs to
// address one stationed contingent — built from the two fields that together identify "this
// account's troops from this settlement". Both `ownerAccountId` and `fromSettlementId` are
// fixed-length (24 hex char) `ObjectId` strings, so joining them with a delimiter is
// unambiguous regardless of which delimiter is chosen — there is no encoding ambiguity to
// guard against the way there would be with variable-length ids.
export function stationedContingentKey(
  ownerAccountId: Types.ObjectId,
  fromSettlementId: Types.ObjectId,
): string {
  return `${String(ownerAccountId)}:${String(fromSettlementId)}`;
}

// The instant a settlement's starvation deadline should be, given its buildings/troops and a
// resource state (M3a.6, `docs/M3_DESIGN_DECISIONS.md` §4): `null` when net Food is >= 0 (no
// tick needed at all), otherwise the instant stored Food is projected to hit zero —
// `msUntilEmpty` itself returning `null` specifically means "already at/below zero" (the
// trigger fires immediately), not "never", hence the `?? 0`. Pure and DB-free on purpose: both
// `SettlementsService.ensureStarvationSchedule` (the lazy-scheduling choke point every
// account command funnels through) and `StarvationTickHandler` (deciding its own follow-up
// when the trigger no longer holds) need the identical deadline from the identical formula,
// and neither should risk the two silently drifting apart.
export function computeStarvationDeadline(
  config: GameConfig,
  buildings: BuildingLevels,
  resourceState: { values: Resources; lastCalcAt: number },
  troops: TroopCounts,
  now: number,
): number | null {
  const netFoodPerHour = calcNetFoodPerHour(config, buildings, troops);
  if (netFoodPerHour >= 0) {
    return null;
  }
  return now + (msUntilEmpty(config, buildings, resourceState, 'food', troops) ?? 0);
}

// Current level of `type` in `buildings`, or 0 when the building hasn't been built yet.
// (`game-core`'s own equivalent, `levelOf`, is a private helper inside `formulas/buildings.ts`
// and isn't exported — this is a trivial lookup, not a game formula, so it's fine to have a
// server-local copy rather than exporting it from game-core for one caller.)
export function currentLevelOf(buildings: BuildingLevels, type: BuildingType): number {
  const found = buildings.find((b) => b.type === type);
  return found ? found.level : 0;
}

// Lowest unused slot index in `[0, SETTLEMENT_SLOTS)`. Only called when creating a
// building's first level — with 13 building types and 16 slots this can never actually run
// out in v1, but throws rather than silently reusing a slot if it ever somehow does.
export function nextFreeSlot(buildings: ReadonlyArray<Pick<BuildingSlot, 'slot'>>): number {
  const used = new Set(buildings.map((b) => b.slot));
  for (let slot = 0; slot < SETTLEMENT_SLOTS; slot += 1) {
    if (!used.has(slot)) {
      return slot;
    }
  }
  throw new Error('nextFreeSlot: no free building slot available (all slots occupied)');
}
