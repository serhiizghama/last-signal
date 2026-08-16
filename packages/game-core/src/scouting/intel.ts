import type { GameConfig } from '../config/types.js';
import type { TroopCounts } from '../units/index.js';

/** Report-depth tiers unlocked by the Radio Tower differential (§8). Stable ids; no prose. */
export const INTEL_TIERS = ['base', 'buildings'] as const;

export type IntelTier = (typeof INTEL_TIERS)[number];

/**
 * Which intel tier a scouting arrival unlocks, from the Radio Tower level differential
 * `diff = attackerTower - defenderTower` (§8), both read at arrival. `diff >=
 * config.scouting.buildingsTierMinDiff` unlocks `'buildings'` (adds the full building list with
 * levels); everything else, including negative diffs, stays `'base'` (resources, storage caps,
 * troop counts at home — always granted when any intel is granted at all, see `resolveScouting`).
 * Deeper tiers (queue contents, incoming movements) are reserved for M3 — not modeled here.
 */
export function resolveIntelTier(
  config: GameConfig,
  attackerRadioTowerLevel: number,
  defenderRadioTowerLevel: number,
): IntelTier {
  const diff = attackerRadioTowerLevel - defenderRadioTowerLevel;
  return diff >= config.scouting.buildingsTierMinDiff ? 'buildings' : 'base';
}

/** True iff `tier` includes the full building list — the report builder's single source of truth. */
export function tierIncludesBuildings(tier: IntelTier): boolean {
  return tier === 'buildings';
}

/**
 * Detection (§8, Travian rule): the defender receives a counter-report iff they have at least
 * one *scout* at home at arrival — not merely "any troops present". Filters `defenders` by
 * `config.units[unitType].role === 'scout'`, so it takes `config` first like every other formula
 * in this package. In M2 every catalogued unit is a scout, so "has troops" and "has a scout"
 * coincide today and this filter is a no-op in practice — but M3 adds 12 non-scout unit types to
 * the same `troops` list, and without the role filter a defender holding only infantry at home
 * would silently start "detecting" scouts, a latent bug that would compile fine and behave
 * wrongly. A named predicate rather than an inline check at the call site, so the rule has one
 * home. A `{count: 0}` entry (which the command layer strips before troops reach here, but this
 * predicate stays defensive regardless) counts as "no scout", not as a scout present.
 */
export function isScoutDetected(config: GameConfig, defenders: TroopCounts): boolean {
  return defenders.some(
    ({ unitType, count }) => count > 0 && config.units[unitType].role === 'scout',
  );
}
