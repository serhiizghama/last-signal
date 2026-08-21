import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../config/index.js';
import type { Faction } from '../config/types.js';
import { FACTIONS } from '../config/types.js';
import {
  merchantCapacity,
  merchantSpeed,
  merchantsFromMarketLevel,
  merchantsNeededFor,
} from './merchants.js';

const config = DEFAULT_CONFIG; // market.merchantsPerLevel: 1

describe('merchantsFromMarketLevel', () => {
  it('level 0 -> 0 merchants (no Market)', () => {
    expect(merchantsFromMarketLevel(config, 0)).toBe(0);
  });

  it('level 1 -> merchantsPerLevel (1)', () => {
    expect(merchantsFromMarketLevel(config, 1)).toBe(1);
  });

  it('level 20 -> merchantsPerLevel * 20', () => {
    expect(merchantsFromMarketLevel(config, 20)).toBe(20);
  });

  it('negative levels are floored to 0, same defensive convention as hiddenCacheProtection', () => {
    expect(merchantsFromMarketLevel(config, -3)).toBe(0);
  });
});

// §14's table: Raiders 1000/12, Engineers 500/16, Nomads 750/24.
describe('merchantCapacity / merchantSpeed — every faction (§14)', () => {
  const expected: Record<Faction, { capacity: number; speed: number }> = {
    raiders: { capacity: 1000, speed: 12 },
    engineers: { capacity: 500, speed: 16 },
    nomads: { capacity: 750, speed: 24 },
  };

  for (const faction of FACTIONS) {
    it(`${faction}: capacity ${expected[faction].capacity}, speed ${expected[faction].speed}`, () => {
      expect(merchantCapacity(config, faction)).toBe(expected[faction].capacity);
      expect(merchantSpeed(config, faction)).toBe(expected[faction].speed);
    });
  }
});

describe('merchantsNeededFor', () => {
  it('amount 0 -> 0 merchants, no minimum', () => {
    expect(merchantsNeededFor(config, 'raiders', 0)).toBe(0);
  });

  it('an amount under one merchant’s capacity still needs exactly 1', () => {
    expect(merchantsNeededFor(config, 'raiders', 1)).toBe(1);
    expect(merchantsNeededFor(config, 'raiders', 999)).toBe(1);
  });

  it('an amount exactly at capacity needs exactly 1, not 2', () => {
    expect(merchantsNeededFor(config, 'raiders', 1000)).toBe(1);
  });

  it('one unit over capacity needs 2 (ceil, not floor)', () => {
    expect(merchantsNeededFor(config, 'raiders', 1001)).toBe(2);
  });

  it('scales per faction capacity — Engineers need more merchants for the same amount', () => {
    expect(merchantsNeededFor(config, 'engineers', 1001)).toBe(3); // ceil(1001/500)
    expect(merchantsNeededFor(config, 'nomads', 1001)).toBe(2); // ceil(1001/750)
  });
});
