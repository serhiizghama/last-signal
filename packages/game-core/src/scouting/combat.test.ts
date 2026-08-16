import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config/index.js';
import type { GameConfig } from '../config/types.js';
import type { TroopCounts } from '../units/index.js';
import { resolveScoutCombat } from './combat.js';

const config = DEFAULT_CONFIG;

function withLossExponent(base: GameConfig, lossExponent: number): GameConfig {
  return { ...base, scouting: { ...base.scouting, lossExponent } };
}

describe('resolveScoutCombat', () => {
  // Hand-computed golden case (single scout type — this is the example from the step brief):
  // 5 Falconers (scoutAttack 45) attack 2 Falconers at home (scoutDefense 40).
  // atkPts = 5*45 = 225, defPts = 2*40 = 80, ratio = 80/225 = 0.35555555...
  // lossFraction = min(1, 0.35555555...^1.5) = 0.21201237119998... (default exponent 1.5)
  // loss = round(0.21201237... * 5) = round(1.06006185...) = 1 -> 4 survivors.
  it('matches the hand-computed 5 Falconers vs 2 Falconers case', () => {
    const attackers: TroopCounts = [{ unitType: 'falconer', count: 5 }];
    const defenders: TroopCounts = [{ unitType: 'falconer', count: 2 }];
    const result = resolveScoutCombat(config, attackers, defenders);
    expect(result.atkPts).toBe(225);
    expect(result.defPts).toBe(80);
    expect(result.lossFraction).toBeCloseTo(0.21201237119998007, 12);
    expect(result.losses).toEqual([{ unitType: 'falconer', count: 1 }]);
    expect(result.survivors).toEqual([{ unitType: 'falconer', count: 4 }]);
    expect(result.anySurvived).toBe(true);
  });

  // Second hand-computed case, a different unit type on each side:
  // 4 Lookouts (scoutAttack 35) attack 3 Falconers at home (scoutDefense 40).
  // atkPts = 4*35 = 140, defPts = 3*40 = 120, ratio = 120/140 = 0.85714285...
  // lossFraction = min(1, 0.85714285...^1.5) = 0.79356008551...
  // loss = round(0.79356008... * 4) = round(3.17424034...) = 3 -> 1 survivor.
  it('matches the hand-computed 4 Lookouts vs 3 Falconers case', () => {
    const attackers: TroopCounts = [{ unitType: 'lookout', count: 4 }];
    const defenders: TroopCounts = [{ unitType: 'falconer', count: 3 }];
    const result = resolveScoutCombat(config, attackers, defenders);
    expect(result.atkPts).toBe(140);
    expect(result.defPts).toBe(120);
    expect(result.lossFraction).toBeCloseTo(0.7935600855193298, 12);
    expect(result.losses).toEqual([{ unitType: 'lookout', count: 3 }]);
    expect(result.survivors).toEqual([{ unitType: 'lookout', count: 1 }]);
    expect(result.anySurvived).toBe(true);
  });

  it('defPts = 0 means no losses, regardless of atkPts', () => {
    const attackers: TroopCounts = [{ unitType: 'falconer', count: 3 }];
    const result = resolveScoutCombat(config, attackers, []);
    expect(result.defPts).toBe(0);
    expect(result.lossFraction).toBe(0);
    expect(result.losses).toEqual([{ unitType: 'falconer', count: 0 }]);
    expect(result.survivors).toEqual([{ unitType: 'falconer', count: 3 }]);
    expect(result.anySurvived).toBe(true);
  });

  // defPts >> atkPts: 1 Lookout (atk 35) attacks 10 Falconers at home (def 400).
  // ratio = 400/35 = 11.43 > 1, so the min(1, ...) cap kicks in -> lossFraction 1 -> total wipe.
  it('caps lossFraction at 1 and wipes the attacker when defPts greatly exceeds atkPts', () => {
    const attackers: TroopCounts = [{ unitType: 'lookout', count: 1 }];
    const defenders: TroopCounts = [{ unitType: 'falconer', count: 10 }];
    const result = resolveScoutCombat(config, attackers, defenders);
    expect(result.lossFraction).toBe(1);
    expect(result.losses).toEqual([{ unitType: 'lookout', count: 1 }]);
    expect(result.survivors).toEqual([{ unitType: 'lookout', count: 0 }]);
    expect(result.anySurvived).toBe(false);
  });

  it('reads the loss exponent from config: a lower exponent moves the result', () => {
    // Same counts as the first golden case, exponent 1 instead of the default 1.5:
    // ratio = 80/225 = 0.35555555... ; loss = round(0.35555555... * 5) = round(1.77777...) = 2
    // (vs 1 at the default 1.5 exponent above) -> 3 survivors instead of 4.
    const attackers: TroopCounts = [{ unitType: 'falconer', count: 5 }];
    const defenders: TroopCounts = [{ unitType: 'falconer', count: 2 }];
    const linearConfig = withLossExponent(config, 1);
    const result = resolveScoutCombat(linearConfig, attackers, defenders);
    expect(result.lossFraction).toBeCloseTo(0.35555555555555557, 12);
    expect(result.losses).toEqual([{ unitType: 'falconer', count: 2 }]);
    expect(result.survivors).toEqual([{ unitType: 'falconer', count: 3 }]);
  });

  // Synthetic boundary case: a cloned config with custom unit stats and exponent 1, chosen so
  // lossFraction * count lands exactly on a rounding boundary (2.5), to pin down the documented
  // rounding rule (Math.round — ties round up/away from zero for the non-negative inputs here).
  it('rounds a .5 boundary the documented way (Math.round, ties round up)', () => {
    const boundaryConfig: GameConfig = {
      ...config,
      scouting: { ...config.scouting, lossExponent: 1 },
      units: {
        ...config.units,
        lookout: { ...config.units.lookout, scoutAttack: 10 },
        falconer: { ...config.units.falconer, scoutDefense: 25 },
      },
    };
    // atkPts = 5*10 = 50, defPts = 1*25 = 25, ratio = 0.5, lossFraction = 0.5 (exponent 1).
    // loss = round(0.5 * 5) = round(2.5) = 3 (Math.round rounds .5 up) -> 2 survivors.
    const attackers: TroopCounts = [{ unitType: 'lookout', count: 5 }];
    const defenders: TroopCounts = [{ unitType: 'falconer', count: 1 }];
    const result = resolveScoutCombat(boundaryConfig, attackers, defenders);
    expect(result.lossFraction).toBe(0.5);
    expect(Math.round(2.5)).toBe(3); // documents the JS tie-breaking rule this test relies on
    expect(result.losses).toEqual([{ unitType: 'lookout', count: 3 }]);
    expect(result.survivors).toEqual([{ unitType: 'lookout', count: 2 }]);
  });

  it('atkPts = 0 (an empty attacking force) resolves without dividing by zero', () => {
    const result = resolveScoutCombat(config, [], [{ unitType: 'falconer', count: 2 }]);
    expect(result.atkPts).toBe(0);
    expect(result.defPts).toBe(80);
    expect(result.lossFraction).toBe(0);
    expect(result.losses).toEqual([]);
    expect(result.survivors).toEqual([]);
    expect(result.anySurvived).toBe(false);
  });

  it('atkPts = 0 via an explicit zero-count attacker entry keeps that entry unchanged', () => {
    const attackers: TroopCounts = [{ unitType: 'lookout', count: 0 }];
    const result = resolveScoutCombat(config, attackers, []);
    expect(result.atkPts).toBe(0);
    expect(result.losses).toEqual([{ unitType: 'lookout', count: 0 }]);
    expect(result.survivors).toEqual([{ unitType: 'lookout', count: 0 }]);
    expect(result.anySurvived).toBe(false);
  });

  it('a mixed-unit-type attacking army distributes losses per type without breaking', () => {
    // 2 Lookouts (atk 35) + 3 Falconers (atk 45) attack 3 Falconers at home (def 40).
    // atkPts = 2*35 + 3*45 = 205, defPts = 3*40 = 120, ratio = 120/205 = 0.58536585...
    // lossFraction = 0.58536585...^1.5 = 0.44785876...
    // lookout loss = round(0.44785876... * 2) = round(0.89571752...) = 1 -> 1 survivor
    // falconer loss = round(0.44785876... * 3) = round(1.34357629...) = 1 -> 2 survivors
    const attackers: TroopCounts = [
      { unitType: 'lookout', count: 2 },
      { unitType: 'falconer', count: 3 },
    ];
    const defenders: TroopCounts = [{ unitType: 'falconer', count: 3 }];
    const result = resolveScoutCombat(config, attackers, defenders);
    expect(result.atkPts).toBe(205);
    expect(result.defPts).toBe(120);
    expect(result.losses).toEqual([
      { unitType: 'lookout', count: 1 },
      { unitType: 'falconer', count: 1 },
    ]);
    expect(result.survivors).toEqual([
      { unitType: 'lookout', count: 1 },
      { unitType: 'falconer', count: 2 },
    ]);
    // Invariants that must hold for any mixed-type army, independent of the exact numbers above:
    // no unit type's loss count is negative or exceeds its own attacking count, and survivors
    // is exactly the complement — checked via a unitType lookup rather than parallel indexing.
    const attackerCountByType = new Map(attackers.map((a) => [a.unitType, a.count]));
    for (const loss of result.losses) {
      const attacking = attackerCountByType.get(loss.unitType) ?? 0;
      expect(loss.count).toBeGreaterThanOrEqual(0);
      expect(loss.count).toBeLessThanOrEqual(attacking);
    }
    for (const survivor of result.survivors) {
      const attacking = attackerCountByType.get(survivor.unitType) ?? 0;
      const lost = result.losses.find((l) => l.unitType === survivor.unitType)?.count ?? 0;
      expect(survivor.count).toBe(attacking - lost);
    }
    expect(result.anySurvived).toBe(true);
  });
});
