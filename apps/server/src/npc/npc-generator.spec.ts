import {
  DEFAULT_CONFIG,
  FACTIONS,
  SETTLEMENT_SLOTS,
  calcNetFoodPerHour,
  missingPrerequisites,
  mulberry32,
  unitsTrainableAt,
} from '@last-signal/game-core';
import { describe, expect, it } from 'vitest';

import { buildNpcBuildings, buildNpcSpecs, buildNpcTroops } from './npc-generator';
import { NPC_BANDS } from './npc.constants';

const config = DEFAULT_CONFIG;
const YOUNG = NPC_BANDS.find((b) => b.band === 'young')!;
const DEVELOPED = NPC_BANDS.find((b) => b.band === 'developed')!;
const VETERAN = NPC_BANDS.find((b) => b.band === 'veteran')!;

// Pure-function coverage for the M3a.7 additions to `npc-generator.ts` (§19 of
// `docs/M3_DESIGN_DECISIONS.md`): defenders and the Hidden Cache, drawn deterministically
// from the injected `NpcRng` and legal by the same `game-core` prerequisite check every other
// NPC building already goes through. The DB-backed half (real seeded batch, real Mongo docs)
// stays in `npc-seeder.integration.spec.ts`; this file is the DB-free half, run against
// `buildNpcBuildings`/`buildNpcTroops`/`buildNpcSpecs` directly.
describe('buildNpcBuildings — Hidden Cache (§19)', () => {
  it('young never gets a Hidden Cache (band.hiddenCache is null)', () => {
    // Exhaust plausible rolls; a null range means the function never even attempts a draw.
    for (let seed = 0; seed < 50; seed += 1) {
      const buildings = buildNpcBuildings(config, YOUNG, mulberry32(seed));
      expect(buildings.some((b) => b.type === 'hiddenCache')).toBe(false);
    }
  });

  it('developed always gets a Hidden Cache within [2, 3]; veteran within [4, 6]', () => {
    for (let seed = 0; seed < 200; seed += 1) {
      const developed = buildNpcBuildings(config, DEVELOPED, mulberry32(seed));
      const developedCache = developed.find((b) => b.type === 'hiddenCache');
      expect(developedCache).toBeDefined();
      expect(developedCache!.level).toBeGreaterThanOrEqual(2);
      expect(developedCache!.level).toBeLessThanOrEqual(3);

      const veteran = buildNpcBuildings(config, VETERAN, mulberry32(seed + 100_000));
      const veteranCache = veteran.find((b) => b.type === 'hiddenCache');
      expect(veteranCache).toBeDefined();
      expect(veteranCache!.level).toBeGreaterThanOrEqual(4);
      expect(veteranCache!.level).toBeLessThanOrEqual(6);
    }
  });

  it('every placed building (including the Hidden Cache) satisfies missingPrerequisites, for every band', () => {
    for (const band of NPC_BANDS) {
      for (let seed = 0; seed < 50; seed += 1) {
        const buildings = buildNpcBuildings(config, band, mulberry32(seed));
        const levels = buildings.map((b) => ({ type: b.type, level: b.level }));
        for (const building of buildings) {
          expect(missingPrerequisites(config, levels, building.type)).toEqual([]);
        }
      }
    }
  });

  it('a veteran settlement (the largest band) never exceeds SETTLEMENT_SLOTS: Command Center + up to 4 resource buildings + Barracks + Hidden Cache = 7', () => {
    for (let seed = 0; seed < 50; seed += 1) {
      const buildings = buildNpcBuildings(config, VETERAN, mulberry32(seed));
      expect(buildings.length).toBeLessThanOrEqual(7);
      expect(buildings.length).toBeLessThanOrEqual(SETTLEMENT_SLOTS);
    }
  });
});

