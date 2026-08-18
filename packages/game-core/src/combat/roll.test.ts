import { describe, expect, it } from 'vitest';
import { battleRoll } from './roll.js';

describe('battleRoll', () => {
  it('is deterministic: identical (seed, movementId) yields the identical value', () => {
    const a = battleRoll('world-seed-1', 'movement-42');
    const b = battleRoll('world-seed-1', 'movement-42');
    expect(a).toBe(b);
  });

  it('differs for a different movementId with the same seed', () => {
    const a = battleRoll('world-seed-1', 'movement-42');
    const b = battleRoll('world-seed-1', 'movement-43');
    expect(a).not.toBe(b);
  });

  it('differs for a different seed with the same movementId', () => {
    const a = battleRoll('world-seed-1', 'movement-42');
    const b = battleRoll('world-seed-2', 'movement-42');
    expect(a).not.toBe(b);
  });

  // Fixed matrix, not Math.random() — same discipline the brief asks tests to follow elsewhere.
  it('always lands in [-1, 1) across a fixed matrix of (seed, movementId) pairs', () => {
    const seeds = ['alpha', 'bravo', 'charlie'];
    const movementIds = ['m-0', 'm-1', 'm-2', 'm-3', 'm-4', 'm-5', 'm-6', 'm-7', 'm-8', 'm-9'];
    for (const seed of seeds) {
      for (const movementId of movementIds) {
        const r = battleRoll(seed, movementId);
        expect(r).toBeGreaterThanOrEqual(-1);
        expect(r).toBeLessThan(1);
      }
    }
  });
});
