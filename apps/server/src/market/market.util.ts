import type { BuildingLevels, GameConfig, ResourceKind, Resources } from '@last-signal/game-core';
import { RESOURCE_KINDS, calcStorageCaps, emptyResources } from '@last-signal/game-core';

export interface OfferRefundResult {
  /** `currentValues` with `resource` credited by `amount`, clamped to this settlement's cap. */
  values: Resources;
  /** How much of `amount` actually landed in storage. */
  delivered: number;
  /** How much overflowed the cap and was lost — not banked, not retroactively wasted elsewhere. */
  lost: number;
}

/**
 * Refunds `amount` of `resource` into `currentValues`, clamped to `buildings`' own storage
 * caps — owner decisions E/F ("Owner decisions during M3d", `docs/PROGRESS.md`): both a
 * player-issued cancel and a `tradeOfferExpire` refund 100% of an offer's `give.amount`, and
 * both follow the exact "credit then clamp, overflow lost" rule `MovementReturnHandler`
 * already applies to raid loot (§6/M1 §5) — nothing here invents a new refund shape.
 *
 * Shared by `MarketService.cancelOffer` (an ownership-checked HTTP command) and
 * `TradeOfferExpireHandler` (an ownerless scheduler handler) specifically so the two refund
 * paths can never compute the clamp differently — the same reason `stationedContingentKey`/
 * `toBuildingLevels` (`settlements.util.ts`) are shared helpers rather than being
 * reimplemented at each call site.
 */
export function computeOfferRefund(
  config: GameConfig,
  buildings: BuildingLevels,
  currentValues: Resources,
  resource: ResourceKind,
  amount: number,
): OfferRefundResult {
  const caps = calcStorageCaps(config, buildings);
  const grown = currentValues[resource] + amount;
  const credited = Math.min(caps[resource], grown);

  // Built field-by-field via `RESOURCE_KINDS`, NOT `{ ...currentValues, [resource]: credited
  // }`. `currentValues` is a live Mongoose subdocument in every real caller
  // (`homeDoc.resources.values`): its `scrap`/`fuel`/`electronics`/`food` are getters on the
  // document's prototype, not the instance's own enumerable properties, so a spread silently
  // picks up Mongoose's internal bookkeeping (`_doc`, `$__`, `$isNew`, …) instead of the real
  // data — the exact hazard `toPlainQueueItem`'s comment (`settlements/build-queue.util.ts`)
  // and `MovementReturnHandler`'s own explicit per-kind credit loop already warn about and
  // avoid. Reading `currentValues[kind]` by property access (not enumeration) is safe; only
  // spreading the whole object is not.
  const values = emptyResources();
  for (const kind of RESOURCE_KINDS) {
    values[kind] = kind === resource ? credited : currentValues[kind];
  }

  return {
    values,
    delivered: Math.max(0, credited - currentValues[resource]),
    lost: grown - credited,
  };
}
