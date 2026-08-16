import type { BuildingLevels, GameConfig } from '../config/types.js';
import type { Resources } from '../types.js';
import type { TroopCounts } from '../units/index.js';
import { resolveScoutCombat, type ScoutCombatResult } from './combat.js';
import { isScoutDetected, resolveIntelTier, tierIncludesBuildings } from './intel.js';

/** Everything one scouting arrival needs to resolve combat, intel and detection (§6, §8). */
export interface ScoutingInput {
  /** The arriving scouts (the marching army). */
  attackers: TroopCounts;
  /** The defender's troops at home, read at arrival — feeds both combat and base-tier intel. */
  defenderHomeTroops: TroopCounts;
  attackerRadioTowerLevel: number;
  defenderRadioTowerLevel: number;
  /** Settled inside the same transaction as arrival (§8) — the snapshot is exact. */
  defenderResources: Resources;
  defenderStorageCaps: Resources;
  defenderBuildings: BuildingLevels;
}

/** All attackers died: no intel was gathered (§8's "mission failed, no survivors" report). */
export interface NoIntel {
  tier: 'none';
}

/** Always granted when at least one attacker survives: resources, storage caps, troops at home. */
export interface BaseIntel {
  tier: 'base';
  resources: Resources;
  storageCaps: Resources;
  troops: TroopCounts;
}

/** Granted once the Radio Tower differential clears the config threshold (§8): base + buildings. */
export interface BuildingsIntel {
  tier: 'buildings';
  resources: Resources;
  storageCaps: Resources;
  troops: TroopCounts;
  buildings: BuildingLevels;
}

/**
 * The scouting intel payload, distinguishable at the type level rather than by checking fields
 * for `undefined`: `'none'` (mission failed), `'base'` or `'buildings'` (§8's two live tiers).
 */
export type ScoutingIntel = NoIntel | BaseIntel | BuildingsIntel;

export interface ScoutingResult {
  combat: ScoutCombatResult;
  intel: ScoutingIntel;
  /** True iff the defender gets a counter-report (§8). */
  detected: boolean;
}

/**
 * The single resolution entry point for a scouting arrival (§8): combat, intel-tier gating and
 * detection in one call. `detected` depends only on the defender's home troops at arrival, not on
 * whether any attacking scout survived — a defender with a scout home is detected even when the
 * attacker's whole force dies. Display-free per `game-core`'s convention: ids and numbers only,
 * no prose — the server maps this into report documents and the client renders it.
 */
export function resolveScouting(config: GameConfig, input: ScoutingInput): ScoutingResult {
  const combat = resolveScoutCombat(config, input.attackers, input.defenderHomeTroops);
  const detected = isScoutDetected(config, input.defenderHomeTroops);

  if (!combat.anySurvived) {
    return { combat, intel: { tier: 'none' }, detected };
  }

  const tier = resolveIntelTier(
    config,
    input.attackerRadioTowerLevel,
    input.defenderRadioTowerLevel,
  );
  const base = {
    resources: input.defenderResources,
    storageCaps: input.defenderStorageCaps,
    troops: input.defenderHomeTroops,
  };
  const intel: ScoutingIntel = tierIncludesBuildings(tier)
    ? { tier: 'buildings', ...base, buildings: input.defenderBuildings }
    : { tier: 'base', ...base };

  return { combat, intel, detected };
}
