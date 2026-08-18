import type { GameConfig } from '../config/types.js';

/** Incoming-movement detail tiers, gated by the target settlement's Radio Tower level (§12). */
export const INCOMING_DETAIL_TIERS = ['existence', 'kind', 'full'] as const;

export type IncomingDetailTier = (typeof INCOMING_DETAIL_TIERS)[number];

/**
 * Which detail tier a defending settlement's Radio Tower level unlocks for an incoming hostile
 * movement (§12): `'existence'` (that an attack is inbound, its arrival time, and its origin
 * tile + owner), `'kind'` (adds raid vs assault and the total unit count) at
 * `config.radioTower.incomingTiers.kind`, `'full'` (adds full composition per unit type,
 * including siege count and the siege target) at `.incomingTiers.full`.
 *
 * **`'existence'` is granted at every level, including 0 — it is never gated.** §12 is explicit
 * about why: the Radio Tower needs Command Center 5 + Electronics Workshop 3, so it does not
 * exist at all in Act 1; a casual player losing an army to an attack they had no way to know was
 * coming is exactly the outcome this tier system exists to prevent. The tower buys *detail*, not
 * the *existence* of the warning — this function can never return anything below `'existence'`.
 *
 * (Incoming support and, separately, incoming scouts are not covered by this function — §12:
 * support is always fully visible regardless of tower level, since it is help the host may need
 * to evict; scouts are never visible before arrival, M2 §8's rule.)
 */
export function incomingDetailTier(
  config: GameConfig,
  radioTowerLevel: number,
): IncomingDetailTier {
  const { kind, full } = config.radioTower.incomingTiers;
  if (radioTowerLevel >= full) {
    return 'full';
  }
  if (radioTowerLevel >= kind) {
    return 'kind';
  }
  return 'existence';
}
