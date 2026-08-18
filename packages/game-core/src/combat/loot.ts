import type { GameConfig } from '../config/types.js';
import { emptyResources } from '../numeric.js';
import { RESOURCE_KINDS, type Resources } from '../types.js';
import type { BattleResult } from './battle.js';

/**
 * Resources protected from looting per resource, by Hidden Cache level (§6):
 * `hiddenCache.base * hiddenCache.ratio ** (level - 1)`. Draft base 200, ratio 1.35 -> L5 =
 * 664.30125, L10 = 2978.749….
 *
 * **Level 0 is special-cased to exactly 0, not the raw formula.** The formula above is only
 * meaningful for a *built* cache (level >= 1); plugged in at level 0 it evaluates to
 * `200 * 1.35 ** -1 = 148.148…`, a nonsense reading of "protection" for a building that does
 * not exist. A settlement with no Hidden Cache protects nothing. Levels below 0 cannot occur
 * in practice (levels never go negative), but are folded into the same 0 case defensively
 * rather than extrapolating the formula further into territory it was never meant to cover.
 */
export function hiddenCacheProtection(config: GameConfig, level: number): number {
  if (level <= 0) {
    return 0;
  }
  return config.hiddenCache.base * config.hiddenCache.ratio ** (level - 1);
}

/** One defender's loot-relevant state at the instant of arrival (§6). */
export interface LootTarget {
  /** The defender's resources, already settled to the instant of arrival by the caller. */
  stored: Resources;
  hiddenCacheLevel: number;
}

export interface LootResult {
  /** The per-resource protected amount actually applied (`hiddenCacheProtection`'s result). */
  protectedPerResource: number;
  /** `max(0, stored - protection)` per resource — what the Hidden Cache leaves exposed. */
  available: Resources;
  /** What the raiding army actually carries off. */
  taken: Resources;
  /** Σ taken across all four resources. */
  totalTaken: number;
  /** True when availability exceeded capacity and `taken` was scaled down proportionally. */
  capacityBound: boolean;
}

/**
 * Resolves loot for one raid/assault (§6): surviving carry capacity vs the Hidden Cache's
 * per-resource protection. Pure and deterministic — no rounding (resources stay float, per
 * the M1 numeric convention: floored only for display) and no clamping to storage caps. Loot
 * rides home on the movement document and is credited to the attacker on the return leg
 * (M3c), where clamping to the attacker's own storage caps — and losing whatever overflows —
 * is the *caller's* job, not this function's (§6).
 *
 * `battle` is deliberately `Pick<BattleResult, 'lootCapacity' | 'attackerPrevailed'>` rather
 * than a bare capacity number: §6's "an unsuccessful attacker loots nothing" (the attacker was
 * wiped, or `x` reached 1) is a rule about the *battle*, not about loot arithmetic, and folding
 * `attackerPrevailed` into the input type makes forgetting that check a compile error for the
 * M3c caller instead of a runtime bug waiting to be found.
 */
export function resolveLoot(
  config: GameConfig,
  battle: Pick<BattleResult, 'lootCapacity' | 'attackerPrevailed'>,
  target: LootTarget,
): LootResult {
  const protectedPerResource = hiddenCacheProtection(config, target.hiddenCacheLevel);

  const available = emptyResources();
  let totalAvailable = 0;
  for (const kind of RESOURCE_KINDS) {
    const amount = Math.max(0, target.stored[kind] - protectedPerResource);
    available[kind] = amount;
    totalAvailable += amount;
  }

  // §6: an unsuccessful attacker loots nothing — checked before capacity, since a wiped or
  // fully-repelled attacker never gets to the "how much fits" question at all.
  if (!battle.attackerPrevailed) {
    return {
      protectedPerResource,
      available,
      taken: emptyResources(),
      totalTaken: 0,
      capacityBound: false,
    };
  }

  const capacity = battle.lootCapacity;
  if (totalAvailable <= capacity) {
    // Everything exposed fits in the surviving army's holds; nothing needs scaling down.
    return {
      protectedPerResource,
      available,
      taken: { ...available },
      totalTaken: totalAvailable,
      capacityBound: false,
    };
  }

  // Capacity-bound: distribute the take proportionally to each resource's availability, so a
  // raider cannot cherry-pick e.g. Electronics and leave the bulkier resources behind — every
  // resource's share of `taken` equals its share of `available`.
  const taken = emptyResources();
  let totalTaken = 0;
  for (const kind of RESOURCE_KINDS) {
    const amount = (capacity * available[kind]) / totalAvailable;
    taken[kind] = amount;
    totalTaken += amount;
  }

  return { protectedPerResource, available, taken, totalTaken, capacityBound: true };
}
