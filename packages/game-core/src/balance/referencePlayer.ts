import {
  BUILDING_TYPES,
  type BuildingType,
  type GameConfig,
  type SettlementBuilding,
} from '../config/index.js';
import { HOUR_MS, calcNetRates, settleResources, type ResourceState } from '../economy/index.js';
import {
  calcBuildCost,
  calcBuildTimeMs,
  calcInfluence,
  calcNetFoodPerHour,
  calcSettlementProduction,
  calcStorageCaps,
  meetsPrerequisites,
  wouldStarveSettlement,
} from '../formulas/index.js';
import { canAfford, emptyResources, subtractResources } from '../numeric.js';
import { RESOURCE_KINDS, type Resources } from '../types.js';

/** One simulated day, in ms; production/build formulas are all expressed per hour. */
const DAY_MS = 24 * HOUR_MS;

/**
 * Raiding ramp window (harness-only stand-in, see `raidMultiplierAt`): no raid income
 * before 72h (beginner protection), full ramp reached at day 10.
 */
const RAID_RAMP_START_MS = 3 * DAY_MS;
const RAID_RAMP_END_MS = 10 * DAY_MS;

/**
 * Starting resource endowment for a brand-new settlement (Command Center L1, nothing
 * else built). Not specified anywhere in the design docs; with zero resources and zero
 * production (the Command Center itself produces nothing) the settlement would be
 * permanently deadlocked, so some bootstrap stock is required for the harness to move
 * at all. Chosen well above the cost of the first Greenhouse Farm level (the mandatory
 * first build, see the never-starve policy rule) and negligible against day-21 output.
 * Judgment call — see the report for this step.
 */
const STARTING_RESOURCES: Resources = { scrap: 500, fuel: 500, electronics: 500, food: 500 };

/** The four production buildings, in catalogue order; round-robin ties break on this order. */
const PRODUCER_TYPES: readonly BuildingType[] = [
  'scrapYard',
  'fuelRefinery',
  'electronicsWorkshop',
  'greenhouseFarm',
];

/** A deterministic daily login/raiding pattern for one of the three named reference players. */
export interface PlayerProfile {
  id: 'casual' | 'regular' | 'hardcore';
  /** Login instants within a day, as hours since local midnight, ascending. Deterministic. */
  loginHours: readonly number[];
  /** Stand-in for raid income until combat exists: production multiplier at full ramp. */
  raidIncomeMultiplier: number;
}

/** The three named reference players from the progression contract (§0). */
export const REFERENCE_PROFILES: Record<PlayerProfile['id'], PlayerProfile> = {
  casual: {
    id: 'casual',
    loginHours: [8, 20],
    raidIncomeMultiplier: 1.1,
  },
  regular: {
    id: 'regular',
    loginHours: [7, 11, 15, 19, 22],
    raidIncomeMultiplier: 1.25,
  },
  hardcore: {
    id: 'hardcore',
    loginHours: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22],
    raidIncomeMultiplier: 1.45,
  },
};

/** A fast-forwarded settlement's state at the end of one simulated day. */
export interface DaySnapshot {
  day: number;
  buildings: SettlementBuilding[];
  topResourceLevel: number;
  resourceLevels: Record<BuildingType, number>;
  commandCenterLevel: number;
  grossProductionPerHour: Resources;
  netFoodPerHour: number;
  influence: number;
  /** Cumulative resources that production could not accrue because storage was full. */
  wastedToOverflow: Resources;
  /** Cumulative ms the build queue sat completely idle while the player was "awake". */
  idleQueueMs: number;
  /**
   * Settled resource stock at the end of this day. Not part of the originally specified
   * `DaySnapshot` shape; added because verifying "resources never negative / never exceed
   * caps" is impossible through the rest of the public surface. Purely additive — see report.
   */
  resources: Resources;
}

/** The full trajectory of one reference-player fast-forward. */
export interface SimulationResult {
  profile: PlayerProfile['id'];
  days: DaySnapshot[];
  final: DaySnapshot;
}

