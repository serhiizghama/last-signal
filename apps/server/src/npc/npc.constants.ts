import type { BuildingType } from '@last-signal/game-core';

// Env var name + default for how many NPC accounts `NpcSeederService` seeds at world start
// (`docs/M2_DESIGN_DECISIONS.md` §4). Read through `ConfigService`, mirroring the scheduler's
// own env-knob pattern (`scheduler/scheduler.constants.ts`). Every existing integration spec
// that boots the whole `AppModule` sets this to `'0'` in its own `beforeAll` (next to
// `MONGODB_URI`) so seeding never runs during the rest of the suite — see each spec's comment.
export const WORLD_NPC_COUNT_KEY = 'WORLD_NPC_COUNT';
export const DEFAULT_WORLD_NPC_COUNT = 135;

export type NpcBand = 'young' | 'developed' | 'veteran';

export interface NpcBandDef {
  band: NpcBand;
  /** Selection weight; the three bands' weights below sum to 1 (§4: 40/40/20). */
  weight: number;
  /** Inclusive Command Center level range. */
  commandCenter: readonly [number, number];
  /** Inclusive level range drawn independently for each resource building the band builds. */
  resourceBuilding: readonly [number, number];
  hasBarracks: boolean;
  /** Inclusive scout-count range, or `null` for the troopless `young` band. */
  scouts: readonly [number, number] | null;
  /**
   * Inclusive count range of the faction's own `defenseInfantry` unit (Torcher / Bulwark /
   * Hunter-Sniper), or `null` for `young` (§19: no defenders at all — nothing can attack a
   * `young` NPC's own faction-less-anything-yet settlement in a way defence would matter,
   * and it has no Barracks to train from regardless).
   */
  defenders: readonly [number, number] | null;
  /** Inclusive Hidden Cache level range, or `null` for `young` (no cache building placed). */
  hiddenCache: readonly [number, number] | null;
}

// Draft numbers verbatim from §4 (commandCenter/resourceBuilding/scouts) and §19 (defenders/
// hiddenCache). Order matters: `pickNpcBand`'s cumulative-weight roll walks this array in
// order, so reordering it changes which band a given `rng()` draw lands in.
//
// `defenders` counts (M3a.7, §19): chosen by arithmetic against the raid-cost curve
// (`x = min(1, (defPts/atkPts) ** 1.5)`), not picked from thin air — see
// `docs/M3_DESIGN_DECISIONS.md` §19 and the M3a.7 step report for the full derivation.
// Worked against the design record's own 100-Brute reference army (atkPts 4000, §0 row 1)
// and the worst-case defence infantry (Bulwark, defInfantry 65 — the highest of the three
// factions'): `developed` at its low end (10) costs a 100-Brute raid ~6% casualties (cheap,
// meant to be a starter target); at its high end (20) ~16% (a real but affordable toll).
// `veteran` at its low end (30) costs ~25%; at its high end (60) the raider needs
// substantially more than 100 units to avoid `x` capping near 1 (defPts 3900 vs atkPts
// 4000) — a "real committed army", exactly §19's intent. Every faction's own defence-
// infantry `foodUpkeepPerHour` is 1 (verified in the catalogue), so this arithmetic is
// faction-independent.
export const NPC_BANDS: readonly NpcBandDef[] = [
  {
    band: 'young',
    weight: 0.4,
    commandCenter: [1, 2],
    resourceBuilding: [1, 3],
    hasBarracks: false,
    scouts: null,
    defenders: null,
    hiddenCache: null,
  },
  {
    band: 'developed',
    weight: 0.4,
    commandCenter: [3, 5],
    resourceBuilding: [4, 7],
    hasBarracks: true,
    scouts: [0, 3],
    defenders: [10, 20],
    hiddenCache: [2, 3],
  },
  {
    band: 'veteran',
    weight: 0.2,
    commandCenter: [5, 7],
    resourceBuilding: [6, 9],
    hasBarracks: true,
    scouts: [2, 6],
    defenders: [30, 60],
    hiddenCache: [4, 6],
  },
];

// The four resource-producing buildings every band draws a level for (§4's "resource
// buildings"). `electronicsWorkshop` requires Command Center 3 in `game-core`'s own
// catalogue (`buildings.ts`) — never satisfied by the `young` band's CC 1-2 range, so
// `buildNpcBuildings` skips it there via `missingPrerequisites` rather than this list
// special-casing the band.
export const NPC_RESOURCE_BUILDING_TYPES: readonly BuildingType[] = [
  'scrapYard',
  'fuelRefinery',
  'electronicsWorkshop',
  'greenhouseFarm',
];

// Flavor level for the Barracks shell itself: just enough to exist and satisfy its own
// prerequisite chain (Barracks requires CC 3, same as `electronicsWorkshop`) — §4 drafts a
// level range for the CC/resource bands and the scout counts, not for this building itself.
// A first-pass, server-local number in the same spirit as `settlements.constants.ts`'s
// `STARTING_RESOURCES`, not a `game-core` formula input.
export const NPC_BARRACKS_LEVEL = 1;

// Fraction of storage caps NPC resources are initialised at (§4: "~50% of storage caps").
export const NPC_RESOURCE_FILL_RATIO = 0.5;
