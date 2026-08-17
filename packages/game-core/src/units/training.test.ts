import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config/index.js';
import { FACTIONS, UNIT_TYPES, type GameConfig } from '../config/types.js';
import { ceilSecondsToMs } from '../numeric.js';
import {
  calcTrainBatchTimeMs,
  calcTrainCost,
  calcTrainTimeMs,
  canFactionTrain,
  scoutUnitForFaction,
  unitsForFaction,
  unitsTrainableAt,
} from './training.js';

const config = DEFAULT_CONFIG;

function withSpeed(base: GameConfig, patch: Partial<GameConfig['speed']>): GameConfig {
  return { ...base, speed: { ...base.speed, ...patch } };
}

describe('unitsForFaction / scoutUnitForFaction', () => {
  it('gives every faction exactly one scout', () => {
    for (const faction of FACTIONS) {
      const units = unitsForFaction(config, faction);
      expect(units.filter((u) => u.role === 'scout')).toHaveLength(1);
    }
  });

  it('returns the right scout per faction', () => {
    expect(scoutUnitForFaction(config, 'raiders').type).toBe('lookout');
    expect(scoutUnitForFaction(config, 'engineers').type).toBe('surveyorDrone');
    expect(scoutUnitForFaction(config, 'nomads').type).toBe('falconer');
  });

  it('unitsForFaction only returns units belonging to that faction', () => {
    for (const faction of FACTIONS) {
      for (const unit of unitsForFaction(config, faction)) {
        expect(unit.faction).toBe(faction);
      }
    }
  });
});

describe('calcTrainCost', () => {
  it('equals the per-unit cost for count 1', () => {
    expect(calcTrainCost(config, 'lookout', 1)).toEqual(config.units.lookout.cost);
  });

  it('scales linearly with count, rounded per the numeric conventions', () => {
    const def = config.units.falconer;
    for (const count of [2, 3, 7]) {
      const cost = calcTrainCost(config, 'falconer', count);
      expect(cost.scrap).toBe(Math.round(def.cost.scrap * count));
      expect(cost.fuel).toBe(Math.round(def.cost.fuel * count));
      expect(cost.electronics).toBe(Math.round(def.cost.electronics * count));
      expect(cost.food).toBe(Math.round(def.cost.food * count));
    }
  });

  it('is all zero for count 0', () => {
    expect(calcTrainCost(config, 'surveyorDrone', 0)).toEqual({
      scrap: 0,
      fuel: 0,
      electronics: 0,
      food: 0,
    });
  });

  it('throws RangeError for a negative count', () => {
    expect(() => calcTrainCost(config, 'lookout', -1)).toThrow(RangeError);
  });
});

describe('calcTrainTimeMs', () => {
  it('is baseTrainTimeSec / speed.training for one unit under DEFAULT_CONFIG (lookout: 1200s / 5 = 240s) at level 1', () => {
    expect(calcTrainTimeMs(config, 'lookout', 1)).toBe(240_000);
  });

  it('level 1 is exactly the old (pre-M3a.2) behaviour for every trainable unit — 0.91 ** 0 === 1, so a level-1 building must not change a single shipped number', () => {
    for (const unitType of UNIT_TYPES) {
      const def = config.units[unitType];
      if (!def.trainedIn) {
        continue;
      }
      expect(calcTrainTimeMs(config, unitType, 1)).toBe(
        ceilSecondsToMs(def.baseTrainTimeSec / config.speed.training),
      );
    }
  });

  it('respects speed.training: halves when the multiplier doubles', () => {
    const atSpeed5 = calcTrainTimeMs(withSpeed(config, { training: 5 }), 'falconer', 1);
    const atSpeed10 = calcTrainTimeMs(withSpeed(config, { training: 10 }), 'falconer', 1);
    expect(atSpeed10).toBe(atSpeed5 / 2);
  });

  it('ceils to whole seconds when the division is not exact', () => {
    // 1200s / 7 = 171.428...s, must ceil to 172s, not truncate.
    const ms = calcTrainTimeMs(withSpeed(config, { training: 7 }), 'lookout', 1);
    expect(ms % 1000).toBe(0);
    expect(ms).toBe(172_000);
  });

  it('is strictly decreasing across levels 1..20 for a unit', () => {
    let previous = Infinity;
    for (let level = 1; level <= 20; level += 1) {
      const ms = calcTrainTimeMs(config, 'lookout', level);
      expect(ms).toBeLessThan(previous);
      previous = ms;
    }
  });

  it('a level-20 training building trains ~6.0x faster than level 1 (the design record headline number)', () => {
    // Settler has by far the largest baseTrainTimeSec (4000s) in the catalogue, so the
    // ceil-to-whole-second rounding distorts the ratio the least here; the ceiling still
    // rules out an exact equality (it rounds level 20's time up from ~133.3s to 134s), so
    // this checks the ratio is close to, not exactly, the config-derived multiplier.
    const t1 = calcTrainTimeMs(config, 'settler', 1);
    const t20 = calcTrainTimeMs(config, 'settler', 20);
    const expectedRatio = 1 / config.training.buildingTimeRatio ** 19;
    expect(t1 / t20).toBeCloseTo(expectedRatio, 1);
  });

  it('throws RangeError for level 0 and for a negative level', () => {
    expect(() => calcTrainTimeMs(config, 'lookout', 0)).toThrow(RangeError);
    expect(() => calcTrainTimeMs(config, 'lookout', -1)).toThrow(RangeError);
  });
});

