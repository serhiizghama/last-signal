import type { BuildingDef, BuildingType } from './types.js';

/**
 * First-pass building catalogue (§2, §5, §7). Values are draft numbers meant to be tuned
 * later by the balance simulator; the shapes (curve families, prerequisites, weights) are
 * final for v1.
 *
 * `foodUpkeepWeight` values were rescaled in M1a.4b (~0.1x of their original magnitude) to
 * pair with the new geometric-in-level, speed-scaled upkeep shape (`config.upkeep.ratio`,
 * see defaultConfig.ts and calcFoodUpkeepPerHour) — the old linear weights were sized for
 * `weight * level`; the new formula's own `ratio ** (level - 1) * speed.production` term
 * already supplies most of the growth, so the weights just set each building's relative
 * share.
 */
export const BUILDINGS: Record<BuildingType, BuildingDef> = {
  commandCenter: {
    type: 'commandCenter',
    family: 'functional',
    maxLevel: 20,
    baseCost: { scrap: 70, fuel: 40, electronics: 30, food: 20 },
    baseBuildTimeSec: 2500,
    foodUpkeepWeight: 0.2,
    requires: [],
    influenceWeight: 3,
  },
  scrapYard: {
    type: 'scrapYard',
    family: 'resource',
    maxLevel: 20,
    baseCost: { scrap: 40, fuel: 25, electronics: 10, food: 20 },
    baseBuildTimeSec: 260,
    foodUpkeepWeight: 0.1,
    requires: [],
    production: { resource: 'scrap', basePerHour: 5 },
    influenceWeight: 1,
  },
  fuelRefinery: {
    type: 'fuelRefinery',
    family: 'resource',
    maxLevel: 20,
    baseCost: { scrap: 50, fuel: 20, electronics: 10, food: 20 },
    baseBuildTimeSec: 280,
    foodUpkeepWeight: 0.1,
    requires: [],
    production: { resource: 'fuel', basePerHour: 5 },
    influenceWeight: 1,
  },
  electronicsWorkshop: {
    type: 'electronicsWorkshop',
    family: 'resource',
    maxLevel: 20,
    // scrap trimmed from 80 to 70 (M1a.4b): at costRatio 1.67 its L19 scrap cost (base *
    // 1.67^18) must fit under the max Warehouse-L20 cap (storage.generalBase *
    // storage.generalRatio^20 = 760,199); 80 would land at 816,557 (over), 70 lands at
    // 714,487 (fits, ~6% margin). See balance/storageCeiling.test.ts.
    baseCost: { scrap: 70, fuel: 60, electronics: 20, food: 30 },
    baseBuildTimeSec: 450,
    foodUpkeepWeight: 0.1,
    requires: [{ type: 'commandCenter', level: 3 }],
    production: { resource: 'electronics', basePerHour: 3 },
    influenceWeight: 1,
  },
  greenhouseFarm: {
    type: 'greenhouseFarm',
    family: 'resource',
    maxLevel: 20,
    baseCost: { scrap: 45, fuel: 25, electronics: 5, food: 15 },
    baseBuildTimeSec: 300,
    // A farm does not eat its own output.
    foodUpkeepWeight: 0,
    requires: [],
    production: { resource: 'food', basePerHour: 6 },
    influenceWeight: 1,
  },
  warehouse: {
    type: 'warehouse',
    family: 'functional',
    maxLevel: 20,
    baseCost: { scrap: 130, fuel: 60, electronics: 20, food: 20 },
    baseBuildTimeSec: 2000,
    foodUpkeepWeight: 0.2,
    requires: [],
    storage: 'general',
    influenceWeight: 1,
  },
  coldStorage: {
    type: 'coldStorage',
    family: 'functional',
    maxLevel: 20,
    baseCost: { scrap: 120, fuel: 50, electronics: 20, food: 20 },
    baseBuildTimeSec: 1800,
    foodUpkeepWeight: 0.2,
    requires: [],
    storage: 'food',
    influenceWeight: 1,
  },
  hiddenCache: {
    type: 'hiddenCache',
    family: 'functional',
    maxLevel: 10,
    baseCost: { scrap: 40, fuel: 20, electronics: 10, food: 10 },
    baseBuildTimeSec: 900,
    // 0 for the same reason as Barracks (see its comment): a policy filler that would
    // otherwise race to its max level under the geometric upkeep shape.
    foodUpkeepWeight: 0,
    requires: [],
    influenceWeight: 1,
  },
  wall: {
    type: 'wall',
    family: 'functional',
    maxLevel: 20,
    baseCost: { scrap: 110, fuel: 30, electronics: 0, food: 20 },
    baseBuildTimeSec: 1000,
    foodUpkeepWeight: 0,
    requires: [{ type: 'commandCenter', level: 1 }],
    influenceWeight: 1,
  },
  barracks: {
    type: 'barracks',
    family: 'functional',
    maxLevel: 20,
    baseCost: { scrap: 210, fuel: 140, electronics: 40, food: 60 },
    baseBuildTimeSec: 2000,
    // Zeroed in M1a.4b: the reference-player policy's storage/never-starve fall-through
    // (balance/referencePlayer.ts) treats Barracks as a cheap filler once producers are
    // momentarily unaffordable, so under the geometric upkeep shape it would race to a very
    // high level and its upkeep would compound catastrophically (garrisoned troops, not the
    // building shell, are the intended Food sink — that lands in M3 with actual upkeep-per-
    // troop). Kept at 0 until troops exist.
    foodUpkeepWeight: 0,
    requires: [{ type: 'commandCenter', level: 3 }],
    influenceWeight: 1,
  },
  market: {
    type: 'market',
    family: 'functional',
    maxLevel: 20,
    baseCost: { scrap: 80, fuel: 70, electronics: 60, food: 40 },
    baseBuildTimeSec: 1700,
    foodUpkeepWeight: 0.2,
    requires: [
      { type: 'commandCenter', level: 3 },
      { type: 'warehouse', level: 3 },
    ],
    influenceWeight: 1,
  },
  machineShop: {
    type: 'machineShop',
    family: 'functional',
    maxLevel: 20,
    baseCost: { scrap: 220, fuel: 260, electronics: 120, food: 70 },
    baseBuildTimeSec: 2800,
    foodUpkeepWeight: 0.3,
    requires: [
      { type: 'commandCenter', level: 5 },
      { type: 'barracks', level: 3 },
      { type: 'fuelRefinery', level: 5 },
    ],
    influenceWeight: 1,
  },
  radioTower: {
    type: 'radioTower',
    family: 'functional',
    maxLevel: 20,
    baseCost: { scrap: 180, fuel: 120, electronics: 200, food: 50 },
    baseBuildTimeSec: 2600,
    foodUpkeepWeight: 0.3,
    requires: [
      { type: 'commandCenter', level: 5 },
      { type: 'electronicsWorkshop', level: 3 },
    ],
    influenceWeight: 1,
  },
};
