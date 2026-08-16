import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config/index.js';
import type { GameConfig } from '../config/types.js';
import { calcInfluence, calcStorageCaps, meetsPrerequisites } from '../formulas/index.js';
import { RESOURCE_KINDS } from '../types.js';
import {
  REFERENCE_PROFILES,
  simulateReferencePlayer,
  type PlayerProfile,
} from './referencePlayer.js';

const config = DEFAULT_CONFIG;

describe('simulateReferencePlayer determinism', () => {
  it('produces deeply equal results for two runs with identical inputs', () => {
    const a = simulateReferencePlayer(config, REFERENCE_PROFILES.regular, 21);
    const b = simulateReferencePlayer(config, REFERENCE_PROFILES.regular, 21);
    expect(a).toEqual(b);
  });
});

describe('simulateReferencePlayer login-frequency monotonicity', () => {
  it('never leaves a denser login schedule worse off than a sparser subset of it, all else equal', () => {
    const sparse: PlayerProfile = {
      id: 'casual',
      loginHours: [8, 20],
      raidIncomeMultiplier: 1.1,
    };
    const dense: PlayerProfile = {
      id: 'casual',
      // A strict superset of sparse's login instants: every opportunity sparse has, plus more.
      loginHours: [0, 4, 8, 12, 16, 20],
      raidIncomeMultiplier: 1.1,
    };

    const sparseResult = simulateReferencePlayer(config, sparse, 21);
    const denseResult = simulateReferencePlayer(config, dense, 21);

    const sparseInfluence = calcInfluence(config, [sparseResult.final.buildings]);
    const denseInfluence = calcInfluence(config, [denseResult.final.buildings]);
    expect(denseInfluence).toBeGreaterThanOrEqual(sparseInfluence);
    expect(denseResult.final.topResourceLevel).toBeGreaterThanOrEqual(
      sparseResult.final.topResourceLevel,
    );
  });
});

describe('simulateReferencePlayer queue invariant', () => {
  it('never exceeds 3 queued items (1 active + 2 waiting) under maximum login pressure', () => {
    // The queue push site asserts this invariant internally; running the densest profile
    // (hardcore) for the full round exercises that code path continuously without throwing.
    expect(() => simulateReferencePlayer(config, REFERENCE_PROFILES.hardcore, 21)).not.toThrow();
  });
});

describe('simulateReferencePlayer resource and cap safety', () => {
  it('keeps every resource non-negative and within its storage cap at every snapshot, for every profile', () => {
    for (const profile of Object.values(REFERENCE_PROFILES)) {
      const result = simulateReferencePlayer(config, profile, 21);
      for (const snapshot of result.days) {
        const caps = calcStorageCaps(config, snapshot.buildings);
        for (const kind of RESOURCE_KINDS) {
          expect(snapshot.resources[kind]).toBeGreaterThanOrEqual(0);
          expect(snapshot.resources[kind]).toBeLessThanOrEqual(caps[kind] + 1e-9);
        }
      }
    }
  });
});

describe('simulateReferencePlayer net-Food gate', () => {
  it('never shows negative net Food in any snapshot, for any profile', () => {
    for (const profile of Object.values(REFERENCE_PROFILES)) {
      const result = simulateReferencePlayer(config, profile, 21);
      for (const snapshot of result.days) {
        expect(snapshot.netFoodPerHour).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('simulateReferencePlayer prerequisite safety', () => {
  it('never contains a building whose prerequisites are unmet at its level, for any profile', () => {
    for (const profile of Object.values(REFERENCE_PROFILES)) {
      const result = simulateReferencePlayer(config, profile, 21);
      for (const snapshot of result.days) {
        for (const building of snapshot.buildings) {
          expect(meetsPrerequisites(config, snapshot.buildings, building.type)).toBe(true);
        }
      }
    }
  });
});

describe('simulateReferencePlayer raid income ramp', () => {
  it('is identical to a forced no-raid run through day 3 (the 72h beginner-protection window)', () => {
    const withRaid = simulateReferencePlayer(config, REFERENCE_PROFILES.hardcore, 21);
    const noRaid = simulateReferencePlayer(
      config,
      { ...REFERENCE_PROFILES.hardcore, raidIncomeMultiplier: 1 },
      21,
    );
    expect(withRaid.days.slice(0, 3)).toEqual(noRaid.days.slice(0, 3));
  });

  it('leaves a forced no-raid run strictly worse off than the profile default by round end', () => {
    const withRaid = simulateReferencePlayer(config, REFERENCE_PROFILES.hardcore, 21);
    const noRaid = simulateReferencePlayer(
      config,
      { ...REFERENCE_PROFILES.hardcore, raidIncomeMultiplier: 1 },
      21,
    );
    const withRaidInfluence = calcInfluence(config, [withRaid.final.buildings]);
    const noRaidInfluence = calcInfluence(config, [noRaid.final.buildings]);
    expect(noRaidInfluence).toBeLessThan(withRaidInfluence);
  });
});

describe('simulateReferencePlayer overflow accounting', () => {
  it('is zero when storage always outpaces production (short, early-game horizon)', () => {
    const result = simulateReferencePlayer(config, REFERENCE_PROFILES.regular, 1);
    for (const kind of RESOURCE_KINDS) {
      expect(result.final.wastedToOverflow[kind]).toBe(0);
    }
  });

  it('is positive when Warehouse and Cold Storage are deliberately capped out at level 0', () => {
    const starvedConfig: GameConfig = {
      ...config,
      buildings: {
        ...config.buildings,
        warehouse: { ...config.buildings.warehouse, maxLevel: 0 },
        coldStorage: { ...config.buildings.coldStorage, maxLevel: 0 },
      },
    };
    const result = simulateReferencePlayer(starvedConfig, REFERENCE_PROFILES.hardcore, 21);
    const totalWasted = RESOURCE_KINDS.reduce(
      (sum, kind) => sum + result.final.wastedToOverflow[kind],
      0,
    );
    expect(totalWasted).toBeGreaterThan(0);
  });
});
