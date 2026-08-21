import type { Faction, GameConfig } from '../config/types.js';

/**
 * The Market §14: merchants are not units, not trained, not lost. A settlement's merchant
 * count is a flat multiple of its Market level — `merchantsPerLevel * marketLevel`, draft
 * 1/level. Unlike `hiddenCacheProtection`'s geometric curve, §14 states this shape directly
 * as a straight multiple, not a curve family, so there is no special case needed for level 0:
 * `merchantsPerLevel * 0 = 0` already reads correctly as "no Market, no merchants" through the
 * formula itself. `marketLevel` is still floored at 0 defensively (levels never go negative in
 * practice, but nothing here assumes the caller already checked that).
 */
export function merchantsFromMarketLevel(config: GameConfig, marketLevel: number): number {
  return config.market.merchantsPerLevel * Math.max(0, marketLevel);
}

/** Loot/carry capacity per merchant of `faction` (§14's table). Draft 1000/500/750. */
export function merchantCapacity(config: GameConfig, faction: Faction): number {
  return config.merchant.capacityByFaction[faction];
}

/** Merchant travel speed (fields/hour at classic x1) for `faction` (§14's table). Draft 12/16/24. */
export function merchantSpeed(config: GameConfig, faction: Faction): number {
  return config.merchant.speedByFaction[faction];
}

/**
 * Merchants required to move `amount` units of a resource for `faction` (§14):
 * `ceil(amount / merchantCapacity(...))`.
 *
 * **Boundary conventions, both explicit:** a positive `amount` always needs at least 1
 * merchant — `Math.ceil` already guarantees this for any `amount > 0` given a positive
 * capacity, but the `Math.max(1, ...)` floor is kept anyway as a literal statement of the
 * brief's own rule rather than an implicit consequence of the arithmetic, the same way
 * `hiddenCacheProtection` special-cases level 0 explicitly instead of trusting the raw
 * formula to happen to produce the right answer there. `amount === 0` returns exactly 0, not
 * 1: nothing to move needs nobody to move it — mirrored from `isOfferRatioLegal`'s own
 * zero-amount guard rather than treated as a curiosity unique to this function.
 */
export function merchantsNeededFor(config: GameConfig, faction: Faction, amount: number): number {
  if (amount <= 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(amount / merchantCapacity(config, faction)));
}
