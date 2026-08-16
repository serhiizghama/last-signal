import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config/index.js';
import {
  calcTroopFoodUpkeepPerHour,
  calcTroopScoutAttack,
  calcTroopScoutDefense,
  slowestTroopSpeed,
  type TroopCounts,
} from './troops.js';

const config = DEFAULT_CONFIG;

describe('calcTroopFoodUpkeepPerHour', () => {
  it('is 0 for an empty troop list', () => {
    expect(calcTroopFoodUpkeepPerHour(config, [])).toBe(0);
  });

  it('sums foodUpkeepPerHour * count across a mixed troop list', () => {
    const troops: TroopCounts = [
      { unitType: 'lookout', count: 4 },
      { unitType: 'falconer', count: 2 },
      { unitType: 'surveyorDrone', count: 1 },
    ];
    const expected = troops.reduce(
      (sum, { unitType, count }) => sum + config.units[unitType].foodUpkeepPerHour * count,
      0,
    );
    expect(calcTroopFoodUpkeepPerHour(config, troops)).toBe(expected);
  });

  it('scales linearly with count for a single unit type', () => {
    const one = calcTroopFoodUpkeepPerHour(config, [{ unitType: 'lookout', count: 1 }]);
    const ten = calcTroopFoodUpkeepPerHour(config, [{ unitType: 'lookout', count: 10 }]);
    expect(ten).toBe(one * 10);
  });
});

describe('slowestTroopSpeed', () => {
  it('picks the slowest unit in a mixed troop list', () => {
    const troops: TroopCounts = [
      { unitType: 'falconer', count: 1 }, // fastest
      { unitType: 'lookout', count: 5 }, // slowest
      { unitType: 'surveyorDrone', count: 2 },
    ];
    expect(slowestTroopSpeed(config, troops)).toBe(config.units.lookout.speed);
  });

  it('returns the single unit type speed regardless of count', () => {
    expect(slowestTroopSpeed(config, [{ unitType: 'falconer', count: 99 }])).toBe(
      config.units.falconer.speed,
    );
  });

  it('throws on an empty troop list (delegates to slowestSpeed)', () => {
    expect(() => slowestTroopSpeed(config, [])).toThrow(RangeError);
  });
});

describe('calcTroopScoutAttack / calcTroopScoutDefense', () => {
  it('sum scoutAttack and scoutDefense across a mixed troop list', () => {
    const troops: TroopCounts = [
      { unitType: 'lookout', count: 2 },
      { unitType: 'falconer', count: 3 },
    ];
    const expectedAttack =
      config.units.lookout.scoutAttack * 2 + config.units.falconer.scoutAttack * 3;
    const expectedDefense =
      config.units.lookout.scoutDefense * 2 + config.units.falconer.scoutDefense * 3;
    expect(calcTroopScoutAttack(config, troops)).toBe(expectedAttack);
    expect(calcTroopScoutDefense(config, troops)).toBe(expectedDefense);
  });

  it('are both 0 for an empty troop list', () => {
    expect(calcTroopScoutAttack(config, [])).toBe(0);
    expect(calcTroopScoutDefense(config, [])).toBe(0);
  });
});
