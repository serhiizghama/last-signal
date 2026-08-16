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

/**
 * The three playable factions (M2 §7). Travian analogs: Teutons / Romans / Gauls. `game-core`
 * stays display-free — ids only; the client maps id -> i18n key / name / prose.
 */
export const FACTIONS = ['raiders', 'engineers', 'nomads'] as const;

export type Faction = (typeof FACTIONS)[number];

/**
 * All unit types shipped so far: the three faction scouts only (M2 §7). The other 12 units
 * (infantry, cavalry, siege, etc.) land in M3.
 */
export const UNIT_TYPES = ['lookout', 'surveyorDrone', 'falconer'] as const;

export type UnitType = (typeof UNIT_TYPES)[number];

/** A unit's gameplay role. Only `'scout'` exists until M3 adds the rest of the roster. */
export type UnitRole = 'scout';

export interface UnitDef {
  type: UnitType;
  faction: Faction;
  role: UnitRole;
  /** Cost to train one unit, at classic x1 (§7). */
  cost: Resources;
  /** Time to train one unit in seconds, at classic x1, before `speed.training` (§7). */
  baseTrainTimeSec: number;
  /** Fields per hour at classic x1, before `speed.travel` (see `travelTimeMs`, M2 §0). */
  speed: number;
  scoutAttack: number;
  scoutDefense: number;
  /** Hourly Food upkeep of one unit of this type, from the moment it is credited (§7). */
  foodUpkeepPerHour: number;
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
  /** The unit catalogue (M2 §7): the three faction scouts today, the full roster in M3. */
  units: Record<UnitType, UnitDef>;
  /** Scout-vs-scout combat loss curve and intel-tier gating (M2 §8). */
  scouting: ScoutingConfig;
  /** Movement send/cancel tuning (M2 §6). */
  movement: MovementConfig;
  map: MapConfig;
}

/** Movement (currently: scout) send/cancel tuning (M2 §6). */
export interface MovementConfig {
  /**
   * How long after send a movement can still be cancelled, in ms (Kirilloid/T4 recall
   * window). Draft 90 000 (90s) — a number, not a shape, so it's sweepable by `tools/sim`
   * like everything else in this file.
   */
  cancelWindowMs: number;
}

/** Scout resolution tuning: the casualty curve and the Radio Tower intel-tier gate (M2 §8). */
export interface ScoutingConfig {
  /**
   * Exponent of the Kirilloid-style casualty curve:
   * `lossFraction = min(1, (defPts / atkPts) ** lossExponent)`. Draft 1.5.
   */
  lossExponent: number;
  /**
   * Minimum Radio Tower level differential (`attackerTower - defenderTower`) at which the
   * `'buildings'` intel tier unlocks; below it, intel stays at `'base'`. Draft 1.
   */
  buildingsTierMinDiff: number;
}

/**
 * Draft terrain distribution `terrainAt` rolls against (M2 §2); values should sum to 1.
 * Terrain is cosmetic except one rule: toxic lake tiles cannot host a settlement.
 */
export interface MapTerrainWeights {
  wasteland: number;
  deadForest: number;
  rockyHills: number;
  ruinedCity: number;
  brokenHighway: number;
  toxicLake: number;
}

/** Map geometry, terrain, oasis and spawn tuning (M2 §1, §2, §3). */
export interface MapConfig {
  /** Grid half-width: both axes run `-radius..radius` (61x61 for radius 30, §1). */
  radius: number;
  terrainWeights: MapTerrainWeights;
  /** Farm oases: placed once at world generation, deterministic from the world seed (§2). */
  oases: {
    count: number;
    /** Minimum pairwise Chebyshev distance kept between any two placed oases. */
    minDistance: number;
    /** Tiles kept clear at the grid edge: no oasis where `max(|x|, |y|) > radius - edgeMargin`. */
    edgeMargin: number;
  };
  /** Center-out expanding annulus spawn policy, shared by humans and NPCs alike (§3). */
  spawn: {
    /** Base term of `R(n) = min(maxRadius, baseRadius + ceil(growthCoefficient * sqrt(n)))`. */
    baseRadius: number;
    growthCoefficient: number;
    /** Width of the annulus `[max(0, R(n) - bandWidth), R(n)]` candidates are drawn from. */
    bandWidth: number;
    maxRadius: number;
  };
  /** Settleability tuning beyond terrain/oasis (§3). */
  settlement: {
    /** Minimum Chebyshev distance a new settlement must keep from every existing one. */
    minDistance: number;
  };
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
