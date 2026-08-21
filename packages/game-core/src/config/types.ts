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
  /**
   * Added in M3b.1 (M3 §5 step 3): the Wall *building's* defence multiplier in regular battle
   * resolution — top-level and distinct from `buildings.wall`, which is the Wall's cost/level
   * curve definition (`BuildingDef`). Kept top-level (not nested under `buildings.wall`)
   * because it is battle tuning, not a building-progression curve, and because §5 names it
   * `wall.defenseRatioPerLevel` exactly. Later M3 steps add sibling top-level `hiddenCache`
   * (§6 loot protection) and `siege` (§7 resistance curve) blocks the same way.
   */
  wall: WallConfig;
  /**
   * Added in M3b.2 (§6 of the M3 design record): the Hidden Cache *building's* per-resource
   * loot protection — top-level and distinct from `buildings.hiddenCache`, which is the
   * building's cost/level curve definition (`BuildingDef`), for the same reason `wall` above
   * is kept top-level rather than nested under `buildings.wall`: this is raid tuning, not a
   * building-progression curve.
   */
  hiddenCache: HiddenCacheConfig;
  /**
   * Added in M3b.3 (§7 of the M3 design record): the siege pass's per-level resistance curve
   * and the Command Center floor — top-level and distinct from `buildings.wall` /
   * `buildings.commandCenter` (their cost/level curve definitions), for the same reason
   * `wall` and `hiddenCache` above are kept top-level rather than nested under `buildings.*`:
   * this is siege/combat tuning, not a building-progression curve.
   */
  siege: SiegeConfig;
  /** Movement send/cancel tuning (M2 §6). */
  movement: MovementConfig;
  /** Per-building-level training-time tuning (M3 §2). */
  training: TrainingConfig;
  /**
   * Added in M3c.1 (§10 of the M3 design record): the oasis wildlife garrison's target size and
   * lazy regeneration. Top-level and distinct from any `buildings.*` block — there is no oasis
   * "building" — for the same reason `wall` / `hiddenCache` / `siege` above are kept top-level:
   * this is raid/economy tuning, not a building-progression curve.
   */
  oasis: OasisConfig;
  /**
   * Added in M3c.1 (§12 of the M3 design record): the Radio Tower's incoming-attack detail
   * tiers. Top-level and distinct from `buildings.radioTower` (its cost/level curve), for the
   * same reason `oasis` above is kept top-level.
   */
  radioTower: RadioTowerConfig;
  /**
   * Added in M3c.1 (§11 of the M3 design record): beginner-protection duration, read from the
   * account's first-settlement creation instant — no building governs it.
   */
  protection: ProtectionConfig;
  /**
   * Added in M3d.1 (§13 of the M3 design record): the settler convoy's Influence-gated
   * founding. Top-level and distinct from any `buildings.*` block — there is no "settle"
   * building — for the same reason `oasis` / `radioTower` / `protection` above are kept
   * top-level: this is convoy/founding tuning, not a building-progression curve. The
   * Influence gate itself stays exactly `config.influence` (M1 §7, unchanged) — this block
   * only adds the one new number §13 needs on top of it.
   */
  settle: SettleConfig;
  /**
   * Added in M3d.2 (§14 of the M3 design record): the offer board's own tuning — merchant
   * count per Market level, the offer ratio cap, offer TTL, the weighted-value table the
   * ratio cap and the world exchange both read, and the exchange's own spread/trip time.
   * Top-level and distinct from `buildings.market` (the Market building's cost/level curve),
   * for the same reason `oasis` / `radioTower` / `protection` / `settle` above are kept
   * top-level: this is market/economy tuning, not a building-progression curve. Landed as one
   * block covering the whole of §14 — including `exchangeSpread`/`exchangeTripMs`, which
   * M3d.2 has no reader for (see `MarketConfig`'s own field comments) — rather than two
   * separate edits, the same call M3c.1 made landing `oasis`/`radioTower`/`protection`
   * together.
   */
  market: MarketConfig;
  /**
   * Added in M3d.2 (§14): merchants are not units (§14 is explicit about this) — no cost, no
   * training path, no `config.units` entry. Just a faction-flavoured capacity and speed,
   * looked up here. Top-level for the same reason `market` above is.
   */
  merchant: MerchantConfig;
  map: MapConfig;
}

