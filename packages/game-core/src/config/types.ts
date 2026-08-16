import type { ResourceKind, Resources } from '../types.js';

/** All building types in v1. Order is stable and used for deterministic iteration. */
export const BUILDING_TYPES = [
  'commandCenter',
  'scrapYard',
  'fuelRefinery',
  'electronicsWorkshop',
  'greenhouseFarm',
  'warehouse',
  'coldStorage',
  'hiddenCache',
  'wall',
  'barracks',
  'market',
  'machineShop',
  'radioTower',
] as const;

export type BuildingType = (typeof BUILDING_TYPES)[number];

/** Two curve families (§2): cheap-base/steep-growth `resource`, dearer-base/flatter `functional`. */
export type CurveFamily = 'resource' | 'functional';

/** A single prerequisite: `type` must be at least `level` before building/upgrading. */
export interface BuildingRequirement {
  type: BuildingType;
  level: number;
}

export interface BuildingProduction {
  resource: ResourceKind;
  /** Per-hour output at level 1, at classic x1 speed, before the speed multiplier. */
  basePerHour: number;
}

export interface BuildingDef {
  type: BuildingType;
  family: CurveFamily;
  /** Highest reachable level (20 for everything except Hidden Cache: 10). */
  maxLevel: number;
  /** Cost of reaching level 1, at classic x1. Higher levels scale by the family ratio. */
  baseCost: Resources;
  /** Build time of level 1 in seconds, at classic x1, before speed and Command Center. */
  baseBuildTimeSec: number;
  /** Hourly Food upkeep of this building = weight x level. */
  foodUpkeepWeight: number;
  /** Prerequisites; empty for buildings with none. */
  requires: readonly BuildingRequirement[];
  /** Present only for the four resource buildings. */
  production?: BuildingProduction;
  /** Present only for Warehouse ('general') and Cold Storage ('food'). */
  storage?: 'general' | 'food';
  /** Influence weight per level: 3 for the Command Center, 1 for everything else. */
  influenceWeight: number;
}

export interface CurveParams {
  /** Per-level cost multiplier. */
  costRatio: number;
  /** Per-level build-time multiplier. */
  timeRatio: number;
}

export interface SpeedConfig {
  build: number;
  production: number;
  training: number;
  travel: number;
}

export interface GameConfig {
  /** Archived alongside each finished season so past seasons keep their original balance. */
  configVersion: number;
  speed: SpeedConfig;
  curves: Record<CurveFamily, CurveParams>;
  /**
   * Production growth decelerates with level: the per-level multiplier interpolates
   * linearly from `ratioStart` (level 1 -> 2) to `ratioEnd` (level maxLevel-1 -> maxLevel).
   */
  production: { ratioStart: number; ratioEnd: number };
  storage: {
    /** Cap for scrap/fuel/electronics with no Warehouse built (level 0). */
    generalBase: number;
    generalRatio: number;
    /** Food cap with no Cold Storage built (level 0). */
    foodBase: number;
    foodRatio: number;
  };
  commandCenter: {
    /** Per-level build-time multiplier applied to every other building. */
    buildTimeRatio: number;
  };
  /**
   * Optional Food-upkeep shape (§4, M1a.4b). When present, `calcFoodUpkeepPerHour` scales
   * each building's upkeep geometrically with level (`ratio ** (level - 1)`) and by
   * `speed.production`, so upkeep keeps pace with production's own speed multiplier and
   * grows its *share* of output over time instead of falling behind production's
   * compounding per-level growth. When absent, upkeep is the legacy `weight * level` sum.
   */
  upkeep?: {
    ratio: number;
  };
  influence: {
    /** Influence needed for settlement #2 and #3; index 0 is settlement #2. */
    settlementThresholds: readonly number[];
    maxSettlements: number;
  };
  buildings: Record<BuildingType, BuildingDef>;
}

/** Fixed number of building slots per settlement (spatial-ready schema, §8). */
export const SETTLEMENT_SLOTS = 16;

/** One placed building instance within a settlement's fixed slot grid (§8). */
export interface SettlementBuilding {
  id: string;
  type: BuildingType;
  level: number;
  slot: number;
}

/** The read-only shape formulas accept. */
export type BuildingLevels = ReadonlyArray<Pick<SettlementBuilding, 'type' | 'level'>>;
