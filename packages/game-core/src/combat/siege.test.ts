import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config/index.js';
import type { TroopCounts } from '../units/index.js';
import type { BattleResult } from './battle.js';
import { resolveSiegePass, siegeResistance, type SiegeTargetState } from './siege.js';

const config = DEFAULT_CONFIG;

/** A prevailing attacker whose surviving army is exactly `survivors` (losses left empty — they
 * are irrelevant to `resolveSiegePass`, which reads only `attacker.survivors`; see the
 * dedicated "reads survivors, not the sent army" test below for the case where they differ). */
function prevailingAttacker(
  survivors: TroopCounts,
): Pick<BattleResult, 'attacker' | 'attackerPrevailed'> {
  return { attacker: { losses: [], survivors }, attackerPrevailed: true };
}

describe('siegeResistance', () => {
  it('level 1 -> resistanceBase, 6', () => {
    expect(siegeResistance(config, 1)).toBe(6);
  });

  it("level 7 -> 16.197324918143995 (6 * 1.18^6), the §7 worked draft's next-step value", () => {
    expect(siegeResistance(config, 7)).toBeCloseTo(16.197324918143995, 9);
  });

  it("level 10 -> 26.61272315490796 (6 * 1.18^9), the §7 worked draft's first cost", () => {
    expect(siegeResistance(config, 10)).toBeCloseTo(26.61272315490796, 9);
  });
});

describe('resolveSiegePass — §7 worked draft (wall)', () => {
  // docs/M3_DESIGN_DECISIONS.md §7: 10 Ram Trucks = 80 wall points (wallDamage 8 each) against
  // a L10 wall -> costs 26.61 + 22.55 + 19.11 = 68.28 spent, wall L10 -> L7, 11.72 points left
  // over -- and the L7 step would need 16.19, so they are discarded. This is a hand-computed
  // contract, so hardcoding its expected outcome here is correct — the same convention
  // `battle.test.ts` and `loot.test.ts` already use for their own §0 contract rows.
  it('reproduces the §7 worked draft exactly: L10 wall, 10 surviving Ram Trucks', () => {
    const battle = prevailingAttacker([{ unitType: 'ramTruck', count: 10 }]);
    const target: SiegeTargetState = {
      wallLevel: 10,
      siegeTarget: 'wall',
      targetBuildingLevel: 1, // irrelevant: siegeTarget is 'wall', so no building is touched.
    };

    const result = resolveSiegePass(config, battle, target);

    expect(result.wallPoints).toBe(80);
    expect(result.wallLevelBefore).toBe(10);
    expect(result.wallLevelAfter).toBe(7);
    expect(result.wallPointsSpent).toBeCloseTo(68.27872177434158, 9);
    expect(result.wallPointsDiscarded).toBeCloseTo(11.721278225658427, 9);
    expect(result.wallBreached).toBe(false); // L7 > 0 — the wall still stands.

    // siegeTarget: 'wall' — every building point (10 * buildingDamage 3 = 30) is wasted, the
    // attacker's own choice (§7), not an error.
    expect(result.buildingPoints).toBe(30);
    expect(result.buildingPointsSpent).toBe(0);
    expect(result.buildingPointsDiscarded).toBe(30);
    expect(result.targetLevelAfter).toBe(result.targetLevelBefore);
  });

  it('reads attacker.survivors, not the sent army: 20 sent, 10 survived -> 80 points, not 160', () => {
    // Mirrors the shape a real `resolveBattle` outcome would have: 10 of the 20 sent were lost.
    const battle: Pick<BattleResult, 'attacker' | 'attackerPrevailed'> = {
      attacker: {
        losses: [{ unitType: 'ramTruck', count: 10 }],
        survivors: [{ unitType: 'ramTruck', count: 10 }],
      },
      attackerPrevailed: true,
    };
    const target: SiegeTargetState = { wallLevel: 10, siegeTarget: 'wall', targetBuildingLevel: 1 };

    const result = resolveSiegePass(config, battle, target);

    expect(result.wallPoints).toBe(80); // 10 survivors * wallDamage 8, not 20 * 8 = 160.
    expect(result.buildingPoints).toBe(30); // 10 survivors * buildingDamage 3, not 20 * 3 = 60.
  });
});

