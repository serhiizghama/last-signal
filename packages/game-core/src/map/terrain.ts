import type { GameConfig, MapTerrainWeights } from '../config/types.js';
import { tileRoll } from './rng.js';

/**
 * The six terrain ids (M2 §2). Order matters: it fixes the cumulative-weight buckets
 * `terrainAt` rolls against, so changing the order changes which tiles get which terrain
 * for a given seed — do not reorder casually.
 */
export const TERRAIN_IDS = [
  'wasteland',
  'deadForest',
  'rockyHills',
  'ruinedCity',
  'brokenHighway',
  'toxicLake',
] as const satisfies readonly (keyof MapTerrainWeights)[];

export type TerrainId = (typeof TERRAIN_IDS)[number];

/**
 * Terrain is derived, not stored (§2): a pure function of the world seed and coordinates.
 * No tile documents exist anywhere; server and client both call this to agree on the same
 * map. Rolls one `[0, 1)` value per tile and buckets it against the configured cumulative
 * weights in `TERRAIN_IDS` order.
 */
export function terrainAt(config: GameConfig, seed: string, x: number, y: number): TerrainId {
  const roll = tileRoll(seed, x, y);
  const weights = config.map.terrainWeights;
  let cumulative = 0;
  let lastId: TerrainId = TERRAIN_IDS[0];
  for (const id of TERRAIN_IDS) {
    lastId = id;
    cumulative += weights[id];
    if (roll < cumulative) {
      return id;
    }
  }
  // Floating-point rounding guard: if the configured weights sum to fractionally under 1,
  // fall through to the last terrain id instead of risking an unhandled bucket.
  return lastId;
}

/** Terrain is cosmetic in v1, with exactly one exception: toxic lakes cannot host a settlement (§2). */
export function canTerrainHostSettlement(terrain: TerrainId): boolean {
  return terrain !== 'toxicLake';
}
