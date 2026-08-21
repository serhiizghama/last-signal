import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../config/index.js';
import { isOfferRatioLegal, weightedResourceValue } from './offers.js';

const config = DEFAULT_CONFIG; // market.valueWeights: {scrap:1, fuel:1, electronics:2, food:1}, maxOfferRatio: 2

describe('weightedResourceValue', () => {
  it('scrap/fuel/food weight 1: value === amount', () => {
    expect(weightedResourceValue(config, 'scrap', 150)).toBe(150);
    expect(weightedResourceValue(config, 'fuel', 150)).toBe(150);
    expect(weightedResourceValue(config, 'food', 150)).toBe(150);
  });

  it('electronics weight 2 (M1 §1’s deliberate bottleneck): value === 2 * amount', () => {
    expect(weightedResourceValue(config, 'electronics', 150)).toBe(300);
  });

  it('amount 0 -> value 0, for every resource', () => {
    expect(weightedResourceValue(config, 'electronics', 0)).toBe(0);
  });
});

describe('isOfferRatioLegal — the §14 ratio cap, boundary inclusive both ends', () => {
  it('exactly the upper bound (ratio === maxOfferRatio, 2.0) is legal', () => {
    // giveValue 200 (scrap, weight 1), wantValue 100 (fuel, weight 1) -> ratio exactly 2.0
    expect(
      isOfferRatioLegal(
        config,
        { resource: 'scrap', amount: 200 },
        { resource: 'fuel', amount: 100 },
      ),
    ).toBe(true);
  });

  it('just above the upper bound (ratio 2.01) is illegal', () => {
    expect(
      isOfferRatioLegal(
        config,
        { resource: 'scrap', amount: 201 },
        { resource: 'fuel', amount: 100 },
      ),
    ).toBe(false);
  });

  it('exactly the lower bound (ratio === 1/maxOfferRatio, 0.5) is legal', () => {
    // giveValue 100, wantValue 200 -> ratio exactly 0.5
    expect(
      isOfferRatioLegal(
        config,
        { resource: 'scrap', amount: 100 },
        { resource: 'fuel', amount: 200 },
      ),
    ).toBe(true);
  });

  it('just below the lower bound (ratio 0.495) is illegal', () => {
    expect(
      isOfferRatioLegal(
        config,
        { resource: 'scrap', amount: 99 },
        { resource: 'fuel', amount: 200 },
      ),
    ).toBe(false);
  });

  it('an even 1:1 offer (ratio 1.0) is always legal, regardless of maxOfferRatio', () => {
    expect(
      isOfferRatioLegal(
        config,
        { resource: 'scrap', amount: 100 },
        { resource: 'fuel', amount: 100 },
      ),
    ).toBe(true);
  });

  it('applies the resource weight, not the raw amount — electronics counts double', () => {
    // giveValue = 2 * 100 = 200 (electronics), wantValue = 100 (fuel) -> ratio exactly 2.0
    expect(
      isOfferRatioLegal(
        config,
        { resource: 'electronics', amount: 100 },
        { resource: 'fuel', amount: 100 },
      ),
    ).toBe(true);
    // One electronics unit further pushes the ratio just past 2.0.
    expect(
      isOfferRatioLegal(
        config,
        { resource: 'electronics', amount: 101 },
        { resource: 'fuel', amount: 100 },
      ),
    ).toBe(false);
  });

  it('zero-amount guard: give.amount === 0 is illegal regardless of want', () => {
    expect(
      isOfferRatioLegal(
        config,
        { resource: 'scrap', amount: 0 },
        { resource: 'fuel', amount: 100 },
      ),
    ).toBe(false);
  });

  it('zero-amount guard: want.amount === 0 is illegal regardless of give', () => {
    expect(
      isOfferRatioLegal(
        config,
        { resource: 'scrap', amount: 100 },
        { resource: 'fuel', amount: 0 },
      ),
    ).toBe(false);
  });

  it('zero-amount guard: both amounts 0 (the 0/0 case) is illegal, not NaN-legal', () => {
    expect(
      isOfferRatioLegal(config, { resource: 'scrap', amount: 0 }, { resource: 'fuel', amount: 0 }),
    ).toBe(false);
  });
});
