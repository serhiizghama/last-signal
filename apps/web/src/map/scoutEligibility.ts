import type { Faction, GameConfig, TroopCounts, UnitType } from '@last-signal/game-core';
import { scoutUnitForFaction } from '@last-signal/game-core';

export type ScoutBlockReason = { kind: 'noScoutsAtHome' };

export interface ScoutEligibility {
  scoutUnitType: UnitType;
  availableCount: number;
  canScout: boolean;
  block: ScoutBlockReason | undefined;
}

/**
 * Whether — and why not — the caller can send scouts right now, mirroring
 * `computeBuildEligibility`'s shape (`base/buildEligibility.ts`) so a disabled action always
 * carries a reason the same way a disabled build does. Only called once the sheet has already
 * established the target is a settlement that isn't the caller's own
 * (`tileSelection.ts`'s `classifyTile` handles that split, and the design record — §11 — says
 * the client must never offer the scout action at all outside that case) — so the only thing
 * left that can block the send is having zero of the faction's one scout type (§7) at home.
 */
export function computeScoutEligibility(
  config: GameConfig,
  faction: Faction,
  troops: TroopCounts,
): ScoutEligibility {
  const scoutUnit = scoutUnitForFaction(config, faction);
  const availableCount = troops.find((t) => t.unitType === scoutUnit.type)?.count ?? 0;

  if (availableCount <= 0) {
    return {
      scoutUnitType: scoutUnit.type,
      availableCount,
      canScout: false,
      block: { kind: 'noScoutsAtHome' },
    };
  }

  return {
    scoutUnitType: scoutUnit.type,
    availableCount,
    canScout: true,
    block: undefined,
  };
}
