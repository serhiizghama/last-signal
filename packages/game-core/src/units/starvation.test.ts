import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config/index.js';
import type { BuildingLevels, GameConfig } from '../config/types.js';
import { UNIT_TYPES } from '../config/types.js';
import { calcFoodUpkeepPerHour, calcNetFoodPerHour } from '../formulas/buildings.js';
import { resolveStarvation, starvationOrder, type StarvationContingent } from './starvation.js';
import type { TroopCounts } from './troops.js';

const config = DEFAULT_CONFIG;

/** Narrows an indexed-access read (`noUncheckedIndexedAccess`) after asserting it is in range. */
function assertDefined<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

// The real units with a nonzero upkeep, in starvation-kill order — the two wildlife types
// (0 upkeep) are excluded so every test below has a genuinely killable weakest unit.
const killableOrder = starvationOrder(config).filter((t) => config.units[t].foodUpkeepPerHour > 0);
const WEAK = assertDefined(killableOrder[0], 'expected at least one killable unit type');
const NEXT = assertDefined(killableOrder[1], 'expected at least two killable unit types');
const uWeak = config.units[WEAK].foodUpkeepPerHour;
const uNext = config.units[NEXT].foodUpkeepPerHour;

/** Smallest Greenhouse Farm level whose hourly production alone covers `minFood` (headroom). */
function farmLevelCovering(minFood: number): number {
  for (let level = 1; level <= config.buildings.greenhouseFarm.maxLevel; level += 1) {
    const headroom = calcNetFoodPerHour(config, [{ type: 'greenhouseFarm', level }], []);
    if (headroom >= minFood) {
      return level;
    }
  }
  throw new Error('farmLevelCovering: no level of Greenhouse Farm covers the requested amount');
}

describe('starvationOrder', () => {
  it('returns every unit type exactly once', () => {
    const order = starvationOrder(config);
    expect(order).toHaveLength(UNIT_TYPES.length);
    expect(new Set(order).size).toBe(UNIT_TYPES.length);
    for (const unitType of UNIT_TYPES) {
      expect(order).toContain(unitType);
    }
  });

  it('sorts every settler after every non-settler', () => {
    const order = starvationOrder(config);
    const lastNonSettlerIndex = Math.max(
      ...order.map((t, i) => (config.units[t].role === 'settler' ? -1 : i)),
    );
    const firstSettlerIndex = order.findIndex((t) => config.units[t].role === 'settler');
    expect(firstSettlerIndex).toBeGreaterThan(lastNonSettlerIndex);
  });

  it('sorts every siege unit after every non-siege, non-settler unit and before every settler (owner decision 2026-08-17, §4)', () => {
    const order = starvationOrder(config);
    const indexOf = (unitType: string) => order.findIndex((t) => t === unitType);

    const nonSiegeNonSettlerIndices = order
      .map((t, i) =>
        config.units[t].role === 'siege' || config.units[t].role === 'settler' ? -1 : i,
      )
      .filter((i) => i >= 0);
    const siegeIndices = order
      .map((t, i) => (config.units[t].role === 'siege' ? i : -1))
      .filter((i) => i >= 0);
    const settlerIndices = order
      .map((t, i) => (config.units[t].role === 'settler' ? i : -1))
      .filter((i) => i >= 0);

    expect(siegeIndices.length).toBeGreaterThan(0);
    expect(Math.min(...siegeIndices)).toBeGreaterThan(Math.max(...nonSiegeNonSettlerIndices));
    expect(Math.min(...settlerIndices)).toBeGreaterThan(Math.max(...siegeIndices));

    // All three siege units by name, per the brief.
    expect(indexOf('ramTruck')).toBeGreaterThan(Math.max(...nonSiegeNonSettlerIndices));
    expect(indexOf('railSling')).toBeGreaterThan(Math.max(...nonSiegeNonSettlerIndices));
    expect(indexOf('ballistaWagon')).toBeGreaterThan(Math.max(...nonSiegeNonSettlerIndices));
    expect(indexOf('ramTruck')).toBeLessThan(Math.min(...settlerIndices));
    expect(indexOf('railSling')).toBeLessThan(Math.min(...settlerIndices));
    expect(indexOf('ballistaWagon')).toBeLessThan(Math.min(...settlerIndices));
  });

  it('is non-decreasing by combat weight across the non-siege, non-settler prefix', () => {
    const order = starvationOrder(config).filter(
      (t) => config.units[t].role !== 'settler' && config.units[t].role !== 'siege',
    );
    const weights = order.map((t) => {
      const def = config.units[t];
      return def.attack + def.defInfantry + def.defCavalry;
    });
    let previous = -Infinity;
    for (const weight of weights) {
      expect(weight).toBeGreaterThanOrEqual(previous);
      previous = weight;
    }
  });

  it("places every scout before every combat unit (verifying the design record's claim)", () => {
    const order = starvationOrder(config);
    const combatRoles = new Set(['offenseInfantry', 'defenseInfantry', 'fast', 'siege']);
    const scoutIndices = order
      .map((t, i) => (config.units[t].role === 'scout' ? i : -1))
      .filter((i) => i >= 0);
    const combatIndices = order
      .map((t, i) => (combatRoles.has(config.units[t].role) ? i : -1))
      .filter((i) => i >= 0);
    const lastScoutIndex = Math.max(...scoutIndices);
    const firstCombatIndex = Math.min(...combatIndices);
    expect(lastScoutIndex).toBeLessThan(firstCombatIndex);
  });

  it('is stable and deterministic across repeated calls', () => {
    expect(starvationOrder(config)).toEqual(starvationOrder(config));
  });

  it('breaks a stat-sum tie by ascending total training cost', () => {
    // Clone the config and force two non-settler units to share an identical combat weight
    // but keep (and clarify) different training costs, isolating the tie-break rule.
    const clone: GameConfig = structuredClone(config);
    const cheaper = 'brute';
    const costlier = 'torcher';
    clone.units[cheaper] = {
      ...clone.units[cheaper],
      attack: 20,
      defInfantry: 20,
      defCavalry: 10,
      cost: { scrap: 10, fuel: 10, electronics: 10, food: 10 }, // total 40
    };
    clone.units[costlier] = {
      ...clone.units[costlier],
      attack: 20,
      defInfantry: 20,
      defCavalry: 10,
      cost: { scrap: 100, fuel: 100, electronics: 100, food: 100 }, // total 400
    };
    const order = starvationOrder(clone);
    expect(order.indexOf(cheaper)).toBeLessThan(order.indexOf(costlier));
  });
});

