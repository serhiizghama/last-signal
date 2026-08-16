import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from './defaultConfig.js';

describe('DEFAULT_CONFIG', () => {
  it('is at configVersion 6 (M2b.3: the movement.cancelWindowMs block)', () => {
    expect(DEFAULT_CONFIG.configVersion).toBe(6);
  });

  it('ships a 90s movement cancel window by default (§6, draft number)', () => {
    expect(DEFAULT_CONFIG.movement.cancelWindowMs).toBe(90_000);
  });
});