/** One item in the settlement's build queue; only the front item has timing assigned. */
interface QueueItem {
  type: BuildingType;
  level: number;
  startAt: number | null;
  completeAt: number | null;
}

/** Current level of `type` in the completed-buildings list, or 0 when not yet built. */
function completedLevelOf(buildings: readonly SettlementBuilding[], type: BuildingType): number {
  const found = buildings.find((b) => b.type === type);
  return found ? found.level : 0;
}

/** How many queue entries (active + waiting) target `type`. */
function queuedCountOf(queue: readonly QueueItem[], type: BuildingType): number {
  return queue.filter((q) => q.type === type).length;
}

/** Completed level plus everything already queued for `type` — "as if the queue finished". */
function effectiveLevelOf(
  buildings: readonly SettlementBuilding[],
  queue: readonly QueueItem[],
  type: BuildingType,
): number {
  return completedLevelOf(buildings, type) + queuedCountOf(queue, type);
}

/** Building list projected as if every currently queued upgrade had already completed. */
function effectiveBuildingsList(
  buildings: readonly SettlementBuilding[],
  queue: readonly QueueItem[],
): Array<{ type: BuildingType; level: number }> {
  const result: Array<{ type: BuildingType; level: number }> = [];
  for (const type of BUILDING_TYPES) {
    const level = effectiveLevelOf(buildings, queue, type);
    if (level > 0) {
      result.push({ type, level });
    }
  }
  return result;
}

/**
 * Raid income ramp (harness modelling assumption, not part of game-core): 1.0 (no raiding)
 * before the 72h beginner-protection window, ramping linearly to the profile's full-ramp
 * multiplier by day 10, constant after.
 */
function raidMultiplierAt(profile: PlayerProfile, t: number): number {
  if (t < RAID_RAMP_START_MS) {
    return 1;
  }
  if (t >= RAID_RAMP_END_MS) {
    return profile.raidIncomeMultiplier;
  }
  const frac = (t - RAID_RAMP_START_MS) / (RAID_RAMP_END_MS - RAID_RAMP_START_MS);
  return 1 + frac * (profile.raidIncomeMultiplier - 1);
}

/** A type in this set is off the table for the current enqueue attempt (see `pickBuildTarget`). */
type ExcludedTypes = ReadonlySet<BuildingType>;

const NO_EXCLUSIONS: ExcludedTypes = new Set();

/**
 * How many levels the Command Center is allowed to trail the current top producer before the
 * policy prioritises raising it again (see the third Command Center rule below).
 */
const CC_LAG_LEVELS = 3;

/**
 * Default build target before the never-starve / storage guards are applied: Command
 * Center schedule (rule 3), storage minimums (rule 5), round-robin resource buildings with
 * a Command Center redirect when a prerequisite blocks the pick (rules 3+4), then cheap
 * sinks (rule 6). `excluded` removes candidates already tried and rejected this attempt
 * (unaffordable, starved with no redirect, over an un-fixable storage cap) so the caller can
 * fall through to the next-best pick instead of abandoning the login (see `pickBuildTarget`).
 */
