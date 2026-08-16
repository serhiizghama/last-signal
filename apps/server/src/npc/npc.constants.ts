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
}

// Draft numbers verbatim from §4. Order matters: `pickNpcBand`'s cumulative-weight roll walks
// this array in order, so reordering it changes which band a given `rng()` draw lands in.
export const NPC_BANDS: readonly NpcBandDef[] = [
  {
    band: 'young',
    weight: 0.4,
    commandCenter: [1, 2],
    resourceBuilding: [1, 3],
    hasBarracks: false,
    scouts: null,
  },
  {
    band: 'developed',
    weight: 0.4,
    commandCenter: [3, 5],
    resourceBuilding: [4, 7],
    hasBarracks: true,
    scouts: [0, 3],
  },
  {
    band: 'veteran',
    weight: 0.2,
    commandCenter: [5, 7],
    resourceBuilding: [6, 9],
    hasBarracks: true,
    scouts: [2, 6],
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
