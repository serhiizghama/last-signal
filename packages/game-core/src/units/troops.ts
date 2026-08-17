import type { GameConfig, UnitType } from '../config/types.js';
import { UNIT_TYPES } from '../config/types.js';
import { slowestSpeed } from '../map/travel.js';

/** A settlement's or a marching army's troop composition: how many of each unit type. */
export type TroopCounts = ReadonlyArray<{ unitType: UnitType; count: number }>;

/**
 * Sums per-unit-type counts across any number of troop lists, in catalogue order. Exists
 * because Food upkeep must stay a pure function of ONE settlement document (M3 §3): a
 * settlement now carries three troop lists (`troops` at home, `awayTroops` in transit,
 * `stationedTroops` hosted for an ally) and pays upkeep on their union, with no cross-document
 * reads. Callers union the three lists locally with this function and feed the result to the
 * existing `calcNetFoodPerHour` / `calcNetRates` / `settleResources` / `wouldStarve*`
 * functions, which are unchanged and already take a single `TroopCounts`.
 *
 * Iterates `UNIT_TYPES` rather than relying on object-key or input order (mirrors
 * `unitsTrainableAt` in `units/training.ts`), drops zero-count totals (the codebase's existing
 * convention — see `MovementsService.sendScouts`'s `count > 0` filter), and never mutates any
 * input list.
 */
export function unionTroops(...lists: TroopCounts[]): TroopCounts {
  const totals = new Map<UnitType, number>();
  for (const list of lists) {
    for (const { unitType, count } of list) {
      totals.set(unitType, (totals.get(unitType) ?? 0) + count);
    }
  }
  const result: Array<{ unitType: UnitType; count: number }> = [];
  for (const unitType of UNIT_TYPES) {
    const count = totals.get(unitType) ?? 0;
    if (count > 0) {
      result.push({ unitType, count });
    }
  }
  return result;
}

/**
 * Hourly Food upkeep of a troop list (§7): `Σ foodUpkeepPerHour * count`. 0 for an empty list.
 * Scouts consume Food from the moment they are credited — this is the M2 slice of upkeep;
 * starvation (killing troops on a negative balance) is M3.
 */
export function calcTroopFoodUpkeepPerHour(config: GameConfig, troops: TroopCounts): number {
  let total = 0;
  for (const { unitType, count } of troops) {
    total += config.units[unitType].foodUpkeepPerHour * count;
  }
  return total;
}

/**
 * The unit speed that decides this troop list's travel time: the slowest unit present, per
 * `slowestSpeed` (`map/travel.ts`, §0). Throws on an empty list, same as `slowestSpeed`.
 */
export function slowestTroopSpeed(config: GameConfig, troops: TroopCounts): number {
  return slowestSpeed(troops.map(({ unitType }) => config.units[unitType].speed));
}

/** Total scout-attack points of a troop list: `Σ scoutAttack * count` (§8's resolution formula). */
export function calcTroopScoutAttack(config: GameConfig, troops: TroopCounts): number {
  let total = 0;
  for (const { unitType, count } of troops) {
    total += config.units[unitType].scoutAttack * count;
  }
  return total;
}

/** Total scout-defense points of a troop list: `Σ scoutDefense * count` (§8's resolution formula). */
export function calcTroopScoutDefense(config: GameConfig, troops: TroopCounts): number {
  let total = 0;
  for (const { unitType, count } of troops) {
    total += config.units[unitType].scoutDefense * count;
  }
  return total;
}
