import type { GameConfig } from '../config/types.js';
import type { Tile } from './geometry.js';

/**
 * `R(n)`: the outer Chebyshev radius candidates are drawn up to, once `n` settlements
 * already exist (§3). Monotonic non-decreasing in `n`, capped at `maxRadius`.
 */
export function spawnRadius(config: GameConfig, settlementCount: number): number {
  const { baseRadius, growthCoefficient, maxRadius } = config.map.spawn;
  const raw = baseRadius + Math.ceil(growthCoefficient * Math.sqrt(settlementCount));
  return Math.min(maxRadius, raw);
}

/** The `[inner, outer]` Chebyshev annulus spawn candidates are drawn from at `settlementCount` (§3). */
export function spawnAnnulus(
  config: GameConfig,
  settlementCount: number,
): { inner: number; outer: number } {
  const outer = spawnRadius(config, settlementCount);
  const inner = Math.max(0, outer - config.map.spawn.bandWidth);
  return { inner, outer };
}

export interface PickSpawnTileOptions {
  /** Uniform `[0, 1)` generator, injected so this stays pure and seed-testable. */
  rng: () => number;
  /** True when a candidate tile may be used (terrain + settleability — the caller's job). */
  isLegal: (tile: Tile) => boolean;
  /** Draws attempted within one ring before growing the radius outward. */
  attemptsPerRing?: number;
}

const DEFAULT_ATTEMPTS_PER_RING = 200;

/**
 * Picks one legal tile from the expanding annulus spawn policy (§3): draws candidates
 * uniformly at random within the current `[inner, outer]` Chebyshev annulus (by rejection
 * sampling within the `[-outer, outer]` square, which keeps the distribution uniform over
 * the annulus itself rather than biased toward its inner edge); if none of `attemptsPerRing`
 * draws land on a legal tile, grows `outer` by one ring and retries, up to the whole grid.
 * Returns `null` — never loops forever — once the entire grid has been tried with no legal
 * tile found. Pure: the rng and legality check are both injected by the caller (the server
 * supplies a real rng and a DB-backed legality check; tests supply seeded fakes).
 */
export function pickSpawnTile(
  config: GameConfig,
  settlementCount: number,
  options: PickSpawnTileOptions,
): Tile | null {
  const { rng, isLegal, attemptsPerRing = DEFAULT_ATTEMPTS_PER_RING } = options;
  let outer = spawnRadius(config, settlementCount);

  for (;;) {
    const inner = Math.max(0, outer - config.map.spawn.bandWidth);
    for (let attempt = 0; attempt < attemptsPerRing; attempt += 1) {
      const span = 2 * outer + 1;
      const x = Math.floor(rng() * span) - outer;
      const y = Math.floor(rng() * span) - outer;
      const distance = Math.max(Math.abs(x), Math.abs(y));
      if (distance < inner || distance > outer) {
        continue; // outside the current annulus band; this draw is simply a miss
      }
      const tile = { x, y };
      if (isLegal(tile)) {
        return tile;
      }
    }
    if (outer >= config.map.radius) {
      return null; // exhausted the whole grid; no legal tile exists
    }
    outer += 1;
  }
}
