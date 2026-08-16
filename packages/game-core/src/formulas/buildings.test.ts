import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config/index.js';
import type { BuildingLevels, GameConfig } from '../config/types.js';
import { calcTroopFoodUpkeepPerHour, type TroopCounts } from '../units/index.js';
import {
  calcBuildCost,
  calcBuildTimeMs,
  calcFoodUpkeepPerHour,
  calcInfluence,
  calcNetFoodPerHour,
  calcProductionPerHour,
  calcSettlementProduction,
  calcStorageCaps,
  meetsPrerequisites,
  missingPrerequisites,
  settlementsAllowed,
  wouldStarveSettlement,
  wouldStarveWithTroops,
} from './buildings.js';

const config = DEFAULT_CONFIG;

function withSpeed(base: GameConfig, patch: Partial<GameConfig['speed']>): GameConfig {
  return { ...base, speed: { ...base.speed, ...patch } };
}

describe('calcBuildCost', () => {
  // Golden values, hand-derived from roundCost(baseCost[r] * costRatio ** (level - 1)):
  // scrapYard (resource, costRatio 1.67) base { scrap: 40, fuel: 25, electronics: 10, food: 20 }.
  it('matches hand-computed golden cost vectors for scrapYard (resource family)', () => {
    expect(calcBuildCost(config, 'scrapYard', 1)).toEqual({
      scrap: 40,
      fuel: 25,
      electronics: 10,
      food: 20,
    });
    expect(calcBuildCost(config, 'scrapYard', 2)).toEqual({
      scrap: 67,
      fuel: 42,
      electronics: 17,
      food: 33,
    });
    expect(calcBuildCost(config, 'scrapYard', 5)).toEqual({
      scrap: 311,
      fuel: 194,
      electronics: 78,
      food: 156,
    });
    expect(calcBuildCost(config, 'scrapYard', 10)).toEqual({
      scrap: 4041,
      fuel: 2526,
      electronics: 1010,
      food: 2021,
    });
  });

  // commandCenter (functional, costRatio 1.28) base { scrap: 70, fuel: 40, electronics: 30, food: 20 }.
  it('matches hand-computed golden cost vectors for commandCenter (functional family)', () => {
    expect(calcBuildCost(config, 'commandCenter', 1)).toEqual({
      scrap: 70,
      fuel: 40,
      electronics: 30,
      food: 20,
    });
    expect(calcBuildCost(config, 'commandCenter', 2)).toEqual({
      scrap: 90,
      fuel: 51,
      electronics: 38,
      food: 26,
    });
    expect(calcBuildCost(config, 'commandCenter', 5)).toEqual({
      scrap: 188,
      fuel: 107,
      electronics: 81,
      food: 54,
    });
    expect(calcBuildCost(config, 'commandCenter', 10)).toEqual({
      scrap: 646,
      fuel: 369,
      electronics: 277,
      food: 184,
    });
  });

  it('is strictly increasing per level within each family', () => {
    for (const type of ['scrapYard', 'commandCenter'] as const) {
      const def = config.buildings[type];
      let previous = 0;
      for (let level = 1; level <= def.maxLevel; level += 1) {
        const scrap = calcBuildCost(config, type, level).scrap;
        expect(scrap).toBeGreaterThan(previous);
        previous = scrap;
      }
    }
  });

  it('grows much faster for the resource family than the functional family, relative to its own base', () => {
    const resourceGrowth =
      calcBuildCost(config, 'scrapYard', 10).scrap / calcBuildCost(config, 'scrapYard', 1).scrap;
    const functionalGrowth =
      calcBuildCost(config, 'commandCenter', 10).scrap /
      calcBuildCost(config, 'commandCenter', 1).scrap;
    expect(resourceGrowth).toBeGreaterThan(functionalGrowth * 5);
  });

  it('keeps a zero-cost component at zero (wall has no electronics cost)', () => {
    expect(calcBuildCost(config, 'wall', 5).electronics).toBe(0);
  });

  it('throws RangeError below level 1', () => {
    expect(() => calcBuildCost(config, 'scrapYard', 0)).toThrow(RangeError);
  });

  it('throws RangeError above maxLevel', () => {
    expect(() => calcBuildCost(config, 'scrapYard', 21)).toThrow(RangeError);
  });

  it('throws RangeError above the Hidden Cache reduced cap of 10', () => {
    expect(() => calcBuildCost(config, 'hiddenCache', 11)).toThrow(RangeError);
  });
});