describe('resolveSiegePass — building damage after the wall falls', () => {
  // §7: wall already at 0, siegeTarget: 'barracks' at L5, 10 Ram Trucks (buildingDamage 3 ->
  // 30 points) -> costs 11.63267 + 9.85819 + 8.35440 = 29.84526, Barracks L5 -> L2, 0.15474
  // discarded (the L2 step needs 7.08). Verified against the implementation (node repl, same
  // formula) before hardcoding: costs are 11.632666559999997, 9.858191999999999,
  // 8.354399999999998; sum 29.845258559999994; discarded 0.15474144000000578.
  it('L5 Barracks -> L2, 10 surviving Ram Trucks, wall already breached', () => {
    const battle = prevailingAttacker([{ unitType: 'ramTruck', count: 10 }]);
    const target: SiegeTargetState = {
      wallLevel: 0,
      siegeTarget: 'barracks',
      targetBuildingLevel: 5,
    };

    const result = resolveSiegePass(config, battle, target);

    expect(result.wallBreached).toBe(true); // wall was already at 0.
    // The wall phase still runs and still discards its own points — there is no wall level
    // left to knock down, so all 80 wall points go unused by the wall phase.
    expect(result.wallLevelAfter).toBe(0);
    expect(result.wallPointsSpent).toBe(0);
    expect(result.wallPointsDiscarded).toBe(80);

    expect(result.buildingPoints).toBe(30);
    expect(result.targetLevelBefore).toBe(5);
    expect(result.targetLevelAfter).toBe(2);
    expect(result.buildingPointsSpent).toBeCloseTo(29.845258559999994, 9);
    expect(result.buildingPointsDiscarded).toBeCloseTo(0.15474144000000578, 9);
  });
});

describe('resolveSiegePass — the wall gate', () => {
  it('a wall that survives the pass discards every building point untouched', () => {
    // L20 wall costs 6 * 1.18^19 per level -- far more than 10 Ram Trucks' 80 wall points can
    // afford, so the wall does not drop even one level.
    const battle = prevailingAttacker([{ unitType: 'ramTruck', count: 10 }]);
    const target: SiegeTargetState = {
      wallLevel: 20,
      siegeTarget: 'barracks',
      targetBuildingLevel: 5,
    };

    const result = resolveSiegePass(config, battle, target);

    expect(result.wallLevelAfter).toBe(20); // unchanged
    expect(result.wallPointsSpent).toBe(0);
    expect(result.wallPointsDiscarded).toBe(80);
    expect(result.wallBreached).toBe(false);

    // The wall survived -- every building point is discarded, the building is untouched.
    expect(result.buildingPointsSpent).toBe(0);
    expect(result.buildingPointsDiscarded).toBe(result.buildingPoints);
    expect(result.targetLevelAfter).toBe(result.targetLevelBefore);
  });
});

describe("resolveSiegePass — siegeTarget: 'wall'", () => {
  it('discards every building point even once the wall is down; no building is touched', () => {
    const battle = prevailingAttacker([{ unitType: 'ramTruck', count: 10 }]);
    const target: SiegeTargetState = {
      wallLevel: 0, // already breached
      siegeTarget: 'wall',
      targetBuildingLevel: 5,
    };

    const result = resolveSiegePass(config, battle, target);

    expect(result.wallBreached).toBe(true);
    expect(result.buildingPoints).toBe(30);
    expect(result.buildingPointsSpent).toBe(0);
    expect(result.buildingPointsDiscarded).toBe(30);
    expect(result.targetLevelAfter).toBe(5);
    expect(result.targetLevelBefore).toBe(5);
  });
});

