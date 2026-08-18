import type { GameConfig } from './config/types.js';

/**
 * Beginner protection (§11): while it holds, no foreign movement (raid, assault, scout, support)
 * may target any settlement belonging to the protected account. A **game rule**, not a server
 * detail — the server, the map view, and later the NPC brain must all agree on it, so it lives
 * here rather than being reimplemented at each call site (the codebase's standing rule: no
 * formula is duplicated outside `game-core`).
 */

/**
 * True while beginner protection still holds for `now` (§11).
 *
 * `null`/`undefined` means the account was never protected — reads as `false`, same as expired
 * protection; callers do not need to distinguish "never had it" from "had it and it lapsed".
 *
 * **Boundary: `now === protectedUntil` reads as protection having already ended**, not "still
 * held for one more instant" — `protectedUntil` is the exact instant protection lifts, consistent
 * with how this codebase's other duration boundaries treat their endpoint (e.g. `msUntilEmpty`
 * treats a resource sitting exactly at 0 as already arrived, not one tick before arriving).
 */
export function isBeginnerProtected(
  protectedUntil: number | null | undefined,
  now: number,
): boolean {
  if (protectedUntil == null) {
    return false;
  }
  return now < protectedUntil;
}

/**
 * When protection would expire for an account whose first settlement is created at `at` (§11):
 * `at + config.protection.durationMs`, draft 72h. Protection is not extendable, not purchasable,
 * and does not pause (§11) — this is the only place its expiry is ever computed.
 */
export function beginnerProtectionUntil(config: GameConfig, at: number): number {
  return at + config.protection.durationMs;
}
