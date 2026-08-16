import type { GameConfig } from '../config/types.js';
import { ceilSecondsToMs } from '../numeric.js';

/**
 * Travel time for one march covering `distanceTiles` (Chebyshev, §1) at `unitSpeed` fields
 * per hour at classic x1, scaled uniformly by `config.speed.travel` (§0). Ceiled to whole
 * seconds and returned in ms per the numeric conventions. `unitSpeed` is whatever the caller
 * already resolved to be the slowest unit in the marching army — see `slowestSpeed`.
 */
export function travelTimeMs(config: GameConfig, distanceTiles: number, unitSpeed: number): number {
  if (unitSpeed <= 0) {
    throw new RangeError(`travelTimeMs: unitSpeed must be positive, got ${unitSpeed}`);
  }
  if (distanceTiles < 0) {
    throw new RangeError(`travelTimeMs: distanceTiles must not be negative, got ${distanceTiles}`);
  }
  const hours = distanceTiles / (unitSpeed * config.speed.travel);
  return ceilSecondsToMs(hours * 3600);
}

/**
 * The speed that decides a mixed army's travel time: the slowest unit present (§0). A thin
 * helper so callers don't each reimplement `Math.min` over their own unit list.
 */
export function slowestSpeed(unitSpeeds: readonly number[]): number {
  if (unitSpeeds.length === 0) {
    throw new RangeError('slowestSpeed: unitSpeeds must not be empty');
  }
  return Math.min(...unitSpeeds);
}