describe('resolveStarvation', () => {
  it('kills nothing and reports resolved: true when net Food is already >= 0', () => {
    const buildings: BuildingLevels = [];
    const troops: TroopCounts = [];
    const awayTroops: TroopCounts = [];
    const stationed: StarvationContingent[] = [];
    const result = resolveStarvation(config, { buildings, troops, awayTroops, stationed });
    expect(result.resolved).toBe(true);
    expect(result.netFoodPerHourAfter).toBe(0);
    expect(result.killed).toEqual({ troops: [], stationed: [] });
    expect(result.remaining).toEqual({ troops: [], stationed: [] });
  });

  it('kills the weakest type first, only as many as needed to reach net >= 0', () => {
    // Headroom covers NEXT's own upkeep with a bit of slack left over; WEAK bears the rest of
    // the deficit and only some of it needs to die to close the gap.
    const otherCount = 2;
    // Ask for enough headroom that, after paying NEXT's upkeep, at least 4 WEAK units' worth
    // of slack remains — otherwise the margin added to `weakCount` below could theoretically
    // get eaten entirely by rounding and leave no survivors, which would defeat the test.
    const level = farmLevelCovering(otherCount * uNext + 4 * uWeak);
    const buildings: BuildingLevels = [{ type: 'greenhouseFarm', level }];
    const headroom = calcNetFoodPerHour(config, buildings, []);
    const slack = headroom - otherCount * uNext;
    expect(slack).toBeGreaterThan(0);

    const weakCount = Math.ceil(slack / uWeak) + 5;
    const troops: TroopCounts = [
      { unitType: WEAK, count: weakCount },
      { unitType: NEXT, count: otherCount },
    ];
    const result = resolveStarvation(config, { buildings, troops, awayTroops: [], stationed: [] });

    expect(result.resolved).toBe(true);
    expect(result.netFoodPerHourAfter).toBeGreaterThanOrEqual(0);

    // NEXT is fully paid for by headroom and never touched.
    expect(result.remaining.troops.find((t) => t.unitType === NEXT)?.count).toBe(otherCount);
    expect(result.killed.troops.find((t) => t.unitType === NEXT)).toBeUndefined();

    // Only part of WEAK died.
    const survivors = result.remaining.troops.find((t) => t.unitType === WEAK)?.count ?? 0;
    expect(survivors).toBeGreaterThan(0);
    expect(survivors).toBeLessThan(weakCount);

    // Minimality: sparing one more WEAK unit would still leave net Food negative.
    const oneFewerKilled: TroopCounts = [
      { unitType: WEAK, count: survivors + 1 },
      { unitType: NEXT, count: otherCount },
    ];
    expect(calcNetFoodPerHour(config, buildings, oneFewerKilled)).toBeLessThan(0);
  });

  it('starves stationed guests before home troops, and can drain a contingent to empty', () => {
    // A big home-troops buffer absorbs whatever the small stationed contingent doesn't cover,
    // so the assertion "some home troops survive" isn't a coincidence of the numbers chosen.
    // (Pre owner-decision-2026-08-17 this test used `awayTroops` as that buffer; awayTroops is
    // no longer a kill target at all, so home troops takes over that role here — see the two
    // dedicated `awayTroops` tests below for the exemption itself.)
    const homeCount = 1000;
    const guestCount = 2;
    const buildings: BuildingLevels = [{ type: 'greenhouseFarm', level: 1 }];
    const headroom = calcNetFoodPerHour(config, buildings, []);
    const troops: TroopCounts = [{ unitType: WEAK, count: homeCount }];
    const stationed: StarvationContingent[] = [
      { key: 'guest', troops: [{ unitType: WEAK, count: guestCount }] },
    ];
    // Sanity precondition: headroom is nowhere near enough to cover the combined upkeep, so
    // the deficit is guaranteed to consume the (tiny) guest fully and still spill into home
    // troops — proving the kill order, rather than the guest happening to cover everything.
    expect(headroom).toBeLessThan(homeCount * uWeak);

    const result = resolveStarvation(config, { buildings, troops, awayTroops: [], stationed });

    // The stationed contingent bled (fully, being tiny relative to the deficit) but survives
    // as a {key, troops: []} record rather than being dropped.
    expect(result.killed.stationed).toEqual([
      { key: 'guest', troops: [{ unitType: WEAK, count: 2 }] },
    ]);
    expect(result.remaining.stationed).toEqual([{ key: 'guest', troops: [] }]);

    // Home troops absorbed whatever the guest's 2 units didn't cover — some died, some didn't.
    const homeSurvivors = result.remaining.troops.find((t) => t.unitType === WEAK)?.count ?? 0;
    expect(homeSurvivors).toBeGreaterThan(0);
    expect(homeSurvivors).toBeLessThan(homeCount);

    expect(result.netFoodPerHourAfter).toBeGreaterThanOrEqual(0);
  });

  it('never kills awayTroops, even when they are the only troops present and the deficit is large (owner decision 2026-08-17, §4)', () => {
    // Command Center: real upkeep, zero production — the deficit can only ever be closed by
    // killing something (§4, "buildings never starve"). Here nothing killable exists at all:
    // `troops` and `stationed` are both empty, so `awayTroops` is the only lever left, and it
    // must not move.
    const buildings: BuildingLevels = [{ type: 'commandCenter', level: 1 }];
    const awayTroops: TroopCounts = [{ unitType: WEAK, count: 500 }];

    const result = resolveStarvation(config, { buildings, troops: [], awayTroops, stationed: [] });

    expect(result.killed.troops).toEqual([]);
    expect(result.killed.stationed).toEqual([]);
    expect(result.remaining.troops).toEqual([]);

    // If awayTroops were killable, 500 units would trivially clear the Command Center's small
    // upkeep and `resolved` would be `true`. It stays `false` — proof nothing was killed.
    expect(result.resolved).toBe(false);
    expect(result.netFoodPerHourAfter).toBeLessThan(0);
  });

  it('in-transit troops still raise the deficit — home troops are killed to pay for it — proving awayTroops stayed in the upkeep union', () => {
    const homeCount = 50;
    // Buildings alone comfortably cover home troops' own upkeep, with real headroom to spare.
    const level = farmLevelCovering(homeCount * uWeak + 5 * uWeak);
    const buildings: BuildingLevels = [{ type: 'greenhouseFarm', level }];
    const headroom = calcNetFoodPerHour(config, buildings, []);
    const troops: TroopCounts = [{ unitType: WEAK, count: homeCount }];

    // Baseline: with no awayTroops, the whole home garrison survives untouched.
    const baseline = resolveStarvation(config, {
      buildings,
      troops,
      awayTroops: [],
      stationed: [],
    });
    expect(baseline.resolved).toBe(true);
    expect(baseline.killed.troops).toEqual([]);

    // A large in-transit force's upkeep alone pushes the same settlement negative. Since
    // awayTroops itself can never be killed (previous test), the only way to pay for its
    // upkeep is by killing home troops.
    const awayCount = Math.ceil((headroom - homeCount * uWeak) / uWeak) + 20;
    const awayTroops: TroopCounts = [{ unitType: WEAK, count: awayCount }];
    const result = resolveStarvation(config, { buildings, troops, awayTroops, stationed: [] });

    expect(result.killed.troops.length).toBeGreaterThan(0);
    const homeSurvivors = result.remaining.troops.find((t) => t.unitType === WEAK)?.count ?? 0;
    expect(homeSurvivors).toBeLessThan(homeCount);
    expect(result.resolved).toBe(true);
    expect(result.netFoodPerHourAfter).toBeGreaterThanOrEqual(0);
  });

  it('breaks ties between two contingents of the same unit type by ascending key, replay-deterministically', () => {
    const buildings: BuildingLevels = [{ type: 'greenhouseFarm', level: 1 }];
    const headroom = calcNetFoodPerHour(config, buildings, []);
    const smallCount = 3;
    const bigCount = 100;
    // Sanity precondition for the scenario: headroom must not be enough to cover the big
    // contingent alone, so the deficit necessarily spills from 'a' (smaller key) into 'b'.
    expect(headroom).toBeLessThan(bigCount * uWeak);

    const forward: StarvationContingent[] = [
      { key: 'a', troops: [{ unitType: WEAK, count: smallCount }] },
      { key: 'b', troops: [{ unitType: WEAK, count: bigCount }] },
    ];
    const reversed: StarvationContingent[] = [...forward].reverse();

    const resultForward = resolveStarvation(config, {
      buildings,
      troops: [],
      awayTroops: [],
      stationed: forward,
    });
    const resultReversed = resolveStarvation(config, {
      buildings,
      troops: [],
      awayTroops: [],
      stationed: reversed,
    });

    // Replay-determinism: input array order must not affect the outcome.
    expect(resultForward).toEqual(resultReversed);

    // 'a' (smaller key) is drained first and fully; 'b' only loses the spillover.
    expect(resultForward.remaining.stationed.find((s) => s.key === 'a')?.troops).toEqual([]);
    const bSurvivors =
      resultForward.remaining.stationed
        .find((s) => s.key === 'b')
        ?.troops.find((t) => t.unitType === WEAK)?.count ?? 0;
    expect(bSurvivors).toBeGreaterThan(0);
    expect(bSurvivors).toBeLessThan(bigCount);
  });

  it('reports resolved: false with every killable troop list empty when even killing everything killable is not enough', () => {
    // Command Center has upkeep but no production (§4): its Food cost can never be closed by
    // killing troops, no matter how many die — buildings never starve. This single forward
    // pass over a fixed target list (troops + stationed) terminates either way — completing
    // synchronously here is itself evidence there is no spin, alongside the code's own
    // finite-target-list guarantee (see `resolveStarvation`'s doc comment).
    const buildings: BuildingLevels = [{ type: 'commandCenter', level: 1 }];
    const buildingUpkeep = calcFoodUpkeepPerHour(config, buildings);
    expect(buildingUpkeep).toBeGreaterThan(0);

    const troops: TroopCounts = [{ unitType: WEAK, count: 2 }];
    // awayTroops adds its own upkeep to the deficit but, being exempt from killing, is never
    // among what dies — its upkeep is baked permanently into the unresolved residual below.
    const awayTroops: TroopCounts = [{ unitType: WEAK, count: 2 }];
    const stationed: StarvationContingent[] = [
      { key: 'guest', troops: [{ unitType: WEAK, count: 2 }] },
    ];

    const result = resolveStarvation(config, { buildings, troops, awayTroops, stationed });

    expect(result.resolved).toBe(false);
    expect(result.remaining).toEqual({
      troops: [],
      stationed: [{ key: 'guest', troops: [] }],
    });
    expect(result.killed.troops).toEqual(troops);
    expect(result.killed.stationed).toEqual(stationed);
    // Everything killable is dead; what's left is the Command Center's upkeep PLUS the
    // never-killable awayTroops' upkeep.
    expect(result.netFoodPerHourAfter).toBeCloseTo(-(buildingUpkeep + 2 * uWeak), 10);
  });

  it('does not mutate its inputs', () => {
    const buildings: BuildingLevels = [{ type: 'commandCenter', level: 1 }];
    const troops: TroopCounts = [{ unitType: WEAK, count: 3 }];
    const awayTroops: TroopCounts = [{ unitType: WEAK, count: 3 }];
    const stationed: StarvationContingent[] = [
      { key: 'guest', troops: [{ unitType: WEAK, count: 3 }] },
    ];
    const buildingsCopy = structuredClone(buildings as unknown);
    const troopsCopy = structuredClone(troops as unknown);
    const awayTroopsCopy = structuredClone(awayTroops as unknown);
    const stationedCopy = structuredClone(stationed as unknown);

    resolveStarvation(config, { buildings, troops, awayTroops, stationed });

    expect(buildings).toEqual(buildingsCopy);
    expect(troops).toEqual(troopsCopy);
    expect(awayTroops).toEqual(awayTroopsCopy);
    expect(stationed).toEqual(stationedCopy);
  });
});
