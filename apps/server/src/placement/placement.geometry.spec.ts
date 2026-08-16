import { describe, expect, it } from 'vitest';

import { GRID_MAX, GRID_MIN } from '../schemas/grid.constants';
import {
  OUTER_RING_MAX_DISTANCE,
  OUTER_RING_MIN_DISTANCE,
  PERIMETER_LENGTH,
  chebyshevDistance,
  pickOuterRingTile,
} from './placement.geometry';

// Pure, DB-free tests of the placement algorithm's geometry — see the design brief: "Pure
// and deterministic given (counter, world size) — unit-test it directly". The
// DB-backed counter itself (`PlacementService.nextCounter`) and the collision-retry path
// are covered by `settlements.integration.spec.ts` against a real Mongo unique index.
describe('placement geometry', () => {
  it('is deterministic: the same counter always maps to the same tile', () => {
    for (const counter of [0, 1, 2, 42, 1_000]) {
      expect(pickOuterRingTile(counter)).toEqual(pickOuterRingTile(counter));
    }
  });

  it('never returns the centre', () => {
    for (let counter = 0; counter <= 1_000; counter += 1) {
      const tile = pickOuterRingTile(counter);
      expect(tile).not.toEqual({ x: 0, y: 0 });
    }
  });

  it('never leaves the 61×61 grid', () => {
    for (let counter = 0; counter <= 1_000; counter += 1) {
      const tile = pickOuterRingTile(counter);
      expect(tile.x).toBeGreaterThanOrEqual(GRID_MIN);
      expect(tile.x).toBeLessThanOrEqual(GRID_MAX);
      expect(tile.y).toBeGreaterThanOrEqual(GRID_MIN);
      expect(tile.y).toBeLessThanOrEqual(GRID_MAX);
    }
  });

  it('always lands within the outer-ring band', () => {
    for (let counter = 0; counter <= 1_000; counter += 1) {
      const tile = pickOuterRingTile(counter);
      const distance = chebyshevDistance(tile.x, tile.y);
      expect(distance).toBeGreaterThanOrEqual(OUTER_RING_MIN_DISTANCE);
      expect(distance).toBeLessThanOrEqual(OUTER_RING_MAX_DISTANCE);
    }
  });

  it('produces no duplicate tiles across a few hundred sequential allocations', () => {
    const seen = new Set<string>();
    for (let counter = 1; counter <= 300; counter += 1) {
      const tile = pickOuterRingTile(counter);
      const key = `${tile.x},${tile.y}`;
      expect(seen.has(key), `counter ${counter} repeated tile ${key}`).toBe(false);
      seen.add(key);
    }
    expect(seen.size).toBe(300);
  });

  it('spreads successive allocations around the perimeter rather than clustering them', () => {
    // Every consecutive pair lands well apart (Chebyshev distance), not adjacent or
    // near-adjacent tiles — the whole point of the coprime-stride walk (see
    // `placement.geometry.ts`'s comment). A generous threshold well below the observed
    // minimum keeps this robust to the exact stride picked without re-asserting its
    // precise numeric value.
    const MIN_ACCEPTABLE_SPREAD = 5;
    for (let counter = 1; counter <= 300; counter += 1) {
      const a = pickOuterRingTile(counter);
      const b = pickOuterRingTile(counter + 1);
      const distance = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
      expect(distance).toBeGreaterThanOrEqual(MIN_ACCEPTABLE_SPREAD);
    }
  });

  it('cycles through the whole band exactly once before repeating', () => {
    const seen = new Set<string>();
    for (let counter = 1; counter <= PERIMETER_LENGTH; counter += 1) {
      const tile = pickOuterRingTile(counter);
      seen.add(`${tile.x},${tile.y}`);
    }
    expect(seen.size).toBe(PERIMETER_LENGTH);
    // One full cycle later, the sequence repeats exactly.
    expect(pickOuterRingTile(1)).toEqual(pickOuterRingTile(1 + PERIMETER_LENGTH));
  });
});
