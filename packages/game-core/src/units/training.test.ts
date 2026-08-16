import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config/index.js';
import { FACTIONS, type GameConfig } from '../config/types.js';
import {
  calcTrainBatchTimeMs,
  calcTrainCost,
  calcTrainTimeMs,
  scoutUnitForFaction,
  unitsForFaction,
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
  it('is baseTrainTimeSec / speed.training for one unit under DEFAULT_CONFIG (lookout: 1200s / 5 = 240s)', () => {
    expect(calcTrainTimeMs(config, 'lookout')).toBe(240_000);
  });

  it('respects speed.training: halves when the multiplier doubles', () => {
    const atSpeed5 = calcTrainTimeMs(withSpeed(config, { training: 5 }), 'falconer');
    const atSpeed10 = calcTrainTimeMs(withSpeed(config, { training: 10 }), 'falconer');
    expect(atSpeed10).toBe(atSpeed5 / 2);
  });

  it('ceils to whole seconds when the division is not exact', () => {
    // 1200s / 7 = 171.428...s, must ceil to 172s, not truncate.
    const ms = calcTrainTimeMs(withSpeed(config, { training: 7 }), 'lookout');
    expect(ms % 1000).toBe(0);
    expect(ms).toBe(172_000);
  });
});

describe('calcTrainBatchTimeMs', () => {
  it('is exactly count * calcTrainTimeMs, not a batch discount', () => {
    const unitTime = calcTrainTimeMs(config, 'surveyorDrone');
    expect(calcTrainBatchTimeMs(config, 'surveyorDrone', 5)).toBe(unitTime * 5);
  });

  it('is 0 for count 0', () => {
    expect(calcTrainBatchTimeMs(config, 'lookout', 0)).toBe(0);
  });

  it('throws RangeError for a negative count', () => {
    expect(() => calcTrainBatchTimeMs(config, 'lookout', -2)).toThrow(RangeError);
  });
});
