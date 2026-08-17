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
 * The full unit roster (M3 §1): the three faction scouts shipped in M2, widened to all 18
 * types — offence infantry, defence infantry, fast (cavalry analog) and siege for each of the
 * three factions, plus the faction-neutral Settler and two wildlife oasis-defender types.
 * Order is stable (relied on for deterministic iteration) and follows the design record's
 * table order: grouped by faction, then the neutral Settler, then wildlife.
 */
export const UNIT_TYPES = [
  'brute',
  'torcher',
  'lookout',
  'biker',
  'ramTruck',
  'exoTrooper',
  'bulwark',
  'surveyorDrone',
  'armoredQuad',
  'railSling',
  'skirmisher',
  'hunterSniper',
  'falconer',
  'duneBuggy',
  'ballistaWagon',
  'settler',
  'feralDog',
  'scavengerGang',
] as const;

export type UnitType = (typeof UNIT_TYPES)[number];

/** A unit's gameplay role (M3 §1 widens this from the M2 scout-only union). */
export type UnitRole =
  'offenseInfantry' | 'defenseInfantry' | 'fast' | 'scout' | 'siege' | 'settler' | 'wildlife';

export interface UnitDef {
  type: UnitType;
  /**
   * `Faction | null` (M3 §1): `null` marks a unit no account can train *by faction lock* —
   * the two wildlife types (no training path at all, see `trainedIn` below) and the Settler
   * (trainable by every faction, so it has no single faction to lock to). Overloading
   * `faction` with a third "any faction" sentinel would need a state beyond the design
   * record's fixed `Faction | null` union; `trainedIn` already carries the "who can train
   * this" information precisely, so the faction-lock rule reads naturally as "a unit with a
   * `faction` must match yours; a trainable unit without one is open to everybody".
   */
  faction: Faction | null;
  role: UnitRole;
  /** Cost to train one unit, at classic x1 (§7). */
  cost: Resources;
  /** Time to train one unit in seconds, at classic x1, before `speed.training` (§7). */
  baseTrainTimeSec: number;
  /** Fields per hour at classic x1, before `speed.travel` (see `travelTimeMs`, M2 §0). */
  speed: number;
  /** Regular battle attack points (M3 §0, §5); 0 for scouts (barred from raid/assault armies). */
  attack: number;
  /** Regular battle defence points against an attacker's infantry-split attack (M3 §0, §5). */
  defInfantry: number;
  /** Regular battle defence points against an attacker's cavalry-split attack (M3 §0, §5). */
  defCavalry: number;
  /** Loot capacity per surviving unit on a raid/assault (M3 §6); 0 for units that never loot. */
  carry: number;
  /**
   * Which side of the defender's infantry/cavalry split this unit's *attack* counts toward
   * when it is the attacker (M3 §5 step 1). Only the three `fast` units are `'cavalry'`.
   */
  splitClass: 'infantry' | 'cavalry';
  /**
   * Scout-vs-scout attack/defense points (M2 §8) — a separate system from `attack`/
   * `defInfantry`/`defCavalry` above, kept required (not optional) and 0 for every non-scout
   * unit rather than undefined. `calcTroopScoutAttack`/`calcTroopScoutDefense` sum over a
   * whole troop list, and a settlement's home garrison now mixes combat units with scouts;
   * 0 keeps those functions total *and* keeps M2's shipped scout-vs-scout maths
   * bit-identical — only scouts contribute to scout combat, exactly as before. A non-zero
   * value here would silently change a shipped system.
   */
  scoutAttack: number;
  scoutDefense: number;
  /** Hourly Food upkeep of one unit of this type, from the moment it is credited (§7). */
  foodUpkeepPerHour: number;
  /**
   * The building that trains this unit (M3 §2). Absent for the two wildlife types — the
   * field, not `faction`, is what actually decides trainability (see the `faction` comment
   * above): the Settler has `faction: null` but a real `trainedIn` and is trainable by all.
   */
  trainedIn?: BuildingType;
  /** Wall damage dealt per surviving siege unit on an assault (M3 §7); siege units only. */
  wallDamage?: number;
  /** Building damage dealt per surviving siege unit on an assault (M3 §7); siege units only. */
  buildingDamage?: number;
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
  /** The unit catalogue (M2 §7, widened to the full 18-type roster in M3 §1). */
  units: Record<UnitType, UnitDef>;
  /** Scout-vs-scout intel-tier gating (M2 §8); the shared loss curve now lives in `combat`. */
  scouting: ScoutingConfig;
  /** Regular-battle tuning shared by every combat resolution (M3 §0, §5). */
  combat: CombatConfig;
  /** Movement send/cancel tuning (M2 §6). */
  movement: MovementConfig;
  /** Per-building-level training-time tuning (M3 §2). */
  training: TrainingConfig;
  map: MapConfig;
}

/**
 * Training-time tuning (M3 §2, `docs/M3_DESIGN_DECISIONS.md`). Added in M3a.2 so Barracks
 * (and the other training buildings) levels stop being dead weight once training is no
 * longer scout-only.
 */
export interface TrainingConfig {
  /**
   * Per-level training-time multiplier, mirroring the Command Center's `buildTimeRatio`
   * shape (`calcBuildTimeMs`): `timeFactor = buildingTimeRatio ** (level - 1)`. Draft 0.91 ->
   * a level-20 training building is `1 / 0.91^19 = 6.0x` faster than level 1. A number,
   * sweepable by `tools/sim` in M4 like everything else in this file.
   */
  buildingTimeRatio: number;
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

/**
 * Scout resolution tuning: the Radio Tower intel-tier gate (M2 §8). `lossExponent` used to
 * live here but was promoted to the shared `combat.lossExponent` in M3 §5 — one curve family
 * for the whole game, so a player who has learned to read scout losses can read battle losses
 * too. Scout-vs-scout resolution (`scouting/combat.ts`) now reads `config.combat.lossExponent`.
 */
export interface ScoutingConfig {
  /**
   * Minimum Radio Tower level differential (`attackerTower - defenderTower`) at which the
   * `'buildings'` intel tier unlocks; below it, intel stays at `'base'`. Draft 1.
   */
  buildingsTierMinDiff: number;
}

/** Regular-battle tuning shared across every combat resolution (M3 §0, §5). */
export interface CombatConfig {
  /**
   * Exponent of the Kirilloid-style casualty curve, shared with scout-vs-scout resolution:
   * `x = min(1, (defPts / atkPts) ** lossExponent)`. Draft 1.5 — the same constant M2 §8
   * already shipped for scouts, promoted here rather than duplicated (M3 §5).
   */
  lossExponent: number;
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
