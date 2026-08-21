import type { BuildingLevels } from '@last-signal/game-core';
import {
  DEFAULT_CONFIG,
  calcTrainCost,
  calcTrainTimeMs,
  canAfford,
  emptyResources,
  scoutUnitForFaction,
} from '@last-signal/game-core';
import { describe, expect, it } from 'vitest';

import { computeTrainEligibility, computeUnitTrainEligibility } from './trainEligibility';

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

// The general form behind the Units tab's roster (M3e.2): every one of `computeTrainEligibility`
// above's server-mirrored checks, but for an arbitrary `unitType` rather than always the
// caller's own scout. The Units tab itself never actually hits `wrongFaction` — its roster is
// pre-filtered to the caller's own faction plus the Settler (`unitsTrainableAt`) — so this is
// the one reason exercised only here, at the function level, rather than through a rendered
// component: correctness for an input this app doesn't happen to construct today still matters,
// since this function is the client's one source of truth for "does this agree with the
// server".
describe('computeUnitTrainEligibility', () => {
  it('blocks a unit from another faction with wrongFaction — even though no caller in this app ever asks for one', () => {
    // Skirmisher trains at the Barracks but belongs to the Nomads (§1); the caller is Raiders.
    const eligibility = computeUnitTrainEligibility(
      config,
      'skirmisher',
      [{ type: 'barracks', level: 1 }],
      [],
      [],
      { scrap: 1_000_000, fuel: 1_000_000, electronics: 1_000_000, food: 1_000_000 },
      'raiders',
      1,
    );

    expect(eligibility.block).toEqual({ kind: 'wrongFaction' });
    expect(eligibility.canStart).toBe(false);
  });

  it('blocks with buildingMissing when the training building is not built (level 0), previewing the level-1 time', () => {
    const expectedUnitTimeMs = calcTrainTimeMs(config, 'brute', 1);

    const eligibility = computeUnitTrainEligibility(
      config,
      'brute',
      [],
      [],
      [],
      emptyResources(),
      'raiders',
      1,
    );

    expect(eligibility.block).toEqual({ kind: 'buildingMissing', building: 'barracks' });
    expect(eligibility.unitTimeMs).toBe(expectedUnitTimeMs);
  });

  it('blocks with insufficientResources when the batch is unaffordable, matching canAfford exactly', () => {
    const unaffordable = emptyResources();
    expect(canAfford(unaffordable, calcTrainCost(config, 'brute', 1))).toBe(false);

    const eligibility = computeUnitTrainEligibility(
      config,
      'brute',
      // A Greenhouse Farm alongside the Barracks (mirrors `BaseScreen.test.tsx`'s own
      // `BARRACKS_BUILDINGS`): the Barracks alone nets 0 Food/h at zero troops, so a single
      // Brute's upkeep would trip `wouldStarve` first and mask the gate this test targets.
      [
        { type: 'barracks', level: 1 },
        { type: 'greenhouseFarm', level: 1 },
      ],
      [],
      [],
      unaffordable,
      'raiders',
      1,
    );

    expect(eligibility.block).toEqual({ kind: 'insufficientResources' });
  });

  it('renders two different training-building levels into two different, calcTrainTimeMs-derived times', () => {
    const timeAtL1 = calcTrainTimeMs(config, 'brute', 1);
    const timeAtL10 = calcTrainTimeMs(config, 'brute', 10);
    expect(timeAtL1).not.toBe(timeAtL10);

    const ample = { scrap: 1_000_000, fuel: 1_000_000, electronics: 1_000_000, food: 1_000_000 };
    const atL1 = computeUnitTrainEligibility(
      config,
      'brute',
      [
        { type: 'barracks', level: 1 },
        { type: 'greenhouseFarm', level: 1 },
      ],
      [],
      [],
      ample,
      'raiders',
      1,
    );
    const atL10 = computeUnitTrainEligibility(
      config,
      'brute',
      [
        { type: 'barracks', level: 10 },
        { type: 'greenhouseFarm', level: 1 },
      ],
      [],
      [],
      ample,
      'raiders',
      1,
    );

    expect(atL1.unitTimeMs).toBe(timeAtL1);
    expect(atL10.unitTimeMs).toBe(timeAtL10);
    expect(atL1.canStart).toBe(true);
    expect(atL10.canStart).toBe(true);
  });

  it('allows the faction-neutral Settler for any faction at the Command Center', () => {
    const ample = { scrap: 1_000_000, fuel: 1_000_000, electronics: 1_000_000, food: 1_000_000 };
    const eligibility = computeUnitTrainEligibility(
      config,
      'settler',
      [
        { type: 'commandCenter', level: 1 },
        { type: 'greenhouseFarm', level: 1 },
      ],
      [],
      [],
      ample,
      'nomads',
      1,
    );

    expect(eligibility.block).toBeUndefined();
    expect(eligibility.canStart).toBe(true);
  });
});
