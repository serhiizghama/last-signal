import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config/index.js';
import type { BuildingLevels } from '../config/types.js';
import type { Resources } from '../types.js';
import { resolveScouting, type ScoutingInput } from './resolve.js';

const config = DEFAULT_CONFIG;

const defenderResources: Resources = { scrap: 100, fuel: 50, electronics: 20, food: 200 };
const defenderStorageCaps: Resources = { scrap: 4000, fuel: 4000, electronics: 4000, food: 4000 };
const defenderBuildings: BuildingLevels = [
  { type: 'commandCenter', level: 2 },
  { type: 'scrapYard', level: 3 },
];

function baseInput(overrides: Partial<ScoutingInput> = {}): ScoutingInput {
  return {
    // Same counts as the golden combat case: 5 Falconers vs 2 Falconers -> 1 loss, 4 survivors.
    attackers: [{ unitType: 'falconer', count: 5 }],
    defenderHomeTroops: [{ unitType: 'falconer', count: 2 }],
    attackerRadioTowerLevel: 0,
    defenderRadioTowerLevel: 0,
    defenderResources,
    defenderStorageCaps,
    defenderBuildings,
    ...overrides,
  };
}

describe('resolveScouting', () => {
  it('happy path: survivors, base-tier intel, detected (tower diff below threshold)', () => {
    const result = resolveScouting(config, baseInput());
    expect(result.combat.anySurvived).toBe(true);
    expect(result.combat.survivors).toEqual([{ unitType: 'falconer', count: 4 }]);
    expect(result.intel).toEqual({
      tier: 'base',
      resources: defenderResources,
      storageCaps: defenderStorageCaps,
      troops: [{ unitType: 'falconer', count: 2 }],
    });
    expect(result.detected).toBe(true);
  });

  it('buildings-tier intel once the Radio Tower differential clears the threshold', () => {
    const result = resolveScouting(
      config,
      baseInput({ attackerRadioTowerLevel: 3, defenderRadioTowerLevel: 2 }), // diff 1 == default threshold
    );
    expect(result.intel).toEqual({
      tier: 'buildings',
      resources: defenderResources,
      storageCaps: defenderStorageCaps,
      troops: [{ unitType: 'falconer', count: 2 }],
      buildings: defenderBuildings,
    });
  });

  it('failed mission: no survivors -> no intel, but the defender still detects it', () => {
    // 1 Lookout attacks 10 Falconers at home -> total wipe (same as the combat wipe case).
    const result = resolveScouting(
      config,
      baseInput({
        attackers: [{ unitType: 'lookout', count: 1 }],
        defenderHomeTroops: [{ unitType: 'falconer', count: 10 }],
      }),
    );
    expect(result.combat.anySurvived).toBe(false);
    expect(result.intel).toEqual({ tier: 'none' });
    // Detection depends only on the defender's home troops, not on the attack's outcome.
    expect(result.detected).toBe(true);
  });

  it('undetected: defender has no scouts at home, but intel is still granted', () => {
    const result = resolveScouting(config, baseInput({ defenderHomeTroops: [] }));
    expect(result.detected).toBe(false);
    // defPts = 0 -> no losses, full survivors.
    expect(result.combat.lossFraction).toBe(0);
    expect(result.combat.survivors).toEqual([{ unitType: 'falconer', count: 5 }]);
    expect(result.intel.tier).toBe('base');
  });
});
