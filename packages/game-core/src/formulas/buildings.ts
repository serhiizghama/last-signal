import type {
  BuildingDef,
  BuildingLevels,
  BuildingRequirement,
  BuildingType,
  GameConfig,
} from '../config/types.js';
import { ceilSecondsToMs, emptyResources, roundCost } from '../numeric.js';
import { RESOURCE_KINDS, type Resources } from '../types.js';

/** Throws when `level` is outside `1..maxLevel` (used by cost and build-time commands). */
function assertValidLevel(level: number, maxLevel: number, fnName: string): void {
  if (level < 1 || level > maxLevel) {
    throw new RangeError(`${fnName}: level must be between 1 and ${maxLevel}, got ${level}`);
  }
}

/** Current level of `type` within `buildings`, or 0 when absent (§2, §5). */
function levelOf(buildings: BuildingLevels, type: BuildingType): number {
  const found = buildings.find((b) => b.type === type);
  return found ? found.level : 0;
}

/** Cost of reaching `level` for `type`: base cost scaled by the family's cost ratio (§2). */
export function calcBuildCost(config: GameConfig, type: BuildingType, level: number): Resources {
  const def = config.buildings[type];
  assertValidLevel(level, def.maxLevel, 'calcBuildCost');
  const ratio = config.curves[def.family].costRatio;
  const factor = ratio ** (level - 1);
  const result = emptyResources();
  for (const kind of RESOURCE_KINDS) {
    result[kind] = roundCost(def.baseCost[kind] * factor);
  }
  return result;
}

/**
 * Build time to reach `level` for `type`, discounted by the Command Center's level and the
 * build-speed multiplier, ceiled to whole seconds and returned in ms (§2, §9).
 */
export function calcBuildTimeMs(
  config: GameConfig,
  type: BuildingType,
  level: number,
  commandCenterLevel: number,
): number {
  const def = config.buildings[type];
  assertValidLevel(level, def.maxLevel, 'calcBuildTimeMs');
  if (commandCenterLevel < 0) {
    throw new RangeError(
      `calcBuildTimeMs: commandCenterLevel must not be negative, got ${commandCenterLevel}`,
    );
  }
  const ratio = config.curves[def.family].timeRatio;
  const secondsAtX1 = def.baseBuildTimeSec * ratio ** (level - 1);
  const discounted = secondsAtX1 * config.commandCenter.buildTimeRatio ** commandCenterLevel;
  const sped = discounted / config.speed.build;
  return ceilSecondsToMs(sped);
}

/**
 * Per-level production growth multiplier: decelerates linearly from `ratioStart` at the first
 * step to `ratioEnd` at the last step (§3). Division-by-zero guarded for `maxLevel < 3`.
 */
function productionGrowth(config: GameConfig, def: BuildingDef, level: number): number {
  if (level <= 1) {
    return 1;
  }
  const { ratioStart, ratioEnd } = config.production;
  const denom = def.maxLevel - 2;
  let growth = 1;
  for (let i = 1; i < level; i += 1) {
    const stepRatio =
      denom <= 0 ? ratioStart : ratioStart + ((ratioEnd - ratioStart) * (i - 1)) / denom;
    growth *= stepRatio;
  }
  return growth;
}

/**
 * Hourly production of a single building at `level` (§3). 0 for non-producers or `level <= 0`;
 * clamps to `maxLevel` instead of throwing for a level above the cap.
 */
export function calcProductionPerHour(
  config: GameConfig,
  type: BuildingType,
  level: number,
): number {
  const def = config.buildings[type];
  if (!def.production || level <= 0) {
    return 0;
  }
  const clampedLevel = Math.min(level, def.maxLevel);
  const growth = productionGrowth(config, def, clampedLevel);
  return roundCost(def.production.basePerHour * growth * config.speed.production);
}

/** Gross hourly production of a settlement, bucketed by resource (§3). Food upkeep is NOT subtracted. */
export function calcSettlementProduction(config: GameConfig, buildings: BuildingLevels): Resources {
  const result = emptyResources();
  for (const building of buildings) {
    const def = config.buildings[building.type];
    if (!def?.production) {
      continue;
    }
    result[def.production.resource] += calcProductionPerHour(config, building.type, building.level);
  }
  return result;
}

