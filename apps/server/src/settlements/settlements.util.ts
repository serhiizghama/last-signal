import type { BuildingLevels, BuildingType } from '@last-signal/game-core';
import { BUILDING_TYPES, SETTLEMENT_SLOTS } from '@last-signal/game-core';

import type { BuildingSlot } from '../schemas/settlement.schema';

// The schema stores `type` as a plain `string` (Mongoose has no way to type a subdocument
// field against game-core's `BuildingType` union) — this is the one narrowing point every
// command funnels through before calling a game-core formula.
export function isBuildingType(value: string): value is BuildingType {
  return (BUILDING_TYPES as readonly string[]).includes(value);
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