describe('buildNpcTroops — defenders (§19)', () => {
  it('young gets no troops at all (no scouts, no defenders)', () => {
    for (let seed = 0; seed < 50; seed += 1) {
      for (const faction of FACTIONS) {
        expect(buildNpcTroops(config, YOUNG, faction, mulberry32(seed))).toEqual([]);
      }
    }
  });

  it("developed/veteran defenders, when present, are that faction's own defenseInfantry unit — resolved by role, not name", () => {
    for (const faction of FACTIONS) {
      const expectedDefender = unitsTrainableAt(config, 'barracks', faction).find(
        (u) => u.role === 'defenseInfantry',
      )!;
      expect(expectedDefender).toBeDefined();

      for (let seed = 0; seed < 200; seed += 1) {
        const developedTroops = buildNpcTroops(config, DEVELOPED, faction, mulberry32(seed));
        const developedDefenders = developedTroops.filter(
          (t) => t.unitType === expectedDefender.type,
        );
        // developed's range is [10, 20] — never 0, so a defender entry is always present.
        expect(developedDefenders.length).toBe(1);
        expect(developedDefenders[0]!.count).toBeGreaterThanOrEqual(10);
        expect(developedDefenders[0]!.count).toBeLessThanOrEqual(20);

        const veteranTroops = buildNpcTroops(config, VETERAN, faction, mulberry32(seed + 100_000));
        const veteranDefenders = veteranTroops.filter((t) => t.unitType === expectedDefender.type);
        expect(veteranDefenders.length).toBe(1); // veteran's range [30, 60] never rolls 0
        expect(veteranDefenders[0]!.count).toBeGreaterThanOrEqual(30);
        expect(veteranDefenders[0]!.count).toBeLessThanOrEqual(60);

        // Every troop entry a faction ends up with must be a unit that faction can actually
        // train — never another faction's scout or defence infantry.
        for (const troop of [...developedTroops, ...veteranTroops]) {
          const trainable = unitsTrainableAt(config, 'barracks', faction).map((u) => u.type);
          expect(trainable).toContain(troop.unitType);
        }
      }
    }
  });
});

describe('genesis Food is never negative (M3a.7 §19 "the Food consequence")', () => {
  // Property test across the full band x faction x roll space: a settlement whose net Food
  // per hour is negative at genesis would starve its own troops the moment
  // `starvationTick` next arms on it (M3a.6) — see the step's own report for the worked
  // arithmetic (worst case ~+46 Food/h for `developed`, ~+70 Food/h for `veteran`; no clamp
  // was needed). This test is the guardrail against that arithmetic silently going stale as
  // the bands or Food curves are retuned later.
  it('every band/faction combination stays net-Food-non-negative across many seeded rolls', () => {
    for (const band of NPC_BANDS) {
      for (const faction of FACTIONS) {
        for (let seed = 0; seed < 100; seed += 1) {
          const buildings = buildNpcBuildings(config, band, mulberry32(seed));
          const troops = buildNpcTroops(config, band, faction, mulberry32(seed + 500_000));
          const buildingLevels = buildings.map((b) => ({ type: b.type, level: b.level }));
          const netFood = calcNetFoodPerHour(config, buildingLevels, troops);
          expect(netFood).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

// `randomUUID()` (building slot ids) and `new Types.ObjectId()` (account/settlement ids) are
// real randomness by design — every other draw in this module goes through the injected
// `NpcRng` specifically so it CAN be pinned for a reproducible world, but ids are opaque
// identifiers nothing ever re-derives from a seed, so this strips them before comparing.
function stripIds(specs: ReturnType<typeof buildNpcSpecs>) {
  return specs.map((spec) => ({
    band: spec.band,
    account: { ...spec.account, _id: undefined },
    settlement: {
      ...spec.settlement,
      accountId: undefined,
      buildings: spec.settlement.buildings.map((b) => ({ ...b, id: undefined })),
    },
  }));
}

describe('determinism (§19 + M2a.5): two runs of buildNpcSpecs with the same seed/rng produce identical specs', () => {
  it('identical band, buildings/levels (including Hidden Cache), troops (including defenders), resources, and tiles across two independent runs', () => {
    const oasisTiles = new Set<string>();
    const runOnce = () =>
      buildNpcSpecs(
        config,
        'determinism-test-seed',
        30,
        oasisTiles,
        [],
        new Set<string>(),
        mulberry32(42),
        1_700_000_000_000,
      );

    const first = runOnce();
    const second = runOnce();

    expect(stripIds(second)).toEqual(stripIds(first));
    // Sanity: this world actually exercises the new fields, so the equality check above is
    // meaningful and not vacuously true over an all-`young` batch.
    expect(
      first.some((spec) => spec.settlement.buildings.some((b) => b.type === 'hiddenCache')),
    ).toBe(true);
    expect(first.some((spec) => spec.settlement.troops.length > 0)).toBe(true);
  });
});
