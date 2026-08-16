import type { BuildingLevels, BuildingType, TroopCounts, UnitType } from '@last-signal/game-core';
import { BUILDING_TYPES, SETTLEMENT_SLOTS, UNIT_TYPES } from '@last-signal/game-core';

import type { BuildingSlot } from '../schemas/settlement.schema';

// The schema stores `type` as a plain `string` (Mongoose has no way to type a subdocument
// field against game-core's `BuildingType` union) — this is the one narrowing point every
// command funnels through before calling a game-core formula.
export function isBuildingType(value: string): value is BuildingType {
  return (BUILDING_TYPES as readonly string[]).includes(value);
}

// Same narrowing as `isBuildingType`, for `Settlement.troops[].unitType` /
// `trainScouts`'s request body — the schema comment on `SettlementTroopEntry` points here.
export function isUnitType(value: string): value is UnitType {
  return (UNIT_TYPES as readonly string[]).includes(value);
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
