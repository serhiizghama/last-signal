import { randomUUID } from 'node:crypto';

import type {
  BuildingType,
  Faction,
  GameConfig,
  Resources,
  Tile,
  UnitType,
} from '@last-signal/game-core';
import {
  FACTIONS,
  calcStorageCaps,
  isSettleable,
  missingPrerequisites,
  pickSpawnTile,
  scoutUnitForFaction,
  terrainAt,
  unitsTrainableAt,
} from '@last-signal/game-core';
import { Types } from 'mongoose';

import { PlacementExhaustedError } from '../placement/placement.errors';
import type { Side } from '../schemas/account.schema';
import { SIDES } from '../schemas/account.schema';
import { generateNpcName } from './npc-names';
import type { NpcBandDef } from './npc.constants';
import {
  NPC_BANDS,
  NPC_BARRACKS_LEVEL,
  NPC_RESOURCE_BUILDING_TYPES,
  NPC_RESOURCE_FILL_RATIO,
} from './npc.constants';
import type { NpcRng } from './npc.tokens';

// Pure, DB-free NPC generation (M2a.5, §4): every function here takes its randomness and
// world data as plain arguments and returns plain data, so `NpcSeederService` can build the
// whole ~135-account batch in memory before ever touching Mongo (see that service's own
// comment on why: ~135 separate read-modify-write round trips would be needlessly slow when
// the same in-memory-accumulator trick `PlacementService.findTile` already relies on for one
// candidate works just as well accumulated across many).

/** Picks a band by the cumulative-weight roll (§4: 40/40/20, in `NPC_BANDS`'s declared order). */
export function pickNpcBand(rng: NpcRng): NpcBandDef {
  const roll = rng();
  let cumulative = 0;
  for (const band of NPC_BANDS) {
    cumulative += band.weight;
    if (roll < cumulative) {
      return band;
    }
  }
  // Floating-point rounding guard, same shape as `terrainAt`'s own fallback: if the
  // configured weights sum to fractionally under 1, fall through to the last band instead of
  // risking an unhandled roll.
  return NPC_BANDS[NPC_BANDS.length - 1]!;
}