/**
 * Added in M3d.2 (§14 of the M3 design record): the Market board's tuning. See
 * `GameConfig.market` for why this lives top-level rather than under `buildings.market`.
 */
export interface MarketConfig {
  /** Merchants per settlement = `merchantsPerLevel * Market level` (§14). Draft 1. */
  merchantsPerLevel: number;
  /**
   * The offer ratio cap (§14): `1/maxOfferRatio <= give/want <= maxOfferRatio`, in weighted
   * value (`valueWeights` below). Draft 2 -> an offer may ask for as little as half, or as
   * much as double, what it gives, in weighted terms — see `isOfferRatioLegal`'s own comment
   * for the boundary convention (is exactly the ratio itself legal).
   */
  maxOfferRatio: number;
  /** How long a posted offer stays open before `tradeOfferExpire` fires (§14). Draft 48h in ms. */
  offerTtlMs: number;
  /**
   * Weighted value per unit of each resource kind — shared by the ratio cap above AND (M3d.4)
   * the world exchange's own conversion math, per §14: "draft `valueWeights = {scrap 1, fuel
   * 1, food 1, electronics 2}`". Electronics is weighted double, same rationale M1 §1 already
   * gives for making it the game's deliberate bottleneck.
   */
  valueWeights: Record<ResourceKind, number>;
  /**
   * The world exchange's spread (§14: every conversion loses this fraction of value, which is
   * what lets the exchange need no daily cap or cooldown). **NO READER YET in M3d.2** — the
   * world exchange itself is M3d.4's deliverable. Landed now, with the rest of this block, per
   * the M3d.2 brief's "one config edit is cleaner than two" (M3c.1's own precedent). Draft
   * 0.25.
   */
  exchangeSpread: number;
  /**
   * How long the world exchange occupies merchants per conversion (§14) — nothing travels the
   * map for it (no counterparty), it just ties up merchant capacity for this long. **NO
   * READER YET in M3d.2** — see `exchangeSpread` above for why this field exists already
   * regardless. Draft 30min in ms.
   */
  exchangeTripMs: number;
}

/**
 * Added in M3d.2 (§14 of the M3 design record): merchant capacity and speed, by faction. See
 * `GameConfig.merchant` for why this lives top-level rather than as a `config.units` entry.
 */
export interface MerchantConfig {
  /** Loot/carry capacity per merchant, by faction (§14's table). Draft 1000/500/750. */
  capacityByFaction: Record<Faction, number>;
  /** Merchant travel speed, fields/hour at classic x1, by faction (§14's table). Draft 12/16/24. */
  speedByFaction: Record<Faction, number>;
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
  /**
   * Added in M3b.1 (M3 §5 step 4): the deterministic ±5% roll applied to `atkPts` before the
   * loss curve — `atkPts *= 1 + randomFactor * r`, `r` from `battleRoll` (`combat/roll.ts`).
   * Draft 0.05. A number, sweepable by `tools/sim` like everything else in this file.
   */
  randomFactor: number;
}

/**
 * Added in M3b.1 (M3 §5 step 3): the Wall building's battle-defence multiplier. See the
 * `wall` field on `GameConfig` for why this lives top-level rather than under `buildings.wall`.
 */
export interface WallConfig {
  /** `wallFactor = defenseRatioPerLevel ** wallLevel`, applied to `defPts`. Draft 1.03. */
  defenseRatioPerLevel: number;
}

/**
 * Added in M3b.2 (§6 of the M3 design record): the Hidden Cache building's per-resource loot
 * protection. See the `hiddenCache` field on `GameConfig` for why this lives top-level rather
 * than under `buildings.hiddenCache`.
 */
export interface HiddenCacheConfig {
  /** Protection at level 1: `base * ratio ** (level - 1)`. Draft 200. Level 0 -> 0 (no cache). */
  base: number;
  /** Per-level protection multiplier. Draft 1.35 -> L5 = 664.30125, L10 = 2978.749…. */
  ratio: number;
}

