import type { GameConfig, UnitType } from '../config/types.js';
import { slowestSpeed } from '../map/travel.js';

/** A settlement's or a marching army's troop composition: how many of each unit type. */
export type TroopCounts = ReadonlyArray<{ unitType: UnitType; count: number }>;

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