function randInt(rng: NpcRng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export interface NpcBuildingSlot {
  id: string;
  type: BuildingType;
  level: number;
  slot: number;
}

/**
 * Builds one NPC settlement's building list for `band` (§4, extended by §19 for the Hidden
 * Cache): Command Center first (always present, at slot 0), then each of
 * `NPC_RESOURCE_BUILDING_TYPES` whose prerequisites are already satisfied by what's been
 * picked so far, then Barracks and finally the Hidden Cache under the same prerequisite
 * check when the band calls for them. Slots are simply the array index — at most 7 buildings
 * ever get placed here (Command Center + up to 4 resource buildings + Barracks + Hidden
 * Cache), far under `SETTLEMENT_SLOTS` (16), so plain sequential assignment can never
 * collide. Every level is clamped to the building's own `maxLevel` as a defensive backstop
 * (§4/§19's draft ranges never approach any `maxLevel` today — the Hidden Cache's is 10, and
 * the highest drawn level is `veteran`'s 6 — but this keeps the function correct if the
 * ranges are tuned closer later).
 */
export function buildNpcBuildings(
  config: GameConfig,
  band: NpcBandDef,
  rng: NpcRng,
): NpcBuildingSlot[] {
  const levels: Array<{ type: BuildingType; level: number }> = [];

  const commandCenterLevel = randInt(rng, band.commandCenter[0], band.commandCenter[1]);
  levels.push({ type: 'commandCenter', level: commandCenterLevel });

  for (const type of NPC_RESOURCE_BUILDING_TYPES) {
    if (missingPrerequisites(config, levels, type).length > 0) {
      // e.g. `electronicsWorkshop` needs Command Center 3 — never satisfied by the `young`
      // band's CC 1-2 range. Skipped rather than forced, so this stays legal for any future
      // band whose CC range doesn't clear a resource building's prerequisite either.
      continue;
    }
    const maxLevel = config.buildings[type].maxLevel;
    const level = Math.min(
      randInt(rng, band.resourceBuilding[0], band.resourceBuilding[1]),
      maxLevel,
    );
    levels.push({ type, level });
  }

  if (band.hasBarracks && missingPrerequisites(config, levels, 'barracks').length === 0) {
    levels.push({ type: 'barracks', level: NPC_BARRACKS_LEVEL });
  }

  // §19: the Hidden Cache protects an NPC's stored resources from raid loot once raiding
  // ships (M3c). It has no prerequisites in `game-core`'s catalogue today, but the
  // `missingPrerequisites` check stays here (rather than placing it unconditionally) so a
  // future prerequisite added to Hidden Cache can never silently produce an illegal NPC
  // settlement — the same uniform-legality reasoning the resource buildings and Barracks
  // above already follow.
  if (band.hiddenCache && missingPrerequisites(config, levels, 'hiddenCache').length === 0) {
    const maxLevel = config.buildings.hiddenCache.maxLevel;
    const level = Math.min(randInt(rng, band.hiddenCache[0], band.hiddenCache[1]), maxLevel);
    levels.push({ type: 'hiddenCache', level });
  }

  return levels.map((entry, index) => ({
    id: randomUUID(),
    type: entry.type,
    level: entry.level,
    slot: index,
  }));
}

export interface NpcTroopEntry {
  unitType: UnitType;
  count: number;
}

/**
 * Draws the band's scout count (§4) for `faction`'s own scout unit, then its defender count
 * (§19) for `faction`'s own `defenseInfantry` unit — resolved via `unitsTrainableAt`'s `role`
 * filter, never a hardcoded unit-type name, since each faction's defence infantry differs
 * (Torcher / Bulwark / Hunter-Sniper). `[]` for `young` (no troops of any kind).
 *
 * Draw order (scouts, then defenders) is part of this world's determinism contract: `rng` is
 * a stream, so the two draws must happen in a fixed, stable order or every NPC in a world
 * regenerated from the same seed would change. Scouts stay first because that's the order
 * M2a.5 already shipped and tested; defenders are appended after rather than inserted before,
 * so this change does not reshuffle any existing NPC's scout count.
 */
export function buildNpcTroops(
  config: GameConfig,
  band: NpcBandDef,
  faction: Faction,
  rng: NpcRng,
): NpcTroopEntry[] {
  const troops: NpcTroopEntry[] = [];

  if (band.scouts) {
    const scoutCount = randInt(rng, band.scouts[0], band.scouts[1]);
    if (scoutCount > 0) {
      const scout = scoutUnitForFaction(config, faction);
      troops.push({ unitType: scout.type, count: scoutCount });
    }
  }

  if (band.defenders) {
    const defenderCount = randInt(rng, band.defenders[0], band.defenders[1]);
    if (defenderCount > 0) {
      const defenseInfantry = unitsTrainableAt(config, 'barracks', faction).find(
        (unit) => unit.role === 'defenseInfantry',
      );
      if (!defenseInfantry) {
        // Every faction has exactly one Barracks-trained `defenseInfantry` unit
        // (`catalogue.test.ts` asserts this for the whole roster) — this can only fire if
        // that invariant is ever broken, and a loud failure here beats a silently
        // defenderless NPC.
        throw new RangeError(
          `buildNpcTroops: no defenseInfantry unit found for faction "${faction}"`,
        );
      }
      troops.push({ unitType: defenseInfantry.type, count: defenderCount });
    }
  }

  return troops;
}

/** Resources at `NPC_RESOURCE_FILL_RATIO` of this settlement's own storage caps (§4). */
export function buildNpcResources(
  config: GameConfig,
  buildings: ReadonlyArray<{ type: BuildingType; level: number }>,
  now: number,
): { values: Resources; lastCalcAt: number } {
  const caps = calcStorageCaps(config, buildings);
  return {
    values: {
      scrap: caps.scrap * NPC_RESOURCE_FILL_RATIO,
      fuel: caps.fuel * NPC_RESOURCE_FILL_RATIO,
      electronics: caps.electronics * NPC_RESOURCE_FILL_RATIO,
      food: caps.food * NPC_RESOURCE_FILL_RATIO,
    },
    lastCalcAt: now,
  };
}

/**
 * Draws one legal tile from the real center-out annulus policy (§3) — the exact same
 * `pickSpawnTile` + `isSettleable` + `terrainAt` call `PlacementService.findTile` makes, just
 * fed an in-memory `existingTiles` list instead of a fresh DB read per candidate. The caller
 * owns mutating `existingTiles` (pushing the returned tile) once it accepts this pick, so the
 * next call's annulus and distance checks account for it — see `buildNpcSpecs`.
 */
export function pickNpcTile(
  config: GameConfig,
  seed: string,
  oasisTiles: ReadonlySet<string>,
  existingTiles: readonly Tile[],
  rng: NpcRng,
): Tile {
  const isLegal = (tile: Tile): boolean =>
    isSettleable(config, {
      tile,
      terrain: terrainAt(config, seed, tile.x, tile.y),
      isOasis: oasisTiles.has(`${tile.x},${tile.y}`),
      existingSettlements: existingTiles,
    });

  const tile = pickSpawnTile(config, existingTiles.length, { rng, isLegal });
  if (!tile) {
    throw new PlacementExhaustedError();
  }
  return tile;
}

export interface NpcAccountSpec {
  _id: Types.ObjectId;
  name: string;
  isGuest: boolean;
  isNpc: boolean;
  faction: Faction;
  side: Side;
}

export interface NpcSettlementSpec {
  accountId: Types.ObjectId;
  name: string;
  x: number;
  y: number;
  buildings: NpcBuildingSlot[];
  resources: { values: Resources; lastCalcAt: number };
  buildQueue: [];
  troops: NpcTroopEntry[];
  version: 0;
}

export interface NpcSpec {
  band: NpcBandDef['band'];
  account: NpcAccountSpec;
  settlement: NpcSettlementSpec;
}

/**
 * Builds one full NPC (account + settlement), mutating both `existingTiles` (appends the
 * chosen tile, so the next NPC's placement/distance checks see it) and `usedNames` (marks the
 * chosen name taken) — the two accumulators `buildNpcSpecs` threads through the whole batch.
 */
export function buildNpcSpec(
  config: GameConfig,
  seed: string,
  oasisTiles: ReadonlySet<string>,
  existingTiles: Tile[],
  usedNames: Set<string>,
  rng: NpcRng,
  now: number,
): NpcSpec {
  const faction = FACTIONS[Math.floor(rng() * FACTIONS.length)]!;
  const side = SIDES[Math.floor(rng() * SIDES.length)]!;
  const band = pickNpcBand(rng);

  const buildings = buildNpcBuildings(config, band, rng);
  const troops = buildNpcTroops(config, band, faction, rng);
  const resources = buildNpcResources(config, buildings, now);

  const tile = pickNpcTile(config, seed, oasisTiles, existingTiles, rng);
  existingTiles.push(tile);

  const name = generateNpcName(rng, usedNames);
  const accountId = new Types.ObjectId();

  return {
    band: band.band,
    account: { _id: accountId, name, isGuest: false, isNpc: true, faction, side },
    settlement: {
      accountId,
      name,
      x: tile.x,
      y: tile.y,
      buildings,
      resources,
      buildQueue: [],
      troops,
      version: 0,
    },
  };
}

/**
 * Builds `count` NPCs in one pass, threading `existingTiles`/`usedNames` through every draw so
 * placement and naming stay consistent across the whole batch. `existingTiles` must already
 * contain every settlement that exists in the database before this call (there may be none —
 * see `NpcSeederService`'s own comment on why it never assumes an empty world); `usedNames`
 * must already contain every existing account name for the same reason.
 */
export function buildNpcSpecs(
  config: GameConfig,
  seed: string,
  count: number,
  oasisTiles: ReadonlySet<string>,
  existingTiles: Tile[],
  usedNames: Set<string>,
  rng: NpcRng,
  now: number,
): NpcSpec[] {
  const specs: NpcSpec[] = [];
  for (let i = 0; i < count; i += 1) {
    specs.push(buildNpcSpec(config, seed, oasisTiles, existingTiles, usedNames, rng, now));
  }
  return specs;
}
