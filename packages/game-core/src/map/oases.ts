import type { GameConfig } from '../config/types.js';
import { chebyshevDistance, type Tile } from './geometry.js';
import { hashStringToUint32, mulberry32 } from './rng.js';
import { canTerrainHostSettlement, terrainAt } from './terrain.js';

/** Draws attempted per oasis before giving up on placing any more (see doc comment below). */
const MAX_ATTEMPTS_PER_OASIS = 5000;

/**
 * Deterministically places farm oases from the world seed at world generation (§2): up to
 * `config.map.oases.count` tiles, pairwise Chebyshev distance >= `minDistance`, never on a
 * toxic lake, never within `edgeMargin` tiles of the grid edge. Two calls with the same seed
 * and config produce the identical list; different seeds produce different lists.
 *
 * The search is bounded and deterministic rather than exhaustive: each oasis gets up to
 * `MAX_ATTEMPTS_PER_OASIS` random draws from its own seeded stream. If placement becomes
 * infeasible (an unreasonable `minDistance`/`edgeMargin` for the grid size, or the target
 * `count` simply doesn't fit), the search stops after the first oasis it fails to place and
 * returns however many it already placed rather than looping forever — callers must be
 * ready to receive fewer than `config.map.oases.count`.
 */
export function generateOases(config: GameConfig, seed: string): Tile[] {
  const { count, minDistance, edgeMargin } = config.map.oases;
  const limit = config.map.radius - edgeMargin;
  const placed: Tile[] = [];
  if (limit < 0) {
    return placed; // edgeMargin excludes the entire grid; nothing is placeable
  }

  const rng = mulberry32(hashStringToUint32(`${seed}:oases`));
  const span = 2 * limit + 1;

  for (let i = 0; i < count; i += 1) {
    let candidate: Tile | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_OASIS; attempt += 1) {
      const x = Math.floor(rng() * span) - limit;
      const y = Math.floor(rng() * span) - limit;
      if (!canTerrainHostSettlement(terrainAt(config, seed, x, y))) {
        continue;
      }
      if (placed.some((other) => chebyshevDistance({ x, y }, other) < minDistance)) {
        continue;
      }
      candidate = { x, y };
      break;
    }
    if (!candidate) {
      break; // infeasible to place any more within the attempt budget; return what we have
    }
    placed.push(candidate);
  }

  return placed;
}
