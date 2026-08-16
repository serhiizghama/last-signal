import type { GameConfig } from '../config/types.js';
import { chebyshevDistance, isInGrid, type Tile } from './geometry.js';
import { canTerrainHostSettlement, type TerrainId } from './terrain.js';

/** Everything the settleability rule needs to know about one candidate tile (§3). */
export interface SettleabilityInput {
  tile: Tile;
  terrain: TerrainId;
  /** Whether `tile` itself is a farm oasis tile. Adjacency to an oasis is fine; ON one is not. */
  isOasis: boolean;
  existingSettlements: readonly Tile[];
}

/**
 * True when `input.tile` may host a settlement (§3): inside the grid, not a toxic lake, not
 * an oasis tile, and at Chebyshev distance >= `config.map.settlement.minDistance` from every
 * existing settlement. Combines every placement rule in one place so the server never has to
 * reimplement any of them.
 */
export function isSettleable(config: GameConfig, input: SettleabilityInput): boolean {
  if (!isInGrid(config, input.tile)) {
    return false;
  }
  if (!canTerrainHostSettlement(input.terrain)) {
    return false;
  }
  if (input.isOasis) {
    return false;
  }
  const minDistance = config.map.settlement.minDistance;
  return input.existingSettlements.every(
    (existing) => chebyshevDistance(input.tile, existing) >= minDistance,
  );
}
