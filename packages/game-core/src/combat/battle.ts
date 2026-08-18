import type { GameConfig } from '../config/types.js';
import type { TroopCounts } from '../units/troops.js';

/** The two kinds of hostile movement that resolve through `resolveBattle` (M3 §6). */
export type BattleKind = 'raid' | 'assault';

/** One defending contingent: the target's own troops, or one stationed (foreign) support contingent. */
export interface BattleContingent {
  key: string;
  troops: TroopCounts;
}

export interface BattleInput {
  attacker: TroopCounts;
  /** The target's own troops plus every `stationedTroops` contingent (M3 §5 step 2). */
  defenders: readonly BattleContingent[];
  wallLevel: number;
  kind: BattleKind;
  /** r ∈ [-1, 1), from `battleRoll`. Tests pin 0 to reproduce the §0 contract exactly. */
  roll: number;
}

/** One defending contingent's outcome, keyed the same as the matching `BattleContingent`. */
export interface BattleContingentOutcome {
  key: string;
  losses: TroopCounts;
  survivors: TroopCounts;
}

export interface BattleResult {
  /** Σ (attack × count) over the arriving army, before the roll. */
  atkPtsBase: number;
  /** atkPtsBase × (1 + combat.randomFactor × roll) — the value actually used against defPts. */
  atkPts: number;
  /** atkInf / atkPtsBase, the weight applied to the defenders' infantry defence. */
  atkInfantryShare: number;
  defPtsBeforeWall: number;
  /** wall.defenseRatioPerLevel ** wallLevel. */
  wallFactor: number;
  defPts: number;
  /** x = min(1, (defPts / atkPts) ** combat.lossExponent). */
  x: number;
  attackerLossFraction: number;
  defenderLossFraction: number;
  attacker: { losses: TroopCounts; survivors: TroopCounts };
  /** Sorted by ascending `key`, always — never input array order (determinism, see below). */
  defenders: BattleContingentOutcome[];
  /** Σ (unit.carry × surviving attacker count) — §6's loot capacity. */
  lootCapacity: number;
  /** False when the attacker was wiped or x reached 1 — §6: "an unsuccessful attacker loots nothing". */
  attackerPrevailed: boolean;
}

/**
 * Applies one loss fraction to one troop list, rounding to the nearest whole unit per unit
 * type, independently: `Math.round(fraction * count)`, clamped to `[0, count]`. Exactly the
 * rounding convention `scouting/combat.ts`'s `resolveScoutCombat` already ships and tests
 * (`.5` rounds up, per JS `Math.round`) — reused verbatim rather than inventing a second one,
 * since a player who has learned to read one loss number can read the other.
 */
function applyLossFraction(
  troops: TroopCounts,
  fraction: number,
): { losses: TroopCounts; survivors: TroopCounts } {
  const perType = troops.map(({ unitType, count }) => {
    const lost = Math.min(count, Math.max(0, Math.round(fraction * count)));
    return { unitType, lost, survived: count - lost };
  });
  return {
    losses: perType.map(({ unitType, lost }) => ({ unitType, count: lost })),
    survivors: perType.map(({ unitType, survived }) => ({ unitType, count: survived })),
  };
}

/** Ascending plain-string comparison — the deterministic sort key for `result.defenders`. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Resolves one regular battle — raid or assault — per M3 §5 (steps below map 1:1 onto the
 * design record) and §6 (raid/assault loss formulas). Pure and deterministic: every random
 * element is the caller-supplied `roll` (see `battleRoll`), never `Math.random()`.
 *
 * 1. `atkPtsBase = Σ (unit.attack × count)`, split into `atkInf`/`atkCav` by `unit.splitClass`.
 * 2. `atkPtsBase === 0` throws — see the guard below.
 * 3. `atkPts = atkPtsBase × (1 + combat.randomFactor × roll)` — the roll.
 * 4. `defPtsBeforeWall = atkInfantryShare × Σ defInfantry + atkCavalryShare × Σ defCavalry`,
 *    summed over **every** defending contingent. The shares are computed from the *pre-roll*
 *    `atkPtsBase` (not `atkPts`) — the roll scales the whole attacking army uniformly, so
 *    `atkInf/atkPts === atkInf/atkPtsBase` either way; using the base values just avoids
 *    dividing by a rolled number for no reason.
 * 5. `wallFactor = wall.defenseRatioPerLevel ** wallLevel`; `defPts = defPtsBeforeWall ×
 *    wallFactor`. One multiplier, applies to both raid and assault, no flat bonus.
 * 6. `x = min(1, (defPts / atkPts) ** combat.lossExponent)`.
 * 7. Loss fractions by `kind` (§6): assault → attacker `x`, defender `1`; raid → attacker
 *    `x / (1 + x)`, defender `1 / (1 + x)`.
 * 8. Losses distributed per unit type via `applyLossFraction`.
 *
 * **Defender losses across contingents — resolved by the owner, 2026-08-17.** §5's prose says
 * losses are "shared across contingents proportionally to each contingent's contribution to
 * `defPts`" but also calls it "Travian's rule" — those are two different algorithms (Travian
 * does not weight by defence contribution at all). The owner chose **the uniform loss
 * fraction (actual Travian)**: every contingent, and every unit type inside it, loses the same
 * `defenderLossFraction`, computed once from the combined `defPts`. Losses therefore land
 * proportional to each contingent's body count, not to its defence contribution. This was
 * resolved this way because it is Travian's real rule, it is order-independent and trivially
 * deterministic (no per-contingent contribution bookkeeping to get right), and it reproduces
 * §0's table exactly.
 *
 * **Determinism discipline (load-bearing):** a scheduler can hand the same arrival to a
 * handler twice (replay after a crash), and a replay that kills different units than the
 * report already described is a real bug, not a cosmetic one. `result.defenders` is therefore
 * always sorted by ascending `key`, so the result is byte-identical regardless of the order
 * `input.defenders` arrives in. No `Math.random()`, no `Date.now()`, no reliance on object-key
 * or array order anywhere in this function.
 */
