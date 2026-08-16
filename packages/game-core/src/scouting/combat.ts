import type { GameConfig } from '../config/types.js';
import { calcTroopScoutAttack, calcTroopScoutDefense, type TroopCounts } from '../units/index.js';

/**
 * Outcome of resolving one scouting arrival's scout-vs-scout combat (§8). Defender scouts never
 * die on defence (Travian rule) — only the attacker's `losses`/`survivors` are tracked; `defPts`
 * is reported for the caller's report payload but the defender's troop list is never touched.
 */
export interface ScoutCombatResult {
  /** Sum of `scoutAttack * count` across the attacking troops. */
  atkPts: number;
  /** Sum of `scoutDefense * count` across the defender's troops at home. */
  defPts: number;
  /** `min(1, (defPts / atkPts) ** lossExponent)`; 0 when `atkPts` is 0 (see below). */
  lossFraction: number;
  /** Attacker losses per unit type, rounded per `resolveScoutCombat`'s rounding rule. */
  losses: TroopCounts;
  /** Attacker survivors per unit type: `count - losses` for each type. */
  survivors: TroopCounts;
  /** True iff at least one attacking unit survived (any `survivors` count > 0). */
  anySurvived: boolean;
}

/**
 * Resolves scout-vs-scout combat for one scouting arrival (§8, the Kirilloid-style casualty
 * curve): `atkPts = Σ scoutAttack`, `defPts = Σ scoutDefense` of the defender's troops at home,
 * `lossFraction = min(1, (defPts / atkPts) ** config.scouting.lossExponent)`. `defPts = 0` yields
 * `lossFraction = 0` with no special case needed — `0 ** exponent` is already 0. Defender troops
 * never take losses (Travian rule); only the attacker's `losses`/`survivors` are computed.
 *
 * Rounding rule: each unit type's loss count is `Math.round(lossFraction * count)`, clamped to
 * `[0, count]` as a defensive backstop — the clamp should never actually bind, since
 * `lossFraction` is capped at 1 by the `min()` (so `round(1 * count) === count` exactly) and
 * `lossFraction >= 0` keeps the raw product non-negative. Rounding is independent per unit type,
 * so a mixed-type attacking army is handled correctly, not just "doesn't crash" — M2 only ever
 * sends one scout type in practice (one scout per faction), but M3 will mix types.
 *
 * `atkPts === 0` (an empty attacking force, or one whose counts are all 0) has no ratio to
 * compute: no attack points means no combat resolves. This returns `lossFraction: 0`, zero losses
 * and the attacker's original counts as survivors, unchanged — so `anySurvived` reflects whatever
 * attacker counts were actually passed in (false for a genuinely empty army) rather than being
 * hardcoded.
 */
export function resolveScoutCombat(
  config: GameConfig,
  attackers: TroopCounts,
  defenders: TroopCounts,
): ScoutCombatResult {
  const atkPts = calcTroopScoutAttack(config, attackers);
  const defPts = calcTroopScoutDefense(config, defenders);

  if (atkPts === 0) {
    const survivors = attackers;
    const losses = attackers.map(({ unitType }) => ({ unitType, count: 0 }));
    return {
      atkPts,
      defPts,
      lossFraction: 0,
      losses,
      survivors,
      anySurvived: survivors.some((s) => s.count > 0),
    };
  }

  const lossFraction = Math.min(1, (defPts / atkPts) ** config.scouting.lossExponent);

  // Computed together per unit type (rather than mapping `attackers` twice and cross-indexing
  // the two results) so there is no separate array lookup that TypeScript can't prove in bounds.
  const perType = attackers.map(({ unitType, count }) => {
    const lost = Math.min(count, Math.max(0, Math.round(lossFraction * count)));
    return { unitType, lost, survived: count - lost };
  });
  const losses = perType.map(({ unitType, lost }) => ({ unitType, count: lost }));
  const survivors = perType.map(({ unitType, survived }) => ({ unitType, count: survived }));

  return {
    atkPts,
    defPts,
    lossFraction,
    losses,
    survivors,
    anySurvived: survivors.some((s) => s.count > 0),
  };
}
