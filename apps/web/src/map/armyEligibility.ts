import type { GameConfig, TroopCounts, UnitType } from '@last-signal/game-core';

import type { AttackableMovementType } from './movementLegality';

/** One unit type actually at home, and how many of it are available to send (§17). */
export interface ArmyUnitOption {
  unitType: UnitType;
  availableCount: number;
}

/**
 * Which of the unit types actually at home (`troops` = `settlement.troops`, never the full
 * roster — §17: "bounded by what is actually at home") can be added to a `movementType`
 * army, mirroring `MovementsService.sendMovement`'s own per-unit role pass (§1/§9) exactly —
 * see that method's step 4 for the rules this reproduces. The picker built from this list can
 * therefore never *offer* a unit the server would reject with `scoutsInArmy` /
 * `siegeOnlyOnAssault` / `unitNotAllowed`: the same "don't merely disable it, never offer it
 * at all" convention `TileInfoSheet` already follows for the scout action on the caller's own
 * settlement.
 */
export function armyUnitOptions(
  config: GameConfig,
  movementType: AttackableMovementType,
  troops: TroopCounts,
): ArmyUnitOption[] {
  return troops
    .filter(({ unitType }) => isUnitEligibleForMovement(config, movementType, unitType))
    .map(({ unitType, count }) => ({ unitType, availableCount: count }));
}

function isUnitEligibleForMovement(
  config: GameConfig,
  movementType: AttackableMovementType,
  unitType: UnitType,
): boolean {
  const role = config.units[unitType].role;

  // Settlers only ever march as a `settle` convoy (§13 — a different form entirely, M3e.6)
  // and wildlife is never player-owned (§10) — both barred from all three types here, same
  // as the server's `unitNotAllowed` rejection. Neither can actually appear in a real
  // settlement's `troops` today, but the guard stays regardless, for the same reason the
  // server keeps its own.
  if (role === 'settler' || role === 'wildlife') {
    return false;
  }
  // Scouts never fight in a regular battle (§1: "scouts may not be added to a raid or
  // assault army") — barred from raid/assault; §8 is explicit that support may carry them
  // (stationed scouts count for the host's defence).
  if (role === 'scout') {
    return movementType === 'support';
  }
  // Siege units may only ever go out on an assault (§7/§9).
  if (role === 'siege') {
    return movementType === 'assault';
  }
  // offenseInfantry / defenseInfantry / fast: legal on every one of the three types.
  return true;
}

/**
 * Total regular-battle attack points a unit selection would bring (§9 step 5,
 * `errors.movement.noAttackPower`) — a one-line reduction over each unit's own public
 * `attack` field, not a `game-core` export. Same reasoning as the server's own
 * `sumAttackPoints` (`apps/server/src/movements/movements.util.ts`, kept private to that
 * module for the identical reason): there is no catalogue entry today where this can actually
 * land at 0 for a raid/assault-eligible selection (every offence/defence/fast/siege unit has
 * `attack > 0`), so this is a real guard against a future 0-attack combat unit, mirrored
 * client-side so the two layers can never disagree about when an army is toothless — not a
 * `game-core` formula being duplicated, since there is no hidden game-balance logic here
 * beyond reading a field the client already reads elsewhere (`TrainingBuildingCard`'s own
 * `def.attack`).
 */
export function sumAttackPoints(
  config: GameConfig,
  units: ReadonlyArray<{ unitType: UnitType; count: number }>,
): number {
  return units.reduce(
    (total, { unitType, count }) => total + config.units[unitType].attack * count,
    0,
  );
}

export type AttackBlockReason =
  { kind: 'emptyUnits' } | { kind: 'noAttackPower' } | { kind: 'siegeTargetRequired' };

/**
 * Whether — and why not — the currently-selected army can be sent, mirroring the relevant
 * slice of `MovementsService.sendMovement`'s validation pipeline (§9) that the client can
 * usefully pre-check: something must actually be selected, a raid/assault needs real attack
 * power, and an assault carrying a siege unit must name a `siegeTarget` (never defaulted to
 * `'wall'` — that is the attacker's own decision, §7). Troop availability itself is enforced
 * structurally by `armyUnitOptions`' own `max` bound on each input, not re-checked here.
 */
export function computeAttackBlockReason(
  config: GameConfig,
  movementType: AttackableMovementType,
  selectedUnits: ReadonlyArray<{ unitType: UnitType; count: number }>,
  hasSiegeUnit: boolean,
  siegeTarget: string | undefined,
): AttackBlockReason | undefined {
  if (selectedUnits.length === 0) {
    return { kind: 'emptyUnits' };
  }
  if (movementType !== 'support' && sumAttackPoints(config, selectedUnits) <= 0) {
    return { kind: 'noAttackPower' };
  }
  if (hasSiegeUnit && siegeTarget === undefined) {
    return { kind: 'siegeTargetRequired' };
  }
  return undefined;
}
