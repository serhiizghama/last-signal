import type { GameConfig } from '../config/types.js';
import type { ResourceKind } from '../types.js';

/** One side of an offer (§14): a resource kind and how much of it. Shared by `give`/`want`. */
export interface OfferSide {
  resource: ResourceKind;
  amount: number;
}

/** Weighted value of `amount` units of `resource` (§14): `valueWeights[resource] * amount`. */
export function weightedResourceValue(
  config: GameConfig,
  resource: ResourceKind,
  amount: number,
): number {
  return config.market.valueWeights[resource] * amount;
}

/**
 * The offer ratio cap (§14): `1/maxOfferRatio <= giveValue/wantValue <= maxOfferRatio`, in
 * weighted value (`weightedResourceValue`) — Travian's rule, and the thing that stops "I give
 * 1 Scrap for 10 000 Electronics" being used as a gift or a laundering channel.
 *
 * **Boundary convention: inclusive at both ends.** An offer at exactly `maxOfferRatio` (draft
 * 2.0) or exactly `1/maxOfferRatio` (draft 0.5) is legal, not rejected — §14 states the rule
 * with `<=` on both sides verbatim ("`1/2 <= give/want <= 2`"), so this is a literal reading
 * of the record, not an invented convention. Contrast `isBeginnerProtected`'s boundary (`now
 * === protectedUntil` reads as *expired*): that is a different kind of boundary — the instant
 * a duration ends — and its convention does not transfer here; a ratio cap sitting exactly on
 * its configured limit is a value *inside* the legal range, not one instant past it.
 *
 * **Zero-amount guard:** a `give`/`want` amount of 0 makes the ratio 0, `Infinity`, or `NaN`
 * (0/0) — none of which describes a meaningful trade — so either side being non-positive is
 * rejected outright, before the ratio is even computed. The server's own validation already
 * rejects a non-positive offer amount before this function is ever called in a real request
 * (`errors.market.invalidAmount`, checked earlier in the pipeline than the ratio cap); this
 * guard exists so the function is still correct standing alone, for its own unit tests and for
 * any future caller that does not already enforce positivity upstream — the same "don't
 * extrapolate the formula into meaningless territory" principle `hiddenCacheProtection`
 * documents for its own level-0 special case.
 */
export function isOfferRatioLegal(config: GameConfig, give: OfferSide, want: OfferSide): boolean {
  if (give.amount <= 0 || want.amount <= 0) {
    return false;
  }
  const giveValue = weightedResourceValue(config, give.resource, give.amount);
  const wantValue = weightedResourceValue(config, want.resource, want.amount);
  const ratio = giveValue / wantValue;
  const maxRatio = config.market.maxOfferRatio;
  return ratio >= 1 / maxRatio && ratio <= maxRatio;
}
