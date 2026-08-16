import type { TerrainId } from '@last-signal/game-core';

/**
 * Flat placeholder colours per terrain type (M2 §11 — real tile-art slicing is M6; these are
 * the "palette-coloured tiles" the design record explicitly asks for in the meantime). Chosen
 * within the project's reference palette spirit (`docs/ASSET_PROMPTS.md`: "dusty sunset, warm
 * rust, faded teal") rather than reusing the 8-token UI palette directly — six terrain types
 * need six *mutually* distinguishable yet muted tones, more range than the UI palette alone
 * provides. `wasteland` (55% of tiles, the default backdrop) stays closest to the reference
 * dusty tan; `toxicLake` leans toward the project's `--toxic` green (the one terrain that
 * can't host a settlement, §2) but desaturated so it doesn't compete visually with the UI's
 * own toxic-green success/Beacon accents or the oasis markers drawn on top of the grid.
 */
export const TERRAIN_COLORS: Record<TerrainId, string> = {
  wasteland: '#8a7454',
  deadForest: '#4b4536',
  rockyHills: '#6e6357',
  ruinedCity: '#5a5650',
  brokenHighway: '#3f3a35',
  toxicLake: '#4f6b3a',
};
