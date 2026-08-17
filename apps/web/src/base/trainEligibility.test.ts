import type { BuildingLevels } from '@last-signal/game-core';
import {
  DEFAULT_CONFIG,
  calcTrainTimeMs,
  emptyResources,
  scoutUnitForFaction,
} from '@last-signal/game-core';
import { describe, expect, it } from 'vitest';

import { computeTrainEligibility } from './trainEligibility';

const config = DEFAULT_CONFIG;

describe('computeTrainEligibility', () => {
  it('previews the level-1 training time when there is no Barracks yet, not zero — a fresh Barracks is level 1, so this is a real preview, not a placeholder', () => {
    const noBuildings: BuildingLevels = [];
    const unitType = scoutUnitForFaction(config, 'raiders').type;
    const expectedUnitTimeMs = calcTrainTimeMs(config, unitType, 1);

    const eligibility = computeTrainEligibility(
      config,
      noBuildings,
      [],
      [],
      emptyResources(),
      'raiders',
      1,
    );

    expect(eligibility.block).toEqual({ kind: 'buildingMissing', building: 'barracks' });
    expect(eligibility.canStart).toBe(false);
    expect(eligibility.unitTimeMs).toBe(expectedUnitTimeMs);
    expect(eligibility.batchTimeMs).toBe(expectedUnitTimeMs);
  });
});
