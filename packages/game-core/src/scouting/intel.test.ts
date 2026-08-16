import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config/index.js';
import type { GameConfig, UnitDef } from '../config/types.js';
import type { TroopCounts } from '../units/index.js';
import { isScoutDetected, resolveIntelTier, tierIncludesBuildings } from './intel.js';

const config = DEFAULT_CONFIG;

describe('resolveIntelTier', () => {
  it('returns "base" when diff is below the configured threshold, including a zero diff', () => {
    expect(resolveIntelTier(config, 3, 3)).toBe('base'); // diff 0
  });

  it('returns "base" for a negative diff (defender ahead on Radio Tower)', () => {
    expect(resolveIntelTier(config, 3, 5)).toBe('base'); // diff -2
  });

  it('returns "buildings" at and above the configured threshold (default 1)', () => {
    expect(resolveIntelTier(config, 4, 3)).toBe('buildings'); // diff 1 == threshold
    expect(resolveIntelTier(config, 6, 2)).toBe('buildings'); // diff 4 > threshold
  });

  it('reads the threshold from config: a raised threshold moves the result', () => {
    const raisedThreshold = {
      ...config,
      scouting: { ...config.scouting, buildingsTierMinDiff: 2 },
    };
    expect(resolveIntelTier(raisedThreshold, 4, 3)).toBe('base'); // diff 1, now below threshold 2
    expect(resolveIntelTier(raisedThreshold, 5, 3)).toBe('buildings'); // diff 2 == raised threshold
  });
});

describe('tierIncludesBuildings', () => {
  it('is true only for the buildings tier', () => {
    expect(tierIncludesBuildings('base')).toBe(false);
    expect(tierIncludesBuildings('buildings')).toBe(true);
  });
});

describe('isScoutDetected', () => {
  it('detects when the defender has at least one scout at home', () => {
    const troops: TroopCounts = [{ unitType: 'lookout', count: 1 }];
    expect(isScoutDetected(config, troops)).toBe(true);
  });

  it('does not detect an empty troop list', () => {
    expect(isScoutDetected(config, [])).toBe(false);
  });

  it('does not detect when the only entry is a zero-count scout', () => {
    const troops: TroopCounts = [{ unitType: 'lookout', count: 0 }];
    expect(isScoutDetected(config, troops)).toBe(false);
  });

  it('detects a mixed list where at least one entry has a positive count', () => {
    const troops: TroopCounts = [
      { unitType: 'lookout', count: 0 },
      { unitType: 'falconer', count: 2 },
    ];
    expect(isScoutDetected(config, troops)).toBe(true);
  });

  // M2's catalogue is scouts-only (UnitRole is a 'scout'-only literal type today), so there is no
  // real non-scout unit to build this fixture from. This clones config and forces one unit's role
  // to a non-'scout' value (cast through `unknown`, since the M2 UnitRole type only admits
  // 'scout') to model the M3 shape ahead of time: a defender whose only home troops are a
  // non-scout unit type must NOT be reported as detected, even though `count > 0`. This is
  // exactly the bug the role filter in `isScoutDetected` exists to prevent once M3 adds the
  // other 12 unit types to the same `troops` list.
  it('does not detect a defender whose only home troops are a non-scout unit type', () => {
    const nonScoutConfig: GameConfig = {
      ...config,
      units: {
        ...config.units,
        lookout: { ...config.units.lookout, role: 'infantry' as unknown as UnitDef['role'] },
      },
    };
    const troops: TroopCounts = [{ unitType: 'lookout', count: 5 }];
    expect(isScoutDetected(nonScoutConfig, troops)).toBe(false);
  });

  it('still detects when a real scout is present alongside a non-scout unit type', () => {
    const nonScoutConfig: GameConfig = {
      ...config,
      units: {
        ...config.units,
        lookout: { ...config.units.lookout, role: 'infantry' as unknown as UnitDef['role'] },
      },
    };
    const troops: TroopCounts = [
      { unitType: 'lookout', count: 5 }, // non-scout in this cloned config
      { unitType: 'falconer', count: 1 }, // still a real scout
    ];
    expect(isScoutDetected(nonScoutConfig, troops)).toBe(true);
  });
});
