import { describe, expect, it } from 'vitest';
import type { GameConfig } from '../config/types.js';
import { DEFAULT_CONFIG } from '../config/index.js';
import { chebyshevDistance } from './geometry.js';
import { generateOases } from './oases.js';
import { canTerrainHostSettlement, terrainAt } from './terrain.js';

describe('generateOases', () => {
  it('places exactly the configured count (24) under DEFAULT_CONFIG', () => {
    const oases = generateOases(DEFAULT_CONFIG, 'world-alpha');
    expect(oases).toHaveLength(DEFAULT_CONFIG.map.oases.count);
  });

  it('keeps every pair at least the configured minimum Chebyshev distance apart', () => {
    const oases = generateOases(DEFAULT_CONFIG, 'world-alpha');
    for (let i = 0; i < oases.length; i += 1) {
      for (let j = i + 1; j < oases.length; j += 1) {
        expect(chebyshevDistance(oases[i]!, oases[j]!)).toBeGreaterThanOrEqual(
          DEFAULT_CONFIG.map.oases.minDistance,
        );
      }
    }
  });

  it('never places an oasis on a toxic lake tile', () => {
    const oases = generateOases(DEFAULT_CONFIG, 'world-alpha');
    for (const tile of oases) {
      expect(
        canTerrainHostSettlement(terrainAt(DEFAULT_CONFIG, 'world-alpha', tile.x, tile.y)),
      ).toBe(true);
    }
  });

  it('never places an oasis within the configured edge margin of the grid boundary', () => {
    const oases = generateOases(DEFAULT_CONFIG, 'world-alpha');
    const limit = DEFAULT_CONFIG.map.radius - DEFAULT_CONFIG.map.oases.edgeMargin;
    for (const tile of oases) {
      expect(Math.max(Math.abs(tile.x), Math.abs(tile.y))).toBeLessThanOrEqual(limit);
    }
  });

  it('is deterministic: two derivations from the same seed produce the identical list', () => {
    const a = generateOases(DEFAULT_CONFIG, 'world-alpha');
    const b = generateOases(DEFAULT_CONFIG, 'world-alpha');
    expect(a).toEqual(b);
  });

  it('produces a different list for a different seed', () => {
    const a = generateOases(DEFAULT_CONFIG, 'world-alpha');
    const b = generateOases(DEFAULT_CONFIG, 'world-beta');
    expect(a).not.toEqual(b);
  });

  it('returns an empty list when the edge margin excludes the entire grid, without hanging', () => {
    const config: GameConfig = {
      ...DEFAULT_CONFIG,
      map: { ...DEFAULT_CONFIG.map, oases: { ...DEFAULT_CONFIG.map.oases, edgeMargin: 999 } },
    };
    expect(generateOases(config, 'world-alpha')).toEqual([]);
  });

  it('places fewer than the target count, and still terminates, when minDistance makes full placement infeasible', () => {
    // A minDistance far larger than the grid's diagonal makes every oasis after the first
    // mutually exclusive with it — the bounded search must give up rather than loop forever.
    const config: GameConfig = {
      ...DEFAULT_CONFIG,
      map: { ...DEFAULT_CONFIG.map, oases: { ...DEFAULT_CONFIG.map.oases, minDistance: 1000 } },
    };
    const oases = generateOases(config, 'world-alpha');
    expect(oases.length).toBeGreaterThan(0);
    expect(oases.length).toBeLessThan(config.map.oases.count);
  });
});
