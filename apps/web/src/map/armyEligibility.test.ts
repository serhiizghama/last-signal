import { DEFAULT_CONFIG } from '@last-signal/game-core';
import { describe, expect, it } from 'vitest';

import { armyUnitOptions, computeAttackBlockReason, sumAttackPoints } from './armyEligibility';

// Raiders' catalogue entries used throughout: `brute` (offenseInfantry), `torcher`
// (defenseInfantry), `lookout` (scout), `biker` (fast/cavalry), `ramTruck` (siege), `settler`
// (settler, faction-neutral), `feralDog` (wildlife, faction-neutral).
const HOME_TROOPS = [
  { unitType: 'brute' as const, count: 10 },
  { unitType: 'torcher' as const, count: 5 },
  { unitType: 'lookout' as const, count: 3 },
  { unitType: 'biker' as const, count: 2 },
  { unitType: 'ramTruck' as const, count: 4 },
];

describe('armyUnitOptions (§1/§9 role rules)', () => {
  it('a raid never offers scouts or siege units, but offers every ordinary combat unit at home', () => {
    const options = armyUnitOptions(DEFAULT_CONFIG, 'raid', HOME_TROOPS);
    expect(options.map((o) => o.unitType).sort()).toEqual(['biker', 'brute', 'torcher']);
  });

  it('an assault offers siege units too, still never scouts', () => {
    const options = armyUnitOptions(DEFAULT_CONFIG, 'assault', HOME_TROOPS);
    expect(options.map((o) => o.unitType).sort()).toEqual([
      'biker',
      'brute',
      'ramTruck',
      'torcher',
    ]);
  });

  it("support offers scouts (§8: stationed scouts count for the host's defence) but never siege units", () => {
    const options = armyUnitOptions(DEFAULT_CONFIG, 'support', HOME_TROOPS);
    expect(options.map((o) => o.unitType).sort()).toEqual(['biker', 'brute', 'lookout', 'torcher']);
  });

  it('is bounded by exactly what is at home, never the full roster', () => {
    const options = armyUnitOptions(DEFAULT_CONFIG, 'raid', HOME_TROOPS);
    const brute = options.find((o) => o.unitType === 'brute');
    expect(brute?.availableCount).toBe(10);
    // exoTrooper (Engineers) is never at home in a Raiders settlement's `troops` in the first
    // place — this asserts the filter is driven by `troops`, not by iterating the catalogue.
    expect(options.some((o) => o.unitType === 'exoTrooper')).toBe(false);
  });

  it('settlers and wildlife are never offered, even if somehow present in troops', () => {
    const troopsWithOddities = [
      ...HOME_TROOPS,
      { unitType: 'settler' as const, count: 3 },
      { unitType: 'feralDog' as const, count: 1 },
    ];
    for (const type of ['raid', 'assault', 'support'] as const) {
      const options = armyUnitOptions(DEFAULT_CONFIG, type, troopsWithOddities);
      expect(options.some((o) => o.unitType === 'settler')).toBe(false);
      expect(options.some((o) => o.unitType === 'feralDog')).toBe(false);
    }
  });
});

describe('sumAttackPoints', () => {
  it("sums each unit's attack × count", () => {
    const points = sumAttackPoints(DEFAULT_CONFIG, [
      { unitType: 'brute', count: 10 },
      { unitType: 'torcher', count: 5 },
    ]);
    expect(points).toBe(
      DEFAULT_CONFIG.units.brute.attack * 10 + DEFAULT_CONFIG.units.torcher.attack * 5,
    );
  });

  it('is 0 for an empty selection', () => {
    expect(sumAttackPoints(DEFAULT_CONFIG, [])).toBe(0);
  });
});

describe('computeAttackBlockReason (§9)', () => {
  it('blocks an empty selection', () => {
    expect(computeAttackBlockReason(DEFAULT_CONFIG, 'raid', [], false, undefined)).toEqual({
      kind: 'emptyUnits',
    });
  });

  it('does not block a non-empty support selection with no attack power', () => {
    // support has no attack requirement — scouts (attack: 0) alone are a legal garrison.
    expect(
      computeAttackBlockReason(
        DEFAULT_CONFIG,
        'support',
        [{ unitType: 'lookout' as const, count: 1 }],
        false,
        undefined,
      ),
    ).toBeUndefined();
  });

  it('requires a siegeTarget once a siege unit is selected on an assault', () => {
    const selected = [{ unitType: 'ramTruck' as const, count: 1 }];
    expect(computeAttackBlockReason(DEFAULT_CONFIG, 'assault', selected, true, undefined)).toEqual({
      kind: 'siegeTargetRequired',
    });
    expect(
      computeAttackBlockReason(DEFAULT_CONFIG, 'assault', selected, true, 'wall'),
    ).toBeUndefined();
  });

  it('is satisfied by an ordinary raid/assault selection with real attack power', () => {
    const selected = [{ unitType: 'brute' as const, count: 5 }];
    expect(
      computeAttackBlockReason(DEFAULT_CONFIG, 'raid', selected, false, undefined),
    ).toBeUndefined();
  });
});