/**
 * Added in M3b.3 (§7 of the M3 design record): the siege pass's resistance curve and the
 * Command Center's destruction floor. See the `siege` field on `GameConfig` for why this
 * lives top-level rather than under `buildings.wall` / `buildings.commandCenter`.
 */
export interface SiegeConfig {
  /** Cost of knocking level 1 off any building or the wall: `base * ratio ** (level - 1)`. Draft 6. */
  resistanceBase: number;
  /** Per-level resistance multiplier. Draft 1.18 -> L10 costs 26.6127…, L7 costs 16.1973…. */
  resistanceRatio: number;
  /** The Command Center can never be knocked below this level (owner decision 4). Draft 1. */
  commandCenterFloor: number;
}

/**
 * Added in M3c.1 (§10 of the M3 design record): the oasis wildlife garrison's target size and
 * its lazy regeneration. See `GameConfig.oasis` for why this lives top-level.
 */
export interface OasisConfig {
  /**
   * Target wildlife garrison, rolled deterministically per oasis from the world seed and its
   * coordinates (`oasisTargetDefenders`, §10). `base + floor(draw * rollRange)` encodes §10's
   * "`12 + roll(0..12)`" shape — **`rollRange` is the number of distinct values the roll can
   * land on, not the maximum offset.** `12 + roll(0..12)` draws 13 distinct values (12..24
   * inclusive), so it is `rollRange: 13`, not `rollRange: 12`; reading it as 12 is the natural
   * mistake here and would silently narrow every oasis garrison in the world by dropping its
   * top value. Likewise Scavenger Gangs' `4 + roll(0..6)` is `rollRange: 7`, not 6.
   */
  defenders: {
    /** Draft base 12, rollRange 13 -> 12..24 Feral Dogs inclusive. */
    feralDog: { base: number; rollRange: number };
    /** Draft base 4, rollRange 7 -> 4..10 Scavenger Gangs inclusive. */
    scavengerGang: { base: number; rollRange: number };
  };
  /** Lazy regeneration (§10), settled the same way settlement resources already are (M1 §4). */
  regen: {
    /**
     * One unit of EACH defender type credited per this interval, up to the target composition —
     * never past it. A type already at target gains nothing. Draft 2h in ms.
     */
    defenderIntervalMs: number;
    /** Food added to the lootable pool per hour; fractional accrual, like every other rate. Draft 120. */
    foodPerHour: number;
    /** Hard cap on the lootable Food pool. Draft 4000. */
    foodCap: number;
  };
}

/**
 * Added in M3c.1 (§12 of the M3 design record): the Radio Tower level thresholds that gate
 * incoming-attack detail. See `GameConfig.radioTower` for why this lives top-level.
 */
export interface RadioTowerConfig {
  /**
   * Minimum Radio Tower level for the `'kind'` and `'full'` incoming-detail tiers
   * (`incomingDetailTier`, §12). The base `'existence'` tier — that an attack is inbound, its
   * arrival time, and its origin tile + owner — is never gated by any level, including 0; these
   * two thresholds only decide when the tiers *above* it unlock. Draft kind 1, full 5.
   */
  incomingTiers: { kind: number; full: number };
}

/**
 * Added in M3c.1 (§11 of the M3 design record): beginner-protection duration. See
 * `GameConfig.protection` for why this lives top-level.
 */
export interface ProtectionConfig {
  /** How long protection holds from the account's first settlement being created (§11). Draft 72h in ms. */
  durationMs: number;
}

/**
 * Added in M3d.1 (§13 of the M3 design record): the settler convoy's Influence-gated
 * founding. See `GameConfig.settle` for why this lives top-level.
 */
export interface SettleConfig {
  /**
   * Settlers required — and consumed — to found a new settlement (owner decision 3: "Three
   * 'Settler' units, trained at the Command Center"). Draft 3, sweepable by tools/sim in M4
   * like everything else in this file. The Influence threshold that gates *whether* an
   * account may found at all is unaffected by this number — it lives in `config.influence`
   * (M1 §7) and is checked via `calcInfluence`/`settlementsAllowed`, never here.
   */
  settlersRequired: number;
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