function planDefaultCandidate(
  config: GameConfig,
  day: number,
  buildings: readonly SettlementBuilding[],
  queue: readonly QueueItem[],
  excluded: ExcludedTypes = NO_EXCLUSIONS,
): { type: BuildingType; level: number } | null {
  const eff = (type: BuildingType): number => effectiveLevelOf(buildings, queue, type);
  const maxLv = (type: BuildingType): number => config.buildings[type].maxLevel;

  const ccEff = eff('commandCenter');
  if (!excluded.has('commandCenter') && ccEff < maxLv('commandCenter')) {
    if (day >= 3 && ccEff < 3) {
      return { type: 'commandCenter', level: ccEff + 1 };
    }
    if (day >= 8 && ccEff < 5) {
      return { type: 'commandCenter', level: ccEff + 1 };
    }
    // Rule 3, continued: a maxed-at-5 Command Center was a harness artefact, not a policy
    // choice — a competent player keeps raising it forever, because every subsequent build
    // (calcBuildTimeMs) gets cheaper for the rest of the game. Keep it within CC_LAG_LEVELS
    // of the current top producer rather than parking it once the early unlocks are done.
    const topProducerEff = Math.max(...PRODUCER_TYPES.map((t) => eff(t)));
    if (ccEff <= topProducerEff - CC_LAG_LEVELS) {
      return { type: 'commandCenter', level: ccEff + 1 };
    }
  }

  const whEff = eff('warehouse');
  if (!excluded.has('warehouse') && day >= 2 && whEff < 1 && maxLv('warehouse') >= 1) {
    return { type: 'warehouse', level: 1 };
  }
  const csEff = eff('coldStorage');
  if (!excluded.has('coldStorage') && day >= 2 && csEff < 1 && maxLv('coldStorage') >= 1) {
    return { type: 'coldStorage', level: 1 };
  }

  let lowest: { type: BuildingType; level: number } | null = null;
  for (const type of PRODUCER_TYPES) {
    if (excluded.has(type)) {
      continue;
    }
    const level = eff(type);
    if (level >= maxLv(type)) {
      continue;
    }
    if (lowest === null || level < lowest.level) {
      lowest = { type, level };
    }
  }
  if (lowest) {
    if (
      lowest.type === 'electronicsWorkshop' &&
      !meetsPrerequisites(config, buildings, 'electronicsWorkshop')
    ) {
      if (!excluded.has('commandCenter') && ccEff < maxLv('commandCenter')) {
        return { type: 'commandCenter', level: ccEff + 1 };
      }
    } else {
      return { type: lowest.type, level: lowest.level + 1 };
    }
  }

  const barracksEff = eff('barracks');
  if (
    !excluded.has('barracks') &&
    barracksEff < maxLv('barracks') &&
    meetsPrerequisites(config, buildings, 'barracks')
  ) {
    return { type: 'barracks', level: barracksEff + 1 };
  }
  const hiddenEff = eff('hiddenCache');
  if (!excluded.has('hiddenCache') && hiddenEff < maxLv('hiddenCache')) {
    return { type: 'hiddenCache', level: hiddenEff + 1 };
  }
  return null;
}

/**
 * Rule 1 (never starve): redirects to Greenhouse Farm — or, if that is maxed, to a cheap
 * sink — when `candidate` would drive net Food below zero. Projects against every building
 * currently queued, not just completed ones, so several concurrently queued upkeep-heavy
 * upgrades can never compound into starvation between checks. Redirect targets already in
 * `excluded` are skipped rather than retried, so a dead end here is reported as a dead end
 * (`null`) instead of looping back onto something the caller already rejected.
 */
function applyStarvationGuard(
  config: GameConfig,
  buildings: readonly SettlementBuilding[],
  queue: readonly QueueItem[],
  candidate: { type: BuildingType; level: number },
  excluded: ExcludedTypes = NO_EXCLUSIONS,
): { type: BuildingType; level: number } | null {
  const eff = (type: BuildingType): number => effectiveLevelOf(buildings, queue, type);
  const maxLv = (type: BuildingType): number => config.buildings[type].maxLevel;
  const projected = effectiveBuildingsList(buildings, queue);

  if (!wouldStarveSettlement(config, projected, candidate.type, candidate.level)) {
    return candidate;
  }

  const ghEff = eff('greenhouseFarm');
  if (!excluded.has('greenhouseFarm') && ghEff < maxLv('greenhouseFarm')) {
    return { type: 'greenhouseFarm', level: ghEff + 1 };
  }

  const barracksEff = eff('barracks');
  if (
    !excluded.has('barracks') &&
    barracksEff < maxLv('barracks') &&
    meetsPrerequisites(config, buildings, 'barracks') &&
    !wouldStarveSettlement(config, projected, 'barracks', barracksEff + 1)
  ) {
    return { type: 'barracks', level: barracksEff + 1 };
  }
  const hiddenEff = eff('hiddenCache');
  if (
    !excluded.has('hiddenCache') &&
    hiddenEff < maxLv('hiddenCache') &&
    !wouldStarveSettlement(config, projected, 'hiddenCache', hiddenEff + 1)
  ) {
    return { type: 'hiddenCache', level: hiddenEff + 1 };
  }
  return null;
}

