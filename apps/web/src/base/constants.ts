/**
 * Mirrors `ACTIVE_BUILD_SLOTS` / `WAITING_QUEUE_SLOTS` in
 * `apps/server/src/settlements/settlements.constants.ts`. Not importable across the app
 * boundary (`apps/web` must not depend on `apps/server`), and these are policy numbers, not
 * `game-core` formulas, so there is nothing in `@last-signal/game-core` to import instead —
 * this is a documented, deliberate duplication. Everyone gets one active build slot by
 * default; the Engineers faction's second parallel slot lands with the faction system and
 * will need this constant updated alongside the server value at that point.
 */
export const DEFAULT_ACTIVE_BUILD_SLOTS = 1;

/** Fixed regardless of faction: a two-slot waiting queue on top of the active slot(s). */
export const WAITING_QUEUE_SLOTS = 2;

/** Total build queue capacity (active + waiting) at the default active-slot count. */
export const BUILD_QUEUE_CAPACITY = DEFAULT_ACTIVE_BUILD_SLOTS + WAITING_QUEUE_SLOTS;
