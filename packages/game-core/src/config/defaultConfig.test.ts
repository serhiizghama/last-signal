import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from './defaultConfig.js';

describe('DEFAULT_CONFIG', () => {
  it('is at configVersion 7 (M3a.1: the 18-type roster and the combat block)', () => {
    expect(DEFAULT_CONFIG.configVersion).toBe(7);
  });

  it('ships a 90s movement cancel window by default (§6, draft number)', () => {
    expect(DEFAULT_CONFIG.movement.cancelWindowMs).toBe(90_000);
  });

  // Moved from `scouting.lossExponent` in M3a.1 (M3 §5): the casualty-curve exponent is now
  // shared between scout-vs-scout and regular battle resolution.
  it('ships the shared casualty-curve exponent at 1.5 (§5, draft number)', () => {
    expect(DEFAULT_CONFIG.combat.lossExponent).toBe(1.5);
  });

  // M3d.1, §13, owner decision 3: "Three 'Settler' units, trained at the Command Center".
  it('ships settle.settlersRequired at 3 (§13, draft number)', () => {
    expect(DEFAULT_CONFIG.settle.settlersRequired).toBe(3);
  });
});