/**
 * Rule 2 (keep storage ahead of costs): redirects to Cold Storage (Food is the offender)
 * or Warehouse (any other resource) when `candidate`'s cost exceeds the *current* cap. When
 * the redirect target is itself excluded (already tried and rejected this attempt), the
 * candidate is returned unredirected — its cost will still exceed the cap, so the caller's
 * affordability check rejects it and falls through to the next candidate instead of looping.
 */
function applyStorageGuard(
  config: GameConfig,
  buildings: readonly SettlementBuilding[],
  queue: readonly QueueItem[],
  candidate: { type: BuildingType; level: number },
  excluded: ExcludedTypes = NO_EXCLUSIONS,
): { type: BuildingType; level: number } {
  const eff = (type: BuildingType): number => effectiveLevelOf(buildings, queue, type);
  const maxLv = (type: BuildingType): number => config.buildings[type].maxLevel;
  const cost = calcBuildCost(config, candidate.type, candidate.level);
  const caps = calcStorageCaps(config, buildings);

  if (cost.food > caps.food) {
    const csEff = eff('coldStorage');
    if (!excluded.has('coldStorage') && csEff < maxLv('coldStorage')) {
      return { type: 'coldStorage', level: csEff + 1 };
    }
    return candidate;
  }
  if (cost.scrap > caps.scrap || cost.fuel > caps.fuel || cost.electronics > caps.electronics) {
    const whEff = eff('warehouse');
    if (!excluded.has('warehouse') && whEff < maxLv('warehouse')) {
      return { type: 'warehouse', level: whEff + 1 };
    }
  }
  return candidate;
}

/** The result of one `pickBuildTarget` attempt: the pre-guard base type (for exclusion on
 * failure) plus the final post-guard candidate, or `null` when the guard chain dead-ended.
 */
interface PickAttempt {
  baseType: BuildingType;
  candidate: { type: BuildingType; level: number } | null;
}

/**
 * Deterministic build-policy pick: default candidate, then the never-starve/storage guards.
 * `excluded` lets the caller retry with certain types off the table so it can fall through to
 * the next-best candidate (see `processLogin`) instead of abandoning the login the moment the
 * single top pick is maxed, prerequisite-blocked, unaffordable, or would starve the settlement.
 */
function pickBuildTarget(
  config: GameConfig,
  day: number,
  buildings: readonly SettlementBuilding[],
  queue: readonly QueueItem[],
  excluded: ExcludedTypes,
): PickAttempt | null {
  const base = planDefaultCandidate(config, day, buildings, queue, excluded);
  if (!base) {
    return null;
  }
  const starveChecked = applyStarvationGuard(config, buildings, queue, base, excluded);
  const candidate = starveChecked
    ? applyStorageGuard(config, buildings, queue, starveChecked, excluded)
    : null;
  return { baseType: base.type, candidate };
}

/** Throws if the queue ever exceeds its 1-active + 2-waiting capacity (internal sanity check). */
function assertQueueInvariant(queue: readonly QueueItem[]): void {
  if (queue.length > 3) {
    throw new Error(
      `internal invariant violated: build queue held ${queue.length} items, expected <= 3`,
    );
  }
}

/**
 * Login behaviour: settle (done by the caller before this runs), then repeatedly enqueue
 * the policy's next pick while a queue slot is free. Each pick attempt falls through —
 * maxed, prerequisite-blocked, starved-with-no-redirect, or unaffordable candidates are
 * excluded and the policy is re-run — so a login only stops enqueueing when literally no
 * candidate (of the up-to-13 building types) can be enqueued, not just because the single
 * top-priority candidate happened to be temporarily too expensive.
 */
