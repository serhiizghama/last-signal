// Injectable seam for the uniform `[0, 1)` random source `game-core`'s `pickSpawnTile` draws
// candidates from (see `PlacementService.findTile`). A DI token — not a bare `Math.random`
// call inside the service — so integration tests can substitute a deterministic generator:
// that is the only way to force, and therefore assert on, the unique `{x, y}` index's
// duplicate-key retry path in `SettlementsService.createSettlement`, since a genuinely random
// draw only very rarely collides. Mirrors `GAME_CONFIG`'s pattern
// (`game-config/game-config.tokens.ts`): a Symbol token, bound in `PlacementModule` to
// `() => Math.random()` in production.
export const PLACEMENT_RNG = Symbol('PLACEMENT_RNG');

/** Uniform `[0, 1)` generator — the exact shape `pickSpawnTile`'s `rng` option expects. */
export type PlacementRng = () => number;
