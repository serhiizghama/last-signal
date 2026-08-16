// Injectable seam for every random draw `NpcSeederService`/`npc-generator.ts` make — faction,
// side, band, building levels, scout counts, name picks, and tile placement (fed straight
// into `game-core`'s `pickSpawnTile`, exactly like `PlacementService` does with its own
// `PLACEMENT_RNG`). Mirrors that token's pattern deliberately (a DI seam, never a bare
// `Math.random()` call inside a formula — `game-core` itself stays clock- and
// randomness-free), but is its own token rather than a reuse of `PLACEMENT_RNG`: that token
// is a `PlacementModule`-local provider (not exported — see `placement.module.ts`), and this
// module's seeding run needs one rng for everything it draws, not just tile placement, so a
// second token scoped to this module is the natural fit rather than reaching into another
// feature module's internals.
export const NPC_RNG = Symbol('NPC_RNG');

/** Uniform `[0, 1)` generator — the same shape as `PlacementRng`. */
export type NpcRng = () => number;