function processLogin(
  config: GameConfig,
  day: number,
  buildings: SettlementBuilding[],
  queue: QueueItem[],
  now: number,
  resources: Resources,
): Resources {
  let remaining = resources;
  while (queue.length < 3) {
    const excluded = new Set<BuildingType>();
    let enqueued = false;

    while (excluded.size <= BUILDING_TYPES.length) {
      const attempt = pickBuildTarget(config, day, buildings, queue, excluded);
      if (!attempt) {
        break;
      }
      if (attempt.candidate) {
        const cost = calcBuildCost(config, attempt.candidate.type, attempt.candidate.level);
        if (canAfford(remaining, cost)) {
          remaining = subtractResources(remaining, cost);
          const wasEmpty = queue.length === 0;
          const item: QueueItem = {
            type: attempt.candidate.type,
            level: attempt.candidate.level,
            startAt: null,
            completeAt: null,
          };
          if (wasEmpty) {
            const ccLevel = completedLevelOf(buildings, 'commandCenter');
            item.startAt = now;
            item.completeAt = now + calcBuildTimeMs(config, item.type, item.level, ccLevel);
          }
          queue.push(item);
          assertQueueInvariant(queue);
          enqueued = true;
          break;
        }
      }
      // Blocked (unaffordable, or the starvation guard couldn't find a redirect) — exclude
      // the pre-guard base type and let the policy fall through to its next-best candidate.
      excluded.add(attempt.baseType);
    }

    if (!enqueued) {
      break;
    }
  }
  return remaining;
}

/** Applies the front queue item's completion to `buildings` and starts the next one, if any. */
function completeActiveBuild(
  config: GameConfig,
  buildings: SettlementBuilding[],
  queue: QueueItem[],
  now: number,
  nextSlot: { current: number },
): void {
  const done = queue.shift();
  if (!done) {
    return;
  }
  const existing = buildings.find((b) => b.type === done.type);
  if (existing) {
    existing.level = done.level;
  } else {
    buildings.push({ id: done.type, type: done.type, level: done.level, slot: nextSlot.current });
    nextSlot.current += 1;
  }

  const next = queue[0];
  if (next) {
    const ccLevel = completedLevelOf(buildings, 'commandCenter');
    next.startAt = now;
    next.completeAt = now + calcBuildTimeMs(config, next.type, next.level, ccLevel);
  }
}

/**
 * Settles resources up to `now`, tallies overflow lost to storage caps, and credits the
 * ramped raid-income bonus (also cap-limited) on top. Mutates `wasted` in place.
 */
function advanceResources(
  config: GameConfig,
  buildings: readonly SettlementBuilding[],
  state: ResourceState,
  now: number,
  profile: PlayerProfile,
  wasted: Resources,
): ResourceState {
  const elapsedMs = now - state.lastCalcAt;
  if (elapsedMs <= 0) {
    return { values: { ...state.values }, lastCalcAt: now };
  }

  const rates = calcNetRates(config, buildings);
  const caps = calcStorageCaps(config, buildings);
  const before = state.values;
  const settled = settleResources(config, buildings, state, now);

  for (const kind of RESOURCE_KINDS) {
    const rate = rates[kind];
    if (rate > 0) {
      const theoretical = before[kind] + (rate * elapsedMs) / HOUR_MS;
      const lost = theoretical - settled.values[kind];
      if (lost > 0) {
        wasted[kind] += lost;
      }
    }
  }

  const multiplier = raidMultiplierAt(profile, now);
  const finalValues = { ...settled.values };
  if (multiplier > 1) {
    for (const kind of RESOURCE_KINDS) {
      const added = settled.values[kind] - before[kind];
      if (added > 0) {
        const extra = added * (multiplier - 1);
        const withExtra = finalValues[kind] + extra;
        if (withExtra > caps[kind]) {
          wasted[kind] += withExtra - caps[kind];
        }
        finalValues[kind] = Math.min(withExtra, caps[kind]);
      }
    }
  }

  return { values: finalValues, lastCalcAt: now };
}

