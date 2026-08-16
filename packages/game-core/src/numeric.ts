import { RESOURCE_KINDS, type Resources } from './types.js';

/**
 * Numeric conventions (§10):
 * - Resources are stored as float, displayed floored.
 * - Time is milliseconds everywhere internally; production rates are per hour internally.
 * - Costs round to the nearest integer.
 * - Build/training times ceil to whole seconds.
 */

/** Costs round to the nearest integer. */
export function roundCost(value: number): number {
  return Math.round(value);
}

/** Durations are ceiled to whole seconds and returned in milliseconds. */
export function ceilSecondsToMs(seconds: number): number {
  return Math.ceil(seconds) * 1000;
}

/** Resources are stored as float and displayed floored. */
export function floorForDisplay(value: number): number {
  return Math.floor(value);
}

/** Element-wise sum of two resource bundles (pure, no mutation). */
export function addResources(a: Resources, b: Resources): Resources {
  return combineResources(a, b, (x, y) => x + y);
}

/** Element-wise difference of two resource bundles (pure, no mutation). */
export function subtractResources(a: Resources, b: Resources): Resources {
  return combineResources(a, b, (x, y) => x - y);
}

/** Scales every resource in a bundle by `factor` (pure, no mutation). */
export function scaleResources(a: Resources, factor: number): Resources {
  const result = emptyResources();
  for (const kind of RESOURCE_KINDS) {
    result[kind] = a[kind] * factor;
  }
  return result;
}

/** A resource bundle with every kind set to 0. */
export function emptyResources(): Resources {
  const result = {} as Resources;
  for (const kind of RESOURCE_KINDS) {
    result[kind] = 0;
  }
  return result;
}

/** True when `available` covers every component of `cost`. */
export function canAfford(available: Resources, cost: Resources): boolean {
  return RESOURCE_KINDS.every((kind) => available[kind] >= cost[kind]);
}

function combineResources(
  a: Resources,
  b: Resources,
  combine: (x: number, y: number) => number,
): Resources {
  const result = emptyResources();
  for (const kind of RESOURCE_KINDS) {
    result[kind] = combine(a[kind], b[kind]);
  }
  return result;
}
