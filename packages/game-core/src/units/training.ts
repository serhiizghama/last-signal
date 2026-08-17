import type { BuildingType, Faction, GameConfig, UnitDef, UnitType } from '../config/types.js';
import { UNIT_TYPES } from '../config/types.js';
import { ceilSecondsToMs, emptyResources, roundCost } from '../numeric.js';
import { RESOURCE_KINDS, type Resources } from '../types.js';

/** Throws when `count` is negative (used by every command that trains or costs out units). */
function assertNonNegativeCount(count: number, fnName: string): void {
  if (count < 0) {
    throw new RangeError(`${fnName}: count must not be negative, got ${count}`);
  }
}

/** Throws when `trainingBuildingLevel` is below 1 (a level-0 building does not exist and cannot train). */
function assertValidTrainingBuildingLevel(level: number, fnName: string): void {
  if (level < 1) {
    throw new RangeError(`${fnName}: trainingBuildingLevel must be at least 1, got ${level}`);
  }
}

/**
 * Every unit whose `faction` field equals `faction`, in `Object.values` (declaration) order —
 * a plain `faction` filter, nothing about trainability. That makes this the wrong function for
 * "what can this faction actually train, and where": it excludes the Settler (`faction: null`,
 * yet trainable by everybody) and would include a `faction`-tagged unit with no `trainedIn` if
 * one ever existed. Use `unitsTrainableAt`/`canFactionTrain` for that question; this one exists
 * because `scoutUnitForFaction` below needs exactly "this faction's own units" to find the
 * scout among them.
 */
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
 * Training time for ONE unit of `unitType`, in ms: `baseTrainTimeSec / speed.training`,
 * discounted by the training building's level and ceiled to whole seconds (§10, M3 §2). Units
 * complete one at a time via chained events (§7), so a per-unit time is the primitive other
 * durations build on.
 *
 * `trainingBuildingLevel` is REQUIRED, not optional-with-a-default: an implicit "level 1"
 * default would silently apply at a call site that simply forgot to pass the real level, and
 * the resulting bug — training that never speeds up with the building — would be invisible
 * rather than loud. A required parameter turns that mistake into a compile error instead
 * (contrast the economy formulas' optional `troops` parameters, a documented sharp edge this
 * function deliberately does not repeat).
 */
export function calcTrainTimeMs(
  config: GameConfig,
  unitType: UnitType,
  trainingBuildingLevel: number,
): number {
  assertValidTrainingBuildingLevel(trainingBuildingLevel, 'calcTrainTimeMs');
  const def = config.units[unitType];
  const timeFactor = config.training.buildingTimeRatio ** (trainingBuildingLevel - 1);
  return ceilSecondsToMs((def.baseTrainTimeSec / config.speed.training) * timeFactor);
}

/**
 * Total time to train `count` units of `unitType` at `trainingBuildingLevel`. Units complete
 * one at a time (§7) — there is no batch discount — so this is simply `count *` the single-unit
 * time from `calcTrainTimeMs`.
 */
export function calcTrainBatchTimeMs(
  config: GameConfig,
  unitType: UnitType,
  count: number,
  trainingBuildingLevel: number,
): number {
  assertNonNegativeCount(count, 'calcTrainBatchTimeMs');
  return calcTrainTimeMs(config, unitType, trainingBuildingLevel) * count;
}

/**
 * True when `faction` may train `unitType` at all (M3 §1, §2): the unit must have a
 * `trainedIn` (the two wildlife types have none and no account can ever train them), and
 * either belong to `faction` (the faction lock, unchanged from M2) or have `faction: null`
 * (open to every faction — today exactly the Settler).
 */
export function canFactionTrain(config: GameConfig, unitType: UnitType, faction: Faction): boolean {
  const def = config.units[unitType];
  return def.trainedIn !== undefined && (def.faction === null || def.faction === faction);
}

/**
 * The units `faction` may train at `building`, in catalogue order (§7, M3 §1, §2) — iterates
 * `UNIT_TYPES` rather than `Object.values(config.units)` so the order is the catalogue's
 * declared stable one, not an object-key accident.
 */
export function unitsTrainableAt(
  config: GameConfig,
  building: BuildingType,
  faction: Faction,
): UnitDef[] {
  return UNIT_TYPES.map((unitType) => config.units[unitType]).filter(
    (def) => def.trainedIn === building && canFactionTrain(config, def.type, faction),
  );
}
