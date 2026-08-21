import type { GameConfig } from '../config/types.js';
import type { ResourceKind } from '../types.js';

/**
 * The world exchange's conversion (§14, M3d.4): converts `amount` of `from` into `to` at a
 * fixed weighted rate, minus a flat spread — `amount * (valueWeights[from] /
 * valueWeights[to]) * (1 - exchangeSpread)`. Draft `exchangeSpread` 0.25
 * (`GameConfig.market`), landed one step ahead of its first reader in M3d.2 with a comment
 * saying so; this function is that reader.
 *
 * **The exchange can never print value — that is the entire point of the spread, and it is
 * exactly why §14 needs "no daily cap, no cooldown and no anti-abuse state" around this
 * endpoint.** `amount` of `from` carries a weighted value of `amount * valueWeights[from]`;
 * what comes out the other side carries `exchangeOutput(...) * valueWeights[to]`, which
 * algebraically simplifies to `amount * valueWeights[from] * (1 - exchangeSpread)` — strictly
 * less than what went in, for any `exchangeSpread > 0`, regardless of which two resources are
 * named. There is therefore no sequence of conversions that manufactures value: every hop
 * loses the same fraction, and a round trip (A -> B -> A) loses it TWICE
 * (`(1 - exchangeSpread) ** 2` of the original weighted value survives) — see
 * `exchange.test.ts`'s round-trip case, which asserts this directly rather than trusting the
 * algebra. Contrast a player-to-player offer (§14's ratio cap, `isOfferRatioLegal`): that cap
 * exists because two willing PLAYERS could otherwise agree to any ratio between themselves.
 * The exchange has no counterparty to collude with — a mechanically-guaranteed loss on every
 * conversion is the anti-abuse mechanism, so there is nothing left for a cap, cooldown or
 * per-account counter to additionally guard against.
 *
 * **Electronics costs double for the same reason it costs double everywhere else this
 * codebase touches Electronics (M1 §1's deliberate bottleneck — `valueWeights.electronics:
 * 2`).** Without that weight, the exchange would let a player buy their way past a scarcity
 * M1 built on purpose, for less than it actually costs the world to produce.
 *
 * **No rounding, on purpose.** Resources are stored as float everywhere in this codebase and
 * only ever floored for display (`floorForDisplay`, `numeric.ts` — the M1 numeric
 * convention); this function returns the exact float the formula produces. Whatever storage-
 * cap clamping the caller applies when crediting the result (`MarketExchangeHandler`) is a
 * separate, later concern — not this function's job, the same division of labour
 * `resolveLoot`'s own comment describes for combat loot.
 *
 * **Boundary convention, mirrored from `merchantsNeededFor`'s own:** `amount <= 0` returns
 * exactly 0 — nothing to convert needs no output — which also folds in the (never-produced-by-
 * a-real-caller, since the HTTP layer validates a positive integer first) hypothetical
 * negative `amount` into the same case, rather than letting the raw formula produce a
 * negative number some future caller would have to separately guard against. Combined with
 * `valueWeights`/`exchangeSpread` always being positive/sub-1 respectively, this is what makes
 * "never negative" a property of the function itself, not just of its validated real callers.
 */
export function exchangeOutput(
  config: GameConfig,
  from: ResourceKind,
  to: ResourceKind,
  amount: number,
): number {
  if (amount <= 0) {
    return 0;
  }
  const rate = config.market.valueWeights[from] / config.market.valueWeights[to];
  return amount * rate * (1 - config.market.exchangeSpread);
}