describe('calcBuildTimeMs', () => {
  it('gives strictly decreasing times as Command Center level rises (0 vs 10 vs 20)', () => {
    const t0 = calcBuildTimeMs(config, 'scrapYard', 1, 0);
    const t10 = calcBuildTimeMs(config, 'scrapYard', 1, 10);
    const t20 = calcBuildTimeMs(config, 'scrapYard', 1, 20);
    expect(t10).toBeLessThan(t0);
    expect(t20).toBeLessThan(t10);
  });

  it('halves exactly when speed.build doubles (commandCenter L1, CC0: 500000ms -> 250000ms)', () => {
    const speed5 = calcBuildTimeMs(withSpeed(config, { build: 5 }), 'commandCenter', 1, 0);
    const speed10 = calcBuildTimeMs(withSpeed(config, { build: 10 }), 'commandCenter', 1, 0);
    expect(speed5).toBe(500_000);
    expect(speed10).toBe(250_000);
    expect(speed10).toBe(speed5 / 2);
  });

  it('always returns a whole number of seconds in ms', () => {
    for (const ccLevel of [0, 1, 7, 13]) {
      const ms = calcBuildTimeMs(config, 'electronicsWorkshop', 6, ccLevel);
      expect(ms % 1000).toBe(0);
    }
  });

  it('throws RangeError for a negative Command Center level', () => {
    expect(() => calcBuildTimeMs(config, 'scrapYard', 1, -1)).toThrow(RangeError);
  });

  it('throws RangeError on out-of-range levels', () => {
    expect(() => calcBuildTimeMs(config, 'scrapYard', 0, 0)).toThrow(RangeError);
    expect(() => calcBuildTimeMs(config, 'hiddenCache', 11, 0)).toThrow(RangeError);
  });
});

describe('calcProductionPerHour', () => {
  it('is 25/h for scrapYard at level 1 under DEFAULT_CONFIG', () => {
    expect(calcProductionPerHour(config, 'scrapYard', 1)).toBe(25);
  });

  it('is strictly increasing in level for every producer up to maxLevel', () => {
    const producers = [
      'scrapYard',
      'fuelRefinery',
      'electronicsWorkshop',
      'greenhouseFarm',
    ] as const;
    for (const type of producers) {
      const def = config.buildings[type];
      let previous = 0;
      for (let level = 1; level <= def.maxLevel; level += 1) {
        const value = calcProductionPerHour(config, type, level);
        expect(value).toBeGreaterThan(previous);
        previous = value;
      }
    }
  });

  it('is 0 for a non-producing building', () => {
    expect(calcProductionPerHour(config, 'wall', 10)).toBe(0);
  });

  it('is 0 for level 0 or below', () => {
    expect(calcProductionPerHour(config, 'scrapYard', 0)).toBe(0);
  });

  it('clamps to maxLevel instead of throwing above it', () => {
    const atCap = calcProductionPerHour(config, 'scrapYard', 20);
    const aboveCap = calcProductionPerHour(config, 'scrapYard', 25);
    expect(aboveCap).toBe(atCap);
  });

  it('scales linearly with config.speed.production', () => {
    const atSpeed5 = calcProductionPerHour(withSpeed(config, { production: 5 }), 'scrapYard', 1);
    const atSpeed10 = calcProductionPerHour(withSpeed(config, { production: 10 }), 'scrapYard', 1);
    expect(atSpeed10).toBe(atSpeed5 * 2);
  });
});

