import type { Faction, GameConfig, UnitDef, UnitType } from '../config/types.js';
import { ceilSecondsToMs, emptyResources, roundCost } from '../numeric.js';
import { RESOURCE_KINDS, type Resources } from '../types.js';

/** Throws when `count` is negative (used by every command that trains or costs out units). */
function assertNonNegativeCount(count: number, fnName: string): void {
  if (count < 0) {
    throw new RangeError(`${fnName}: count must not be negative, got ${count}`);
  }
}

/** The units a faction may train, in catalogue order (§7). One scout each until M3. */
export function unitsForFaction(config: GameConfig, faction: Faction): UnitDef[] {
  return Object.values(config.units).filter((unit) => unit.faction === faction);
}

/** The scout unit for `faction` — the training UI needs exactly this (§7). Every faction has one. */
export function scoutUnitForFaction(config: GameConfig, faction: Faction): UnitDef {
  const scout = unitsForFaction(config, faction).find((unit) => unit.role === 'scout');
  if (!scout) {
    throw new RangeError(`scoutUnitForFaction: no scout unit defined for faction "${faction}"`);
  }
  return scout;
}

/** Cost of training `count` units of `unitType`: per-unit cost x count, `roundCost`-rounded (§10). */
export function calcTrainCost(config: GameConfig, unitType: UnitType, count: number): Resources {
  assertNonNegativeCount(count, 'calcTrainCost');
  const def = config.units[unitType];
  const result = emptyResources();
  for (const kind of RESOURCE_KINDS) {
    result[kind] = roundCost(def.cost[kind] * count);
  }
  return result;
}

/**
 * Training time for ONE unit of `unitType`, in ms: `baseTrainTimeSec / speed.training`, ceiled
 * to whole seconds (§10). Units complete one at a time via chained events (§7), so a per-unit
 * time is the primitive other durations build on.
 */
export function calcTrainTimeMs(config: GameConfig, unitType: UnitType): number {
  const def = config.units[unitType];
  return ceilSecondsToMs(def.baseTrainTimeSec / config.speed.training);
}

/**
 * Total time to train `count` units of `unitType`. Units complete one at a time (§7) — there is
 * no batch discount — so this is simply `count *` the single-unit time from `calcTrainTimeMs`.
 */
export function calcTrainBatchTimeMs(
  config: GameConfig,
  unitType: UnitType,
  count: number,
): number {
  assertNonNegativeCount(count, 'calcTrainBatchTimeMs');
  return calcTrainTimeMs(config, unitType) * count;
}