describe('resolveSiegePass — the Command Center floor (owner decision 4: a settlement can never be destroyed)', () => {
  it('a CC at L3 hit with overwhelming points lands at exactly 1, never 0', () => {
    const battle = prevailingAttacker([{ unitType: 'ramTruck', count: 1000 }]);
    const target: SiegeTargetState = {
      wallLevel: 0,
      siegeTarget: 'commandCenter',
      targetBuildingLevel: 3,
    };

    const result = resolveSiegePass(config, battle, target);

    expect(result.targetLevelAfter).toBe(1);
    expect(result.buildingPointsDiscarded).toBeGreaterThan(0);
  });

  it('a CC already at L1 absorbs nothing and discards every point', () => {
    const battle = prevailingAttacker([{ unitType: 'ramTruck', count: 10 }]);
    const target: SiegeTargetState = {
      wallLevel: 0,
      siegeTarget: 'commandCenter',
      targetBuildingLevel: 1,
    };

    const result = resolveSiegePass(config, battle, target);

    expect(result.targetLevelAfter).toBe(1);
    expect(result.buildingPointsSpent).toBe(0);
    expect(result.buildingPointsDiscarded).toBe(30); // 10 Ram Trucks * buildingDamage 3.
  });
});

describe('resolveSiegePass — no siege units among survivors', () => {
  it('pure infantry survivors -> a complete no-op', () => {
    const battle = prevailingAttacker([{ unitType: 'torcher', count: 50 }]);
    const target: SiegeTargetState = {
      wallLevel: 10,
      siegeTarget: 'barracks',
      targetBuildingLevel: 5,
    };

    const result = resolveSiegePass(config, battle, target);

    expect(result.wallPoints).toBe(0);
    expect(result.buildingPoints).toBe(0);
    expect(result.wallLevelAfter).toBe(10);
    expect(result.wallPointsSpent).toBe(0);
    expect(result.wallPointsDiscarded).toBe(0);
    expect(result.targetLevelAfter).toBe(5);
    expect(result.buildingPointsSpent).toBe(0);
    expect(result.buildingPointsDiscarded).toBe(0);
  });
});

describe('resolveSiegePass — attackerPrevailed: false', () => {
  it('a complete no-op even with a large surviving siege stack (§7: a defeated attacker never gets a siege pass)', () => {
    const battle: Pick<BattleResult, 'attacker' | 'attackerPrevailed'> = {
      attacker: { losses: [], survivors: [{ unitType: 'ramTruck', count: 1000 }] },
      attackerPrevailed: false,
    };
    const target: SiegeTargetState = {
      wallLevel: 10,
      siegeTarget: 'barracks',
      targetBuildingLevel: 5,
    };

    const result = resolveSiegePass(config, battle, target);

    expect(result.wallPoints).toBe(0);
    expect(result.buildingPoints).toBe(0);
    expect(result.wallLevelAfter).toBe(10);
    expect(result.wallPointsSpent).toBe(0);
    expect(result.wallPointsDiscarded).toBe(0);
    expect(result.targetLevelAfter).toBe(5);
    expect(result.buildingPointsSpent).toBe(0);
    expect(result.buildingPointsDiscarded).toBe(0);
  });
});

describe('resolveSiegePass — purity', () => {
  it('is deterministic across repeated calls and never mutates the input target or survivors', () => {
    const survivors: TroopCounts = [{ unitType: 'ramTruck', count: 10 }];
    const survivorsCopy = survivors.map((s) => ({ ...s }));
    const battle = prevailingAttacker(survivors);
    const target: SiegeTargetState = {
      wallLevel: 10,
      siegeTarget: 'barracks',
      targetBuildingLevel: 5,
    };
    const targetCopy = { ...target };

    const first = resolveSiegePass(config, battle, target);
    const second = resolveSiegePass(config, battle, target);

    expect(first).toEqual(second);
    expect(survivors).toEqual(survivorsCopy);
    expect(target).toEqual(targetCopy);
  });
});