describe('calcSettlementProduction', () => {
  it('buckets output by resource and ignores non-producers', () => {
    const buildings: BuildingLevels = [
      { type: 'scrapYard', level: 1 },
      { type: 'fuelRefinery', level: 1 },
      { type: 'electronicsWorkshop', level: 1 },
      { type: 'greenhouseFarm', level: 1 },
      { type: 'wall', level: 5 },
    ];
    expect(calcSettlementProduction(config, buildings)).toEqual({
      scrap: 25,
      fuel: 25,
      electronics: 15,
      food: 30,
    });
  });

  it('is all zero for an empty settlement', () => {
    expect(calcSettlementProduction(config, [])).toEqual({
      scrap: 0,
      fuel: 0,
      electronics: 0,
      food: 0,
    });
  });
});

describe('food upkeep and net food', () => {
  // M1a.4b: DEFAULT_CONFIG.upkeep is now set, so calcFoodUpkeepPerHour uses the geometric
  // shape `foodUpkeepWeight * upkeep.ratio ** (level - 1) * speed.production` (ratio 1.58,
  // speed.production 5) instead of the legacy `foodUpkeepWeight * level`. Golden values below
  // are hand-recomputed from that formula, not generated by calling it. See
  // balance/progressionContract.test.ts for the tuned config's day 7/14/21 behaviour.
  it('sums the geometric per-building upkeep across buildings', () => {
    const buildings: BuildingLevels = [
      { type: 'commandCenter', level: 3 }, // weight 0.2: 0.2 * 1.58^2 * 5 = 2.4964
      { type: 'scrapYard', level: 2 }, // weight 0.1: 0.1 * 1.58^1 * 5 = 0.79
      { type: 'warehouse', level: 1 }, // weight 0.2: 0.2 * 1.58^0 * 5 = 1
    ];
    // 2.4964 + 0.79 + 1 = 4.2864
    expect(calcFoodUpkeepPerHour(config, buildings)).toBeCloseTo(4.2864, 6);
  });

  it('goes negative when upkeep exceeds production', () => {
    const buildings: BuildingLevels = [
      { type: 'greenhouseFarm', level: 1 }, // 30/h food
      { type: 'commandCenter', level: 16 }, // upkeep 0.2 * 1.58^15 * 5 = 954.6766584233...
    ];
    expect(calcNetFoodPerHour(config, buildings)).toBeCloseTo(30 - 954.6766584233, 4);
  });

  it('wouldStarveSettlement correctly flags starvation at a high Command Center level', () => {
    // Under the legacy linear formula this baseline (CC10 + a single L1 greenhouse) sat
    // exactly at the boundary the old comments described (net +10 at CC10, crossing to
    // negative between CC14-16). Under the geometric shape the same baseline is already
    // starving well before CC10 (CC10 alone needs ~61.4/h against 30/h produced), so all
    // three of the old test levels (14/15/16) are starved — there is no clean false/true
    // boundary left to demonstrate at these levels with a lone L1 greenhouse. This still
    // legitimately exercises the guard (it must correctly say "yes, starves" at every one
    // of these levels); a future step may want a fresh scenario if a boundary example is
    // wanted again — that would mean picking new building levels, which is a test-logic
    // change outside M1a.4b's scope (constant-only tuning).
    const buildings: BuildingLevels = [
      { type: 'greenhouseFarm', level: 1 },
      { type: 'commandCenter', level: 10 },
    ];

    expect(wouldStarveSettlement(config, buildings, 'commandCenter', 14)).toBe(true);
    expect(wouldStarveSettlement(config, buildings, 'commandCenter', 15)).toBe(true);
    expect(wouldStarveSettlement(config, buildings, 'commandCenter', 16)).toBe(true);
  });

  it('does not mutate its input array', () => {
    const buildings: BuildingLevels = [
      { type: 'greenhouseFarm', level: 1 },
      { type: 'commandCenter', level: 10 },
    ];
    const snapshot = buildings.map((b) => ({ ...b }));
    wouldStarveSettlement(config, buildings, 'commandCenter', 16);
    expect(buildings).toEqual(snapshot);
  });
});

