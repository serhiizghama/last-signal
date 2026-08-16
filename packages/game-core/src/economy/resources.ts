import type { BuildingLevels, GameConfig } from '../config/types.js';
import {
  calcNetFoodPerHour,
  calcSettlementProduction,
  calcStorageCaps,
} from '../formulas/index.js';
import { canAfford, emptyResources } from '../numeric.js';
import { RESOURCE_KINDS, type ResourceKind, type Resources } from '../types.js';
import type { TroopCounts } from '../units/index.js';

/** Milliseconds in an hour; production rates are per hour, everything else is ms. */
export const HOUR_MS = 3_600_000;

/** A settlement's stored resources and the instant they were last materialised. */
export interface ResourceState {
  values: Resources;
  /** Epoch milliseconds. */
  lastCalcAt: number;
}

/**
 * Hourly net rates actually used for settlement: gross production, minus Food upkeep (buildings
 * + troops) on food. `troops` defaults to an empty list ("no troops"); server/client callers
 * MUST pass the settlement's real troop list once troops exist there (M2a's later
 * settlement-schema step) — omitting it silently understates Food upkeep.
 */
export function calcNetRates(
  config: GameConfig,
  buildings: BuildingLevels,
  troops: TroopCounts = [],
): Resources {
  const gross = calcSettlementProduction(config, buildings);
  return {
    ...gross,
    food: calcNetFoodPerHour(config, buildings, troops),
  };
}

/**
 * Advance `state` to `now`. Never mutates. Production halts at the cap (nothing accrues past
 * it and nothing is retroactively wasted). Returns the new state with `lastCalcAt = now`.
 * `troops` defaults to "no troops" — see `calcNetRates`.
 */
export function settleResources(
  config: GameConfig,
  buildings: BuildingLevels,
  state: ResourceState,
  now: number,
  troops: TroopCounts = [],
): ResourceState {
  const elapsedMs = now - state.lastCalcAt;
  if (elapsedMs <= 0) {
    return { values: { ...state.values }, lastCalcAt: now };
  }

  const rates = calcNetRates(config, buildings, troops);
  const caps = calcStorageCaps(config, buildings);
  const values = emptyResources();
  for (const kind of RESOURCE_KINDS) {
    const rate = rates[kind];
    const value = state.values[kind];
    const grown = value + (rate * elapsedMs) / HOUR_MS;
    const next = rate > 0 ? Math.min(grown, Math.max(caps[kind], value)) : grown;
    values[kind] = Math.max(0, next);
  }
  return { values, lastCalcAt: now };
}

/**
 * Milliseconds until `resource` reaches its cap, or `null` when it never will
 * (rate <= 0, or already at/above the cap). `troops` defaults to "no troops" — see `calcNetRates`.
 */
export function msUntilFull(
  config: GameConfig,
  buildings: BuildingLevels,
  state: ResourceState,
  resource: ResourceKind,
  troops: TroopCounts = [],
): number | null {
  const rate = calcNetRates(config, buildings, troops)[resource];
  if (rate <= 0) {
    return null;
  }
  const cap = calcStorageCaps(config, buildings)[resource];
  const value = state.values[resource];
  if (value >= cap) {
    return null;
  }
  return Math.ceil(((cap - value) / rate) * HOUR_MS);
}

/**
 * Milliseconds until `resource` hits zero on a negative rate, or `null` when it never will.
 * `troops` defaults to "no troops" — see `calcNetRates`.
 */
export function msUntilEmpty(
  config: GameConfig,
  buildings: BuildingLevels,
  state: ResourceState,
  resource: ResourceKind,
  troops: TroopCounts = [],
): number | null {
  const rate = calcNetRates(config, buildings, troops)[resource];
  if (rate >= 0) {
    return null;
  }
  const value = state.values[resource];
  if (value <= 0) {
    return null;
  }
  return Math.ceil((value / -rate) * HOUR_MS);
}

/**
 * Milliseconds until every component of `cost` is affordable, or `null` when it never becomes
 * affordable (some needed resource has a non-positive rate, or the cost exceeds that resource's
 * cap). `troops` defaults to "no troops" — see `calcNetRates`.
 */
export function msUntilAffordable(
  config: GameConfig,
  buildings: BuildingLevels,
  state: ResourceState,
  cost: Resources,
  troops: TroopCounts = [],
): number | null {
  if (canAfford(state.values, cost)) {
    return 0;
  }

  const rates = calcNetRates(config, buildings, troops);
  const caps = calcStorageCaps(config, buildings);
  let maxWaitMs = 0;
  for (const kind of RESOURCE_KINDS) {
    const value = state.values[kind];
    const needed = cost[kind];
    if (value >= needed) {
      continue;
    }
    const rate = rates[kind];
    if (rate <= 0 || needed > caps[kind]) {
      return null;
    }
    const waitMs = Math.ceil(((needed - value) / rate) * HOUR_MS);
    maxWaitMs = Math.max(maxWaitMs, waitMs);
  }
  return maxWaitMs;
}
