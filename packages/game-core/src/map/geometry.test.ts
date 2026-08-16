import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config/index.js';
import { chebyshevDistance, isInGrid } from './geometry.js';

describe('chebyshevDistance', () => {
  it('is the max of the axis deltas, not the Euclidean hypotenuse', () => {
    expect(chebyshevDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(4);
    expect(chebyshevDistance({ x: 0, y: 0 }, { x: 5, y: 0 })).toBe(5);
    expect(chebyshevDistance({ x: 0, y: 0 }, { x: 0, y: -7 })).toBe(7);
  });

  it('is symmetric and zero for coincident tiles', () => {
    const a = { x: -12, y: 8 };
    const b = { x: 3, y: -4 };
    expect(chebyshevDistance(a, b)).toBe(chebyshevDistance(b, a));
    expect(chebyshevDistance(a, a)).toBe(0);
  });

  it('matches "moves like a king": diagonal moves cost the same as orthogonal ones', () => {
    expect(chebyshevDistance({ x: 0, y: 0 }, { x: 5, y: 5 })).toBe(5);
  });
});

describe('isInGrid', () => {
  it('accepts every corner and the center of the configured 61x61 grid (radius 30)', () => {
    const { radius } = DEFAULT_CONFIG.map;
    expect(isInGrid(DEFAULT_CONFIG, { x: 0, y: 0 })).toBe(true);
    expect(isInGrid(DEFAULT_CONFIG, { x: radius, y: radius })).toBe(true);
    expect(isInGrid(DEFAULT_CONFIG, { x: -radius, y: -radius })).toBe(true);
    expect(isInGrid(DEFAULT_CONFIG, { x: radius, y: -radius })).toBe(true);
  });

  it('rejects any tile one step past the boundary on either axis (no wrap-around)', () => {
    const { radius } = DEFAULT_CONFIG.map;
    expect(isInGrid(DEFAULT_CONFIG, { x: radius + 1, y: 0 })).toBe(false);
    expect(isInGrid(DEFAULT_CONFIG, { x: 0, y: -radius - 1 })).toBe(false);
  });
});