describe('troop Food upkeep in net Food (§7)', () => {
  it('omitting troops behaves exactly like an empty troop list', () => {
    const buildings: BuildingLevels = [{ type: 'greenhouseFarm', level: 3 }];
    expect(calcNetFoodPerHour(config, buildings)).toBe(calcNetFoodPerHour(config, buildings, []));
  });

  it('subtracts exactly the troop-list Food upkeep from net Food', () => {
    const buildings: BuildingLevels = [{ type: 'greenhouseFarm', level: 5 }];
    const troops: TroopCounts = [
      { unitType: 'lookout', count: 4 },
      { unitType: 'falconer', count: 2 },
    ];
    const withoutTroops = calcNetFoodPerHour(config, buildings);
    const withTroops = calcNetFoodPerHour(config, buildings, troops);
    expect(withTroops).toBeCloseTo(withoutTroops - calcTroopFoodUpkeepPerHour(config, troops), 9);
  });
});

describe('wouldStarveWithTroops (the training gate, §7)', () => {
  it('accepts a batch the settlement can comfortably feed', () => {
    const buildings: BuildingLevels = [{ type: 'greenhouseFarm', level: 10 }];
    expect(wouldStarveWithTroops(config, buildings, [], [{ unitType: 'lookout', count: 1 }])).toBe(
      false,
    );
  });

  it('rejects a batch too large for net Food but accepts one just under the limit', () => {
    const buildings: BuildingLevels = [{ type: 'greenhouseFarm', level: 1 }]; // 30/h food, no upkeep
    const netFood = calcNetFoodPerHour(config, buildings);
    const upkeepPerUnit = config.units.lookout.foodUpkeepPerHour;
    const tooMany = Math.ceil(netFood / upkeepPerUnit) + 5;
    const fitsComfortably = Math.floor(netFood / upkeepPerUnit) - 1;

    expect(
      wouldStarveWithTroops(config, buildings, [], [{ unitType: 'lookout', count: tooMany }]),
    ).toBe(true);
    expect(
      wouldStarveWithTroops(
        config,
        buildings,
        [],
        [{ unitType: 'lookout', count: fitsComfortably }],
      ),
    ).toBe(false);
  });

  it('is absolute: a settlement already net-negative can never train, even a batch of 0', () => {
    // Same starving combination as the `calcNetFoodPerHour` "goes negative" case above.
    const buildings: BuildingLevels = [
      { type: 'greenhouseFarm', level: 1 },
      { type: 'commandCenter', level: 16 },
    ];
    expect(calcNetFoodPerHour(config, buildings)).toBeLessThan(0);
    expect(wouldStarveWithTroops(config, buildings, [], [])).toBe(true);
    expect(wouldStarveWithTroops(config, buildings, [], [{ unitType: 'lookout', count: 1 }])).toBe(
      true,
    );
  });

  it('accounts for troops already at home, not just the added batch', () => {
    const buildings: BuildingLevels = [{ type: 'greenhouseFarm', level: 1 }]; // 30/h food
    const netFood = calcNetFoodPerHour(config, buildings);
    const upkeepPerUnit = config.units.lookout.foodUpkeepPerHour;
    // Leave just under 5 units' worth of Food headroom after the existing troops' own upkeep.
    const existingCount = Math.floor(netFood / upkeepPerUnit) - 5;
    const existing: TroopCounts = [{ unitType: 'lookout', count: existingCount }];

    expect(
      wouldStarveWithTroops(config, buildings, existing, [{ unitType: 'lookout', count: 4 }]),
    ).toBe(false);
    expect(
      wouldStarveWithTroops(config, buildings, existing, [{ unitType: 'lookout', count: 6 }]),
    ).toBe(true);
  });

  it('does not mutate either troop list', () => {
    const buildings: BuildingLevels = [{ type: 'greenhouseFarm', level: 5 }];
    const troops: TroopCounts = [{ unitType: 'lookout', count: 2 }];
    const added: TroopCounts = [{ unitType: 'falconer', count: 1 }];
    const troopsSnapshot = troops.map((t) => ({ ...t }));
    const addedSnapshot = added.map((t) => ({ ...t }));
    wouldStarveWithTroops(config, buildings, troops, added);
    expect(troops).toEqual(troopsSnapshot);
    expect(added).toEqual(addedSnapshot);
  });
});

