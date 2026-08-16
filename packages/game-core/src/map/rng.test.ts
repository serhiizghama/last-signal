import { describe, expect, it } from 'vitest';
import { hashStringToUint32, mulberry32, tileRoll } from './rng.js';

describe('hashStringToUint32', () => {
  it('is deterministic: the same string always hashes to the same uint32', () => {
    expect(hashStringToUint32('world-seed-alpha')).toBe(hashStringToUint32('world-seed-alpha'));
  });

  it('differs (with overwhelming likelihood) for different strings', () => {
    expect(hashStringToUint32('world-seed-alpha')).not.toBe(hashStringToUint32('world-seed-beta'));
  });

  it('always returns a non-negative 32-bit unsigned integer', () => {
    for (const input of ['', 'x', 'a fairly long seed string with spaces', '-30:30']) {
      const hash = hashStringToUint32(input);
      expect(Number.isInteger(hash)).toBe(true);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe('mulberry32', () => {
  it('is deterministic: two streams from the same seed produce the same sequence', () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const sequenceA = Array.from({ length: 10 }, () => a());
    const sequenceB = Array.from({ length: 10 }, () => b());
    expect(sequenceA).toEqual(sequenceB);
  });

  it('produces values within [0, 1)', () => {
    const next = mulberry32(999);
    for (let i = 0; i < 1000; i += 1) {
      const value = next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('does not repeat the first value across successive calls (a degenerate constant stream)', () => {
    const next = mulberry32(42);
    const first = next();
    const second = next();
    expect(first).not.toBe(second);
  });
});

describe('tileRoll', () => {
  it('is deterministic per (seed, x, y): identical inputs give an identical roll', () => {
    expect(tileRoll('seed-a', 3, -7)).toBe(tileRoll('seed-a', 3, -7));
  });

  it('varies with the coordinates for a fixed seed', () => {
    const rolls = new Set<number>();
    for (let x = -5; x <= 5; x += 1) {
      rolls.add(tileRoll('seed-a', x, 0));
    }
    expect(rolls.size).toBeGreaterThan(1);
  });

  it('varies with the seed for fixed coordinates', () => {
    expect(tileRoll('seed-a', 1, 1)).not.toBe(tileRoll('seed-b', 1, 1));
  });

  it('returns a value within [0, 1)', () => {
    const roll = tileRoll('seed-a', 30, -30);
    expect(roll).toBeGreaterThanOrEqual(0);
    expect(roll).toBeLessThan(1);
  });
});