export function resolveBattle(config: GameConfig, input: BattleInput): BattleResult {
  const { attacker, defenders, wallLevel, kind, roll } = input;

  // Step 1: split attack points by splitClass.
  let atkPtsBase = 0;
  let atkInfBase = 0;
  let atkCavBase = 0;
  for (const { unitType, count } of attacker) {
    const unit = config.units[unitType];
    const pts = unit.attack * count;
    atkPtsBase += pts;
    if (unit.splitClass === 'cavalry') {
      atkCavBase += pts;
    } else {
      atkInfBase += pts;
    }
  }

  // Step 2: an army with atkPtsBase === 0 has no ratio to compute and, per §5 step 1, "is
  // rejected at send, not at arrival" — the command layer (a later M3c step) validates
  // `atkPts > 0` before a movement is ever created. Reaching resolveBattle with a zero-point
  // army is therefore a programming error upstream, not a game outcome, and this throws
  // rather than returning a degenerate all-zero result.
  if (atkPtsBase === 0) {
    throw new Error(
      'resolveBattle: attacker has 0 attack points; armies with atkPts = 0 must be rejected ' +
        'at send (M3 §5 step 1), not passed to resolveBattle',
    );
  }

  // Step 3: the roll. Shares below are computed from atkPtsBase (pre-roll) — see the doc
  // comment above for why that is equivalent to using the rolled atkPts.
  const atkInfantryShare = atkInfBase / atkPtsBase;
  const atkCavalryShare = atkCavBase / atkPtsBase;
  const atkPts = atkPtsBase * (1 + config.combat.randomFactor * roll);

  // Step 4: defPtsBeforeWall, summed over every defending contingent.
  let defInfTotal = 0;
  let defCavTotal = 0;
  for (const { troops } of defenders) {
    for (const { unitType, count } of troops) {
      const unit = config.units[unitType];
      defInfTotal += unit.defInfantry * count;
      defCavTotal += unit.defCavalry * count;
    }
  }
  const defPtsBeforeWall = atkInfantryShare * defInfTotal + atkCavalryShare * defCavTotal;

  // Step 5: the wall.
  const wallFactor = config.wall.defenseRatioPerLevel ** wallLevel;
  const defPts = defPtsBeforeWall * wallFactor;

  // Step 6: the shared casualty curve.
  const x = Math.min(1, (defPts / atkPts) ** config.combat.lossExponent);

  // Step 7: loss fractions by kind (§6).
  const attackerLossFraction = kind === 'assault' ? x : x / (1 + x);
  const defenderLossFraction = kind === 'assault' ? 1 : 1 / (1 + x);

  // Step 8: distribute losses, per participant.
  const attackerOutcome = applyLossFraction(attacker, attackerLossFraction);

  const defenderOutcomes = defenders
    .map(({ key, troops }) => {
      const outcome = applyLossFraction(troops, defenderLossFraction);
      return { key, losses: outcome.losses, survivors: outcome.survivors };
    })
    .sort((a, b) => compareStrings(a.key, b.key));

  const lootCapacity = attackerOutcome.survivors.reduce(
    (sum, { unitType, count }) => sum + config.units[unitType].carry * count,
    0,
  );

  // §6: "an unsuccessful attacker loots nothing" — either the attacker was wiped outright
  // (possible even with x < 1, if per-type rounding happens to zero out a small stack) or the
  // battle was a clamped x === 1 even fight/loss.
  const attackerWiped = attackerOutcome.survivors.every((s) => s.count === 0);
  const attackerPrevailed = x < 1 && !attackerWiped;

  return {
    atkPtsBase,
    atkPts,
    atkInfantryShare,
    defPtsBeforeWall,
    wallFactor,
    defPts,
    x,
    attackerLossFraction,
    defenderLossFraction,
    attacker: { losses: attackerOutcome.losses, survivors: attackerOutcome.survivors },
    defenders: defenderOutcomes,
    lootCapacity,
    attackerPrevailed,
  };
}