describe('calcStorageCaps', () => {
  // M1a.4b: storage.generalBase/foodBase raised 800 -> 4000 and generalRatio/foodRatio
  // raised 1.25 -> 1.30 to remove the storage ceiling (see progressionContract.test.ts).
  // Golden values below are hand-recomputed from those new constants.
  it('yields the base caps at level 0 for both warehouse and cold storage', () => {
    expect(calcStorageCaps(config, [])).toEqual({
      scrap: 4000,
      fuel: 4000,
      electronics: 4000,
      food: 4000,
    });
  });

  it('applies the general cap equally to scrap, fuel and electronics, independent of food', () => {
    const buildings: BuildingLevels = [{ type: 'warehouse', level: 2 }];
    // 4000 * 1.30^2 = 6760
    expect(calcStorageCaps(config, buildings)).toEqual({
      scrap: 6760,
      fuel: 6760,
      electronics: 6760,
      food: 4000,
    });
  });

  it('grows the food cap independently with Cold Storage level', () => {
    const buildings: BuildingLevels = [
      { type: 'warehouse', level: 2 },
      { type: 'coldStorage', level: 1 },
    ];
    // 4000 * 1.30^1 = 5200
    expect(calcStorageCaps(config, buildings)).toEqual({
      scrap: 6760,
      fuel: 6760,
      electronics: 6760,
      food: 5200,
    });
  });
});

describe('prerequisites', () => {
  it('lists both missing requirements for market when nothing is built', () => {
    expect(missingPrerequisites(config, [], 'market')).toEqual([
      { type: 'commandCenter', level: 3 },
      { type: 'warehouse', level: 3 },
    ]);
  });

  it('lists only the still-missing requirement when one is met', () => {
    const buildings: BuildingLevels = [{ type: 'commandCenter', level: 3 }];
    expect(missingPrerequisites(config, buildings, 'market')).toEqual([
      { type: 'warehouse', level: 3 },
    ]);
  });

  it('lists no missing requirements once all are met', () => {
    const buildings: BuildingLevels = [
      { type: 'commandCenter', level: 3 },
      { type: 'warehouse', level: 3 },
    ];
    expect(missingPrerequisites(config, buildings, 'market')).toEqual([]);
    expect(meetsPrerequisites(config, buildings, 'market')).toBe(true);
  });

  it('always allows a building with no requirements, even with nothing built', () => {
    expect(meetsPrerequisites(config, [], 'scrapYard')).toBe(true);
  });
});

describe('influence', () => {
  it('weights the Command Center at x3 across multiple settlements', () => {
    const settlements: BuildingLevels[] = [
      [
        { type: 'commandCenter', level: 5 },
        { type: 'scrapYard', level: 3 },
      ],
      [
        { type: 'commandCenter', level: 2 },
        { type: 'wall', level: 4 },
      ],
    ];
    // settlement 1: 3*5 + 1*3 = 18; settlement 2: 3*2 + 1*4 = 10; total 28
    expect(calcInfluence(config, settlements)).toBe(28);
  });

  it('is 0 for an empty account', () => {
    expect(calcInfluence(config, [])).toBe(0);
  });

  it('settlementsAllowed returns 1 below 90, 2 at 90, 3 at 160, and never exceeds maxSettlements', () => {
    expect(settlementsAllowed(config, 0)).toBe(1);
    expect(settlementsAllowed(config, 89)).toBe(1);
    expect(settlementsAllowed(config, 90)).toBe(2);
    expect(settlementsAllowed(config, 159)).toBe(2);
    expect(settlementsAllowed(config, 160)).toBe(3);
    expect(settlementsAllowed(config, 10_000)).toBe(3);
  });
});
