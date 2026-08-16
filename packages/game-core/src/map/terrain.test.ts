import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config/index.js';
import { canTerrainHostSettlement, terrainAt, TERRAIN_IDS } from './terrain.js';

describe('terrainAt', () => {
  it('is deterministic: two independent derivations from the same seed agree on a sample of tiles', () => {
    const sample = [
      { x: 0, y: 0 },
      { x: 30, y: 30 },
      { x: -30, y: -30 },
      { x: 7, y: -19 },
      { x: -12, y: 4 },
    ];
    for (const tile of sample) {
      expect(terrainAt(DEFAULT_CONFIG, 'world-alpha', tile.x, tile.y)).toBe(
        terrainAt(DEFAULT_CONFIG, 'world-alpha', tile.x, tile.y),
      );
    }
  });

  it('differs between two seeds for at least some tiles in a sample', () => {
    const sample = Array.from({ length: 30 }, (_, i) => ({ x: i - 15, y: ((i * 3) % 20) - 10 }));
    const differing = sample.filter(
      (tile) =>
        terrainAt(DEFAULT_CONFIG, 'world-alpha', tile.x, tile.y) !==
        terrainAt(DEFAULT_CONFIG, 'world-beta', tile.x, tile.y),
    );
    expect(differing.length).toBeGreaterThan(0);
  });

  it('always returns one of the six configured terrain ids', () => {
    for (let x = -30; x <= 30; x += 7) {
      for (let y = -30; y <= 30; y += 7) {
        expect(TERRAIN_IDS).toContain(terrainAt(DEFAULT_CONFIG, 'world-alpha', x, y));
      }
    }
  });

  // Tolerance: +/-3 percentage points against the configured weight, checked over the full
  // 61x61 grid (3721 tiles). At n=3721 the sampling std-dev for the smallest weight (toxic
  // lake, 7%) is ~0.4pp, so 3pp is a wide, non-flaky margin — this is checking the hash/PRNG
  // mix is sane, not chasing exact statistical precision.
  it('matches the configured weight distribution over the whole grid within 3 percentage points', () => {
    const { radius } = DEFAULT_CONFIG.map;
    const weights = DEFAULT_CONFIG.map.terrainWeights;
    const counts = Object.fromEntries(TERRAIN_IDS.map((id) => [id, 0])) as Record<
      (typeof TERRAIN_IDS)[number],
      number
    >;
    let total = 0;
    for (let x = -radius; x <= radius; x += 1) {
      for (let y = -radius; y <= radius; y += 1) {
        counts[terrainAt(DEFAULT_CONFIG, 'world-distribution', x, y)] += 1;
        total += 1;
      }
    }
    for (const id of TERRAIN_IDS) {
      const actual = counts[id] / total;
      expect(Math.abs(actual - weights[id])).toBeLessThan(0.03);
    }
  });
});

describe('canTerrainHostSettlement', () => {
  it('rejects toxic lake and nothing else', () => {
    for (const id of TERRAIN_IDS) {
      expect(canTerrainHostSettlement(id)).toBe(id !== 'toxicLake');
    }
  });
});
