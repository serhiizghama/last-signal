import type { Faction, GameConfig, TroopCounts, UnitType } from '@last-signal/game-core';
import { scoutUnitForFaction } from '@last-signal/game-core';

export type ScoutBlockReason = { kind: 'noScoutsAtHome' } | { kind: 'protected' };

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
 * established the target is a settlement or oasis that isn't the caller's own
 * (`tileSelection.ts`'s `classifyTile` handles that split, and the design record — §11 — says
 * the client must never offer the scout action at all outside that case) — so what's left that
 * can block the send is beginner protection on the target (§11: "scout" is explicitly one of
 * the foreign movement types protection blocks) or having zero of the faction's one scout type
 * (§7) at home.
 *
 * `isProtected` is checked first, ahead of the troop count: protection is a fact about the
 * TARGET, not this settlement's own roster, and must read as "categorically unavailable"
 * rather than being conflated with "you happen to have zero scouts right now" — the same
 * distinction `TileInfoSheet`/`AttackForm` draw for raid/assault/support.
 */
export function computeScoutEligibility(
  config: GameConfig,
  faction: Faction,
  troops: TroopCounts,
  isProtected: boolean,
): ScoutEligibility {
  const scoutUnit = scoutUnitForFaction(config, faction);
  const availableCount = troops.find((t) => t.unitType === scoutUnit.type)?.count ?? 0;

  if (isProtected) {
    return {
      scoutUnitType: scoutUnit.type,
      availableCount,
      canScout: false,
      block: { kind: 'protected' },
    };
  }

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
