import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from './config/index.js';
import { beginnerProtectionUntil, isBeginnerProtected } from './protection.js';

const config = DEFAULT_CONFIG; // protection.durationMs: 259_200_000 (72h)

describe('beginnerProtectionUntil', () => {
  it('is `at + protection.durationMs` (72h)', () => {
    expect(beginnerProtectionUntil(config, 1_000)).toBe(1_000 + 259_200_000);
  });
});

describe('isBeginnerProtected', () => {
  it('is true strictly before protectedUntil', () => {
    expect(isBeginnerProtected(10_000, 9_999)).toBe(true);
  });

  it('is false at the boundary: now === protectedUntil reads as already expired', () => {
    expect(isBeginnerProtected(10_000, 10_000)).toBe(false);
  });

  it('is false after protectedUntil', () => {
    expect(isBeginnerProtected(10_000, 10_001)).toBe(false);
  });

  it('is false for null (never protected)', () => {
    expect(isBeginnerProtected(null, 0)).toBe(false);
  });

  it('is false for undefined (never protected)', () => {
    expect(isBeginnerProtected(undefined, 0)).toBe(false);
  });
});