/**
 * Hourly Food upkeep of a settlement (§4). Legacy shape: `sum(foodUpkeepWeight * level)`.
 * When `config.upkeep` is set (M1a.4b), each building instead contributes
 * `foodUpkeepWeight * upkeep.ratio ** (level - 1) * speed.production` — geometric in level
 * and scaled by the same speed multiplier production already gets, so upkeep's share of
 * gross Food output can grow with level instead of shrinking as production's own
 * (decelerating but still compounding) growth outpaces a merely linear upkeep sum.
 */
export function calcFoodUpkeepPerHour(config: GameConfig, buildings: BuildingLevels): number {
  const upkeep = config.upkeep;
  let total = 0;
  for (const building of buildings) {
    const def = config.buildings[building.type];
    if (!def) {
      continue;
    }
    total += upkeep
      ? def.foodUpkeepWeight * upkeep.ratio ** (building.level - 1) * config.speed.production
      : def.foodUpkeepWeight * building.level;
  }
  return total;
}

/** Gross Food production minus Food upkeep; may be negative (§4). */
export function calcNetFoodPerHour(config: GameConfig, buildings: BuildingLevels): number {
  return (
    calcSettlementProduction(config, buildings).food - calcFoodUpkeepPerHour(config, buildings)
  );
}

/**
 * True when replacing `type`'s current entry with `targetLevel` would drive net Food below zero
 * (§4). Does not mutate `buildings`.
 */
export function wouldStarveSettlement(
  config: GameConfig,
  buildings: BuildingLevels,
  type: BuildingType,
  targetLevel: number,
): boolean {
  const next = buildings.filter((b) => b.type !== type).concat([{ type, level: targetLevel }]);
  return calcNetFoodPerHour(config, next) < 0;
}

/** Per-resource storage caps: Warehouse gates scrap/fuel/electronics, Cold Storage gates Food (§5). */
export function calcStorageCaps(config: GameConfig, buildings: BuildingLevels): Resources {
  const warehouseLevel = levelOf(buildings, 'warehouse');
  const coldStorageLevel = levelOf(buildings, 'coldStorage');
  const generalCap = roundCost(
    config.storage.generalBase * config.storage.generalRatio ** warehouseLevel,
  );
  const foodCap = roundCost(config.storage.foodBase * config.storage.foodRatio ** coldStorageLevel);
  return {
    scrap: generalCap,
    fuel: generalCap,
    electronics: generalCap,
    food: foodCap,
  };
}

/** Prerequisites of `type` not yet satisfied by `buildings`, in catalogue order (§2). */
export function missingPrerequisites(
  config: GameConfig,
  buildings: BuildingLevels,
  type: BuildingType,
): BuildingRequirement[] {
  const def = config.buildings[type];
  return def.requires.filter((req) => levelOf(buildings, req.type) < req.level);
}

/** True when every prerequisite of `type` is satisfied by `buildings` (§2). */
export function meetsPrerequisites(
  config: GameConfig,
  buildings: BuildingLevels,
  type: BuildingType,
): boolean {
  return missingPrerequisites(config, buildings, type).length === 0;
}

/** Total Influence across every settlement of an account: `influenceWeight * level`, summed (§7). */
export function calcInfluence(
  config: GameConfig,
  settlements: ReadonlyArray<BuildingLevels>,
): number {
  let total = 0;
  for (const settlement of settlements) {
    for (const building of settlement) {
      const def = config.buildings[building.type];
      if (!def) {
        continue;
      }
      total += def.influenceWeight * building.level;
    }
  }
  return total;
}

/** Number of settlements an account may own at a given Influence total, capped at `maxSettlements` (§7). */
export function settlementsAllowed(config: GameConfig, influence: number): number {
  const thresholdsReached = config.influence.settlementThresholds.filter(
    (threshold) => influence >= threshold,
  ).length;
  return Math.min(1 + thresholdsReached, config.influence.maxSettlements);
}