/** Builds one end-of-day snapshot from the current working state. */
function buildSnapshot(
  config: GameConfig,
  day: number,
  buildings: readonly SettlementBuilding[],
  state: ResourceState,
  wasted: Resources,
  idleQueueMs: number,
): DaySnapshot {
  const resourceLevels = {} as Record<BuildingType, number>;
  for (const type of BUILDING_TYPES) {
    resourceLevels[type] = completedLevelOf(buildings, type);
  }
  const topResourceLevel = Math.max(...PRODUCER_TYPES.map((t) => completedLevelOf(buildings, t)));

  return {
    day,
    buildings: buildings.map((b) => ({ ...b })),
    topResourceLevel,
    resourceLevels,
    commandCenterLevel: completedLevelOf(buildings, 'commandCenter'),
    grossProductionPerHour: calcSettlementProduction(config, buildings),
    netFoodPerHour: calcNetFoodPerHour(config, buildings),
    influence: calcInfluence(config, [buildings]),
    wastedToOverflow: { ...wasted },
    idleQueueMs,
    resources: { ...state.values },
  };
}

/** Fast-forward one settlement for `days` days. Deterministic; no clocks, no randomness. */
export function simulateReferencePlayer(
  config: GameConfig,
  profile: PlayerProfile,
  days: number,
): SimulationResult {
  const buildings: SettlementBuilding[] = [
    { id: 'commandCenter', type: 'commandCenter', level: 1, slot: 0 },
  ];
  const nextSlot = { current: 1 };
  const queue: QueueItem[] = [];
  let state: ResourceState = { values: { ...STARTING_RESOURCES }, lastCalcAt: 0 };
  const wasted: Resources = emptyResources();
  let idleQueueMs = 0;
  let hasLoggedInOnce = false;

  const loginTimes: number[] = [];
  for (let d = 1; d <= days; d += 1) {
    const dayStart = (d - 1) * DAY_MS;
    for (const h of profile.loginHours) {
      loginTimes.push(dayStart + h * HOUR_MS);
    }
  }
  loginTimes.sort((a, b) => a - b);

  const snapshots: DaySnapshot[] = [];
  let loginIdx = 0;
  let day = 1;

  while (day <= days) {
    const dayEndAt = day * DAY_MS;
    const nextLogin = loginTimes.at(loginIdx) ?? null;
    const active = queue[0];
    const nextCompletion = active ? active.completeAt : null;

    const candidates = [dayEndAt];
    if (nextLogin !== null) {
      candidates.push(nextLogin);
    }
    if (nextCompletion !== null) {
      candidates.push(nextCompletion);
    }
    const t = Math.min(...candidates);

    if (hasLoggedInOnce && queue.length === 0 && t > state.lastCalcAt) {
      idleQueueMs += t - state.lastCalcAt;
    }

    state = advanceResources(config, buildings, state, t, profile, wasted);

    if (nextCompletion !== null && t === nextCompletion) {
      completeActiveBuild(config, buildings, queue, t, nextSlot);
    }
    if (nextLogin !== null && t === nextLogin) {
      loginIdx += 1;
      hasLoggedInOnce = true;
      state = {
        values: processLogin(config, day, buildings, queue, t, state.values),
        lastCalcAt: t,
      };
    }
    if (t === dayEndAt) {
      snapshots.push(buildSnapshot(config, day, buildings, state, wasted, idleQueueMs));
      day += 1;
    }
  }

  const final = snapshots[snapshots.length - 1];
  if (!final) {
    throw new RangeError('simulateReferencePlayer: days must be at least 1');
  }
  return { profile: profile.id, days: snapshots, final };
}
