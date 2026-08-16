import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config/index.js';
import { chebyshevDistance, isInGrid } from './geometry.js';
import { mulberry32 } from './rng.js';
import { pickSpawnTile, spawnAnnulus, spawnRadius } from './spawn.js';

describe('spawnRadius', () => {
  it('is monotonic non-decreasing in the settlement count', () => {
    let previous = spawnRadius(DEFAULT_CONFIG, 0);
    for (let n = 1; n <= 400; n += 1) {
      const current = spawnRadius(DEFAULT_CONFIG, n);
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });

  it('never exceeds the configured max radius, however large the settlement count', () => {
    expect(spawnRadius(DEFAULT_CONFIG, 1_000_000)).toBe(DEFAULT_CONFIG.map.spawn.maxRadius);
  });

  it('produces the documented R ~ 25 for n = 135 (the initial NPC population, M2 §3)', () => {
    expect(spawnRadius(DEFAULT_CONFIG, 135)).toBe(25);
  });

  it('starts at baseRadius for n = 0', () => {
    expect(spawnRadius(DEFAULT_CONFIG, 0)).toBe(DEFAULT_CONFIG.map.spawn.baseRadius);
  });
});

describe('spawnAnnulus', () => {
  it('clamps the inner radius at 0 instead of going negative', () => {
    const { inner, outer } = spawnAnnulus(DEFAULT_CONFIG, 0);
    expect(outer).toBe(4);
    expect(inner).toBe(0); // 4 - bandWidth(6) would be negative
  });

  it('is bandWidth wide once the outer radius exceeds the band width', () => {
    const { inner, outer } = spawnAnnulus(DEFAULT_CONFIG, 135);
    expect(outer).toBe(25);
    expect(inner).toBe(25 - DEFAULT_CONFIG.map.spawn.bandWidth);
  });
});

describe('pickSpawnTile', () => {
  it('returns a legal, in-grid tile when the origin ring already satisfies the legality check', () => {
    const rng = mulberry32(1);
    const tile = pickSpawnTile(DEFAULT_CONFIG, 0, { rng, isLegal: () => true });
    expect(tile).not.toBeNull();
    expect(isInGrid(DEFAULT_CONFIG, tile!)).toBe(true);
  });

  it('only ever returns tiles that satisfy the injected legality predicate', () => {
    const rng = mulberry32(7);
    const isLegal = (tile: { x: number; y: number }): boolean => tile.x % 2 === 0;
    for (let n = 0; n < 20; n += 1) {
      const tile = pickSpawnTile(DEFAULT_CONFIG, n, { rng, isLegal });
      expect(tile).not.toBeNull();
      expect(isLegal(tile!)).toBe(true);
    }
  });

  it('grows the radius outward past the initial R(n) when the starting band has no legal tile', () => {
    // n = 0 -> initial R(0) = 4, but only tiles at distance >= 10 are legal: the picker
    // must widen its search several rings past the starting annulus to find one.
    const rng = mulberry32(2024);
    const origin = { x: 0, y: 0 };
    const isLegal = (tile: { x: number; y: number }): boolean =>
      chebyshevDistance(tile, origin) >= 10;
    const tile = pickSpawnTile(DEFAULT_CONFIG, 0, { rng, isLegal });
    expect(tile).not.toBeNull();
    expect(chebyshevDistance(tile!, origin)).toBeGreaterThanOrEqual(10);
  });

  it('returns null (never loops forever) when no tile anywhere in the grid is legal', () => {
    const rng = mulberry32(3);
    const tile = pickSpawnTile(DEFAULT_CONFIG, 0, {
      rng,
      isLegal: () => false,
      attemptsPerRing: 5, // keep the (bounded) exhaustive search fast in a test
    });
    expect(tile).toBeNull();
  });

  it('exhausts up to the configured grid radius before giving up, not more and not less', () => {
    // Every draw is legal only if it lies exactly on the grid's radius ring — reachable
    // only once the picker has grown outer all the way to config.map.radius.
    const rng = mulberry32(11);
    const origin = { x: 0, y: 0 };
    const { radius } = DEFAULT_CONFIG.map;
    const isLegal = (tile: { x: number; y: number }): boolean =>
      chebyshevDistance(tile, origin) === radius;
    const tile = pickSpawnTile(DEFAULT_CONFIG, 0, { rng, isLegal });
    expect(tile).not.toBeNull();
    expect(chebyshevDistance(tile!, origin)).toBe(radius);
  });
});
