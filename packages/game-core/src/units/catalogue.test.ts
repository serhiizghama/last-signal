import { describe, expect, it } from 'vitest';
import { FACTIONS, UNIT_TYPES } from '../config/types.js';
import { UNITS } from './catalogue.js';

// The catalogue table IS the contract (M2 §7, docs/M2_DESIGN_DECISIONS.md §7) — these values
// are deliberately hardcoded rather than derived, per the project lesson that a contract test
// must be able to catch a regression in the numbers themselves.
const EXPECTED = {
  lookout: {
    faction: 'raiders',
    role: 'scout',
    cost: { scrap: 120, fuel: 40, electronics: 20, food: 30 },
    baseTrainTimeSec: 1200,
    speed: 9,
    scoutAttack: 35,
    scoutDefense: 20,
    foodUpkeepPerHour: 1,
  },
  surveyorDrone: {
    faction: 'engineers',
    role: 'scout',
    cost: { scrap: 100, fuel: 80, electronics: 60, food: 20 },
    baseTrainTimeSec: 1600,
    speed: 16,
    scoutAttack: 35,
    scoutDefense: 35,
    foodUpkeepPerHour: 1,
  },
  falconer: {
    faction: 'nomads',
    role: 'scout',
    cost: { scrap: 110, fuel: 50, electronics: 30, food: 30 },
    baseTrainTimeSec: 1300,
    speed: 17,
    scoutAttack: 45,
    scoutDefense: 40,
    foodUpkeepPerHour: 1,
  },
} as const;

describe('UNITS catalogue', () => {
  it('has exactly 3 entries, one per UNIT_TYPES', () => {
    expect(Object.keys(UNITS)).toHaveLength(3);
    expect(UNIT_TYPES).toHaveLength(3);
    expect(new Set(Object.keys(UNITS))).toEqual(new Set(UNIT_TYPES));
  });

  it('has a `type` field matching its own key for every entry', () => {
    for (const type of UNIT_TYPES) {
      expect(UNITS[type].type).toBe(type);
    }
  });

  it.each(UNIT_TYPES)('matches the draft table exactly for %s', (type) => {
    expect(UNITS[type]).toEqual({ type, ...EXPECTED[type] });
  });

  it('assigns each unit to a distinct faction, covering all three', () => {
    const factionsUsed = UNIT_TYPES.map((type) => UNITS[type].faction);
    expect(new Set(factionsUsed)).toEqual(new Set(FACTIONS));
    expect(factionsUsed).toHaveLength(new Set(factionsUsed).size);
  });

  it('gives Nomads the highest scout stats and Raiders the lowest speed (§7 rationale)', () => {
    // Nomads (falconer) have the best scouts; Raiders (lookout) the cheapest and slowest.
    expect(UNITS.falconer.scoutAttack).toBeGreaterThan(UNITS.lookout.scoutAttack);
    expect(UNITS.falconer.scoutDefense).toBeGreaterThan(UNITS.lookout.scoutDefense);
    expect(UNITS.lookout.speed).toBeLessThan(UNITS.surveyorDrone.speed);
    expect(UNITS.lookout.speed).toBeLessThan(UNITS.falconer.speed);
  });
});
