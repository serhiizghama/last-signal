import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config/index.js';
import { slowestSpeed, travelTimeMs } from './travel.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

// The M2 §0 travel-time contract table (unit speeds at classic x1, SPEED.travel = 2). These
// numbers ARE the contract — sourced verbatim from docs/M2_DESIGN_DECISIONS.md §0, not
// derived from the formula under test, so they can actually catch a regression in it.
// Tolerance: within one minute, per the brief.
const CONTRACT_TABLE: ReadonlyArray<{
  name: string;
  speed: number;
  distance: number;
  expectedMinutes: number;
}> = [
  { name: 'Falconer (17) over 10 tiles', speed: 17, distance: 10, expectedMinutes: 18 },
  { name: 'Falconer (17) over 30 tiles', speed: 17, distance: 30, expectedMinutes: 53 },
  { name: 'Falconer (17) over 60 tiles', speed: 17, distance: 60, expectedMinutes: 106 }, // 1h46m
  { name: 'Surveyor Drone (16) over 10 tiles', speed: 16, distance: 10, expectedMinutes: 19 },
  { name: 'Surveyor Drone (16) over 30 tiles', speed: 16, distance: 30, expectedMinutes: 56 },
  { name: 'Surveyor Drone (16) over 60 tiles', speed: 16, distance: 60, expectedMinutes: 113 }, // 1h53m
  { name: 'Lookout (9) over 10 tiles', speed: 9, distance: 10, expectedMinutes: 33 },
  { name: 'Lookout (9) over 30 tiles', speed: 9, distance: 30, expectedMinutes: 100 }, // 1h40m
  { name: 'Lookout (9) over 60 tiles', speed: 9, distance: 60, expectedMinutes: 200 }, // 3h20m
  { name: 'infantry reference (7) over 10 tiles', speed: 7, distance: 10, expectedMinutes: 43 },
  { name: 'infantry reference (7) over 30 tiles', speed: 7, distance: 30, expectedMinutes: 129 }, // 2h09m
  { name: 'infantry reference (7) over 60 tiles', speed: 7, distance: 60, expectedMinutes: 257 }, // 4h17m
  { name: 'siege reference (4) over 10 tiles', speed: 4, distance: 10, expectedMinutes: 75 }, // 1h15m
  { name: 'siege reference (4) over 30 tiles', speed: 4, distance: 30, expectedMinutes: 225 }, // 3h45m
  { name: 'siege reference (4) over 60 tiles', speed: 4, distance: 60, expectedMinutes: 450 }, // 7h30m
];

describe('travelTimeMs — M2 §0 contract table', () => {
  for (const row of CONTRACT_TABLE) {
    it(`${row.name}: ~${row.expectedMinutes} min`, () => {
      const actualMs = travelTimeMs(DEFAULT_CONFIG, row.distance, row.speed);
      expect(Math.abs(actualMs - row.expectedMinutes * MINUTE_MS)).toBeLessThan(MINUTE_MS);
    });
  }
});

describe('travelTimeMs — §0 contract bounds', () => {
  it('an average combat unit (speed ~7) crosses half the map (30 tiles) in 2-4 hours', () => {
    const ms = travelTimeMs(DEFAULT_CONFIG, 30, 7);
    expect(ms).toBeGreaterThanOrEqual(2 * HOUR_MS);
    expect(ms).toBeLessThanOrEqual(4 * HOUR_MS);
  });

  it('the slowest scout (speed 9) crosses half the map (30 tiles) in at most 1.7 hours', () => {
    const ms = travelTimeMs(DEFAULT_CONFIG, 30, 9);
    expect(ms).toBeLessThanOrEqual(1.7 * HOUR_MS);
  });

  it('nothing crosses the full map (60 tiles) in under 40 minutes, not even the fastest scout', () => {
    const ms = travelTimeMs(DEFAULT_CONFIG, 60, 17);
    expect(ms).toBeGreaterThanOrEqual(40 * MINUTE_MS);
  });
});

describe('travelTimeMs — guards', () => {
  it('ceils to whole seconds', () => {
    const ms = travelTimeMs(DEFAULT_CONFIG, 1, 3);
    expect(ms % 1000).toBe(0);
  });

  it('throws on a non-positive unit speed', () => {
    expect(() => travelTimeMs(DEFAULT_CONFIG, 10, 0)).toThrow(RangeError);
    expect(() => travelTimeMs(DEFAULT_CONFIG, 10, -1)).toThrow(RangeError);
  });

  it('throws on a negative distance', () => {
    expect(() => travelTimeMs(DEFAULT_CONFIG, -1, 10)).toThrow(RangeError);
  });

  it('is zero for zero distance', () => {
    expect(travelTimeMs(DEFAULT_CONFIG, 0, 10)).toBe(0);
  });
});

describe('slowestSpeed', () => {
  it('returns the minimum of a list of unit speeds', () => {
    expect(slowestSpeed([17, 9, 16, 4])).toBe(4);
  });

  it('returns the single speed for a one-unit army', () => {
    expect(slowestSpeed([12])).toBe(12);
  });

  it('throws on an empty list', () => {
    expect(() => slowestSpeed([])).toThrow(RangeError);
  });
});
