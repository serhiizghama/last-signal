import type { GameConfig } from '../config/types.js';

/** A single map coordinate. Integer grid units, not pixels (M2 §1). */
export interface Tile {
  x: number;
  y: number;
}

/** Chebyshev ("king move") distance: `max(|dx|, |dy|)` — the map's distance metric (§1). */
export function chebyshevDistance(a: Tile, b: Tile): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * True when `tile` lies within the bounded, non-wrapping grid (§1): both axes within
 * `[-config.map.radius, config.map.radius]`.
 */
export function isInGrid(config: GameConfig, tile: Tile): boolean {
  const { radius } = config.map;
  return tile.x >= -radius && tile.x <= radius && tile.y >= -radius && tile.y <= radius;
}