describe('calcTrainBatchTimeMs', () => {
  it('is exactly count * calcTrainTimeMs at the same level, not a batch discount', () => {
    const unitTime = calcTrainTimeMs(config, 'surveyorDrone', 5);
    expect(calcTrainBatchTimeMs(config, 'surveyorDrone', 5, 5)).toBe(unitTime * 5);
  });

  it('is 0 for count 0', () => {
    expect(calcTrainBatchTimeMs(config, 'lookout', 0, 1)).toBe(0);
  });

  it('throws RangeError for a negative count', () => {
    expect(() => calcTrainBatchTimeMs(config, 'lookout', -2, 1)).toThrow(RangeError);
  });

  it('throws RangeError for level 0 and for a negative level', () => {
    expect(() => calcTrainBatchTimeMs(config, 'lookout', 3, 0)).toThrow(RangeError);
    expect(() => calcTrainBatchTimeMs(config, 'lookout', 3, -1)).toThrow(RangeError);
  });
});

describe('unitsTrainableAt', () => {
  it('returns exactly 3 units at the Barracks per faction — offence infantry, defence infantry, scout', () => {
    for (const faction of FACTIONS) {
      const units = unitsTrainableAt(config, 'barracks', faction);
      expect(units).toHaveLength(3);
      expect(units.map((u) => u.role).sort()).toEqual(
        ['defenseInfantry', 'offenseInfantry', 'scout'].sort(),
      );
    }
  });

  it('returns exactly 2 units at the Machine Shop per faction — fast, siege', () => {
    for (const faction of FACTIONS) {
      const units = unitsTrainableAt(config, 'machineShop', faction);
      expect(units).toHaveLength(2);
      expect(units.map((u) => u.role).sort()).toEqual(['fast', 'siege'].sort());
    }
  });

  it('returns exactly 1 unit at the Command Center per faction — the faction-neutral Settler, the same unit for all three factions', () => {
    const perFaction = FACTIONS.map((faction) =>
      unitsTrainableAt(config, 'commandCenter', faction),
    );
    for (const units of perFaction) {
      expect(units).toHaveLength(1);
      expect(units[0]?.type).toBe('settler');
    }
  });

  it('never returns a wildlife type, for any building or faction', () => {
    const buildings = ['barracks', 'machineShop', 'commandCenter'] as const;
    for (const building of buildings) {
      for (const faction of FACTIONS) {
        const types = unitsTrainableAt(config, building, faction).map((u) => u.type);
        expect(types).not.toContain('feralDog');
        expect(types).not.toContain('scavengerGang');
      }
    }
  });
});

describe('canFactionTrain', () => {
  it('is true for a faction training its own units', () => {
    for (const faction of FACTIONS) {
      for (const unit of unitsForFaction(config, faction)) {
        expect(canFactionTrain(config, unit.type, faction)).toBe(true);
      }
    }
  });

  it('is true for the Settler from every faction (faction-neutral)', () => {
    for (const faction of FACTIONS) {
      expect(canFactionTrain(config, 'settler', faction)).toBe(true);
    }
  });

  it("is false for another faction's units", () => {
    expect(canFactionTrain(config, 'lookout', 'engineers')).toBe(false);
    expect(canFactionTrain(config, 'surveyorDrone', 'nomads')).toBe(false);
    expect(canFactionTrain(config, 'falconer', 'raiders')).toBe(false);
  });

  it('is false for both wildlife types, from every faction', () => {
    for (const faction of FACTIONS) {
      expect(canFactionTrain(config, 'feralDog', faction)).toBe(false);
      expect(canFactionTrain(config, 'scavengerGang', faction)).toBe(false);
    }
  });
});
