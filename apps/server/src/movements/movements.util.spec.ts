import { DEFAULT_CONFIG } from '@last-signal/game-core';
import { describe, expect, it } from 'vitest';

import { isSendableMovementType, sumAttackPoints } from './movements.util';

// Direct unit coverage for `sumAttackPoints` (M3c.3, §9 step 1) — the helper
// `MovementsService.sendMovement`'s `noAttackPower` rejection is built on. That rejection
// can't be exercised through `DEFAULT_CONFIG`'s real catalogue via the integration suite:
// every unit type allowed on a `raid`/`assault` army (i.e. not scout/wildlife/settler) has
// `attack > 0` — see this function's own comment in `movements.util.ts`. Tested here directly
// instead, against fabricated configs, so the `atkPts <= 0` branch still has real coverage.
describe('sumAttackPoints', () => {
  it('sums attack * count across every entry, in any order', () => {
    const total = sumAttackPoints(DEFAULT_CONFIG, [
      { unitType: 'brute', count: 3 }, // attack 40
      { unitType: 'torcher', count: 2 }, // attack 10
    ]);
    expect(total).toBe(
      DEFAULT_CONFIG.units.brute.attack * 3 + DEFAULT_CONFIG.units.torcher.attack * 2,
    );
  });

  it('is 0 for an empty list', () => {
    expect(sumAttackPoints(DEFAULT_CONFIG, [])).toBe(0);
  });

  it('is 0 for a scout-only army — this is exactly the case `noAttackPower` exists to catch', () => {
    // Every scout's `attack` is 0 (M3 §1: "attack is 0 -- scouts never attack in regular
    // combat"). A real `raid`/`assault` request built entirely from scouts is caught earlier
    // by `scoutsInArmy`, but this proves the underlying arithmetic independently of that.
    const total = sumAttackPoints(DEFAULT_CONFIG, [{ unitType: 'lookout', count: 10 }]);
    expect(total).toBe(0);
  });

  it('skips any entry that is not a real catalogued unit type rather than throwing', () => {
    const total = sumAttackPoints(DEFAULT_CONFIG, [
      { unitType: 'not-a-real-unit', count: 5 },
      { unitType: 'brute', count: 1 },
    ]);
    expect(total).toBe(DEFAULT_CONFIG.units.brute.attack);
  });

  it('reproduces the noAttackPower rejection against a fabricated 0-attack combat unit — the case unreachable through the real catalogue', () => {
    // A config identical to `DEFAULT_CONFIG` except one normally-attacking unit is patched to
    // 0 attack, proving `atkPts <= 0` really is reachable by the formula even though no real
    // catalogued non-scout/wildlife/settler unit triggers it today.
    const zeroAttackConfig = {
      ...DEFAULT_CONFIG,
      units: {
        ...DEFAULT_CONFIG.units,
        brute: { ...DEFAULT_CONFIG.units.brute, attack: 0 },
      },
    };
    const total = sumAttackPoints(zeroAttackConfig, [{ unitType: 'brute', count: 50 }]);
    expect(total).toBe(0);
  });
});

// `isSendableMovementType` narrows the DTO's raw `type: string` to the five types
// `sendMovement` can actually produce (M3c.3 shipped four, §9; M3d.1 adds `settle`, §13).
// `trade` reached the `Movement` schema's storage-level union in M3c.2 but still has no send
// path — the Market is a later M3d step.
describe('isSendableMovementType', () => {
  it('is true for scout, raid, assault, support and settle', () => {
    expect(isSendableMovementType('scout')).toBe(true);
    expect(isSendableMovementType('raid')).toBe(true);
    expect(isSendableMovementType('assault')).toBe(true);
    expect(isSendableMovementType('support')).toBe(true);
    expect(isSendableMovementType('settle')).toBe(true);
  });

  it('is false for trade — schema-widened in M3c.2, no send path yet (the Market)', () => {
    expect(isSendableMovementType('trade')).toBe(false);
  });

  it('is false for an arbitrary unrecognised string', () => {
    expect(isSendableMovementType('not-a-real-type')).toBe(false);
  });
});
