import type { BuildingType, GameConfig } from '../config/types.js';
import type { BattleResult } from './battle.js';

/**
 * Points needed to knock ONE level off a building (or the wall) currently at `level` (§7):
 * `siege.resistanceBase * siege.resistanceRatio ** (level - 1)`. Draft base 6, ratio 1.18 ->
 * L7 = 16.197324918143995, L10 = 26.61272315490796 — the §7 worked draft's per-level costs.
 * Meaningful for `level >= 1` only; `resolveSiegePass` never calls it below a target's floor.
 */
export function siegeResistance(config: GameConfig, level: number): number {
  return config.siege.resistanceBase * config.siege.resistanceRatio ** (level - 1);
}

/**
 * Spends `points` knocking levels off a single level counter, one level at a time, stopping at
 * `floor` or when the remaining points can no longer afford the next level's full cost (§7:
 * "leftover points are discarded — there is no carry-over between attacks" and no partial-level
 * state is ever stored, so a level only ever drops when it is paid for in full).
 */
function spendSiegePoints(
  config: GameConfig,
  points: number,
  currentLevel: number,
  floor: number,
): { levelAfter: number; spent: number; discarded: number } {
  let level = currentLevel;
  let remaining = points;
  let spent = 0;
  while (level > floor) {
    const cost = siegeResistance(config, level);
    if (remaining < cost) {
      break;
    }
    remaining -= cost;
    spent += cost;
    level -= 1;
  }
  return { levelAfter: level, spent, discarded: remaining };
}

/** The state of the target settlement's wall and named siege target, at the instant of arrival. */
export interface SiegeTargetState {
  wallLevel: number;
  /** 'wall', or the building type the assault order named. */
  siegeTarget: 'wall' | BuildingType;
  /** Current level of the building named by `siegeTarget`; ignored when siegeTarget === 'wall'. */
  targetBuildingLevel: number;
}

export interface SiegeResult {
  /** Σ wallDamage over surviving siege units. */
  wallPoints: number;
  /** Σ buildingDamage over surviving siege units. */
  buildingPoints: number;
  wallLevelBefore: number;
  wallLevelAfter: number;
  wallPointsSpent: number;
  wallPointsDiscarded: number;
  /** True when the wall stands at 0 after the wall phase — the gate on building damage. */
  wallBreached: boolean;
  targetLevelBefore: number;
  targetLevelAfter: number;
  buildingPointsSpent: number;
  buildingPointsDiscarded: number;
}

/**
 * Resolves one siege pass (§7): the wall-first breach, the per-level resistance curve, and the
 * Command Center floor. Pure and deterministic — no rounding (points stay float, the same
 * numeric convention `loot.ts` uses) and no I/O.
 *
 * **Purity boundary (load-bearing, §7):** this function returns level *changes* only. Settling
 * resources before the level change (so production/upkeep/caps use pre-destruction rates),
 * clamping stored resources to a reduced storage cap, and the build-queue's
 * `min(targetLevel, current + 1)` rule are all the M3c **caller's** job inside its transaction
 * — §7 resolves them, but they are not this function's business.
 *
 * `battle` is deliberately `Pick<BattleResult, 'attacker' | 'attackerPrevailed'>` rather than a
 * bare troop list, mirroring `resolveLoot`'s same deliberate choice: §7's "a defeated attacker
 * never gets a siege pass" is a rule about the *battle*, not about siege arithmetic, and folding
 * `attackerPrevailed` into the input type makes forgetting that check a compile error for the
 * M3c caller instead of a runtime bug waiting to be found.
 *
 * **Order of operations:**
 * 1. A defeated attacker (`attackerPrevailed === false`) gets a complete no-op — identical in
 *    shape to an attacker with no surviving siege units at all: no levels change, no points are
 *    even computed.
 * 2. Points come only from **surviving** siege units (`battle.attacker.survivors`): Σ
 *    `wallDamage` / `buildingDamage`, treating the field as 0 on every non-siege unit (it is
 *    `undefined` there). The attacker's losses contribute nothing.
 * 3. **The wall is always breached first.** While `wallLevel > 0`, wall points knock wall levels
 *    one at a time; anything left over past the point the wall reaches 0 is simply unused by the
 *    wall phase (there is nothing left to knock down).
 * 4. Building points reach `siegeTarget` **only if the wall reaches 0 in this pass** (or was
 *    already at 0 before it). If `siegeTarget === 'wall'`, building points are wasted regardless
 *    of the wall's outcome — that is the attacker's choice (§7), not an error — reported as
 *    entirely discarded. If the wall survives, every building point is likewise discarded.
 * 5. The Command Center floors at `siege.commandCenterFloor` (1); every other building (and the
 *    wall) floors at 0. A settlement can never be destroyed (owner decision 4).
 */
export function resolveSiegePass(
  config: GameConfig,
  battle: Pick<BattleResult, 'attacker' | 'attackerPrevailed'>,
  target: SiegeTargetState,
): SiegeResult {
  const { wallLevel, siegeTarget, targetBuildingLevel } = target;

  // §7: a defeated attacker never gets a siege pass. Complete no-op — no levels change, no
  // points are spent or even tallied, exactly as if no siege units had survived.
  if (!battle.attackerPrevailed) {
    return {
      wallPoints: 0,
      buildingPoints: 0,
      wallLevelBefore: wallLevel,
      wallLevelAfter: wallLevel,
      wallPointsSpent: 0,
      wallPointsDiscarded: 0,
      wallBreached: wallLevel === 0,
      targetLevelBefore: targetBuildingLevel,
      targetLevelAfter: targetBuildingLevel,
      buildingPointsSpent: 0,
      buildingPointsDiscarded: 0,
    };
  }

  // Σ wallDamage / buildingDamage over surviving siege units only — losses contribute nothing,
  // and every non-siege unit's damage fields are undefined, treated as 0.
  let wallPoints = 0;
  let buildingPoints = 0;
  for (const { unitType, count } of battle.attacker.survivors) {
    const unit = config.units[unitType];
    wallPoints += (unit.wallDamage ?? 0) * count;
    buildingPoints += (unit.buildingDamage ?? 0) * count;
  }

  // The wall phase, floor 0: a wall can be breached all the way down.
  const wallOutcome = spendSiegePoints(config, wallPoints, wallLevel, 0);
  const wallBreached = wallOutcome.levelAfter === 0;

  // The building phase is gated on the wall having fallen. `siegeTarget === 'wall'` means the
  // building points were never headed anywhere else — the attacker's own choice (§7) — so they
  // are discarded outright rather than silently applied to a building nobody named.
  const targetsWall = siegeTarget === 'wall';
  const buildingFloor = siegeTarget === 'commandCenter' ? config.siege.commandCenterFloor : 0;

  const buildingOutcome =
    targetsWall || !wallBreached
      ? { levelAfter: targetBuildingLevel, spent: 0, discarded: buildingPoints }
      : spendSiegePoints(config, buildingPoints, targetBuildingLevel, buildingFloor);

  return {
    wallPoints,
    buildingPoints,
    wallLevelBefore: wallLevel,
    wallLevelAfter: wallOutcome.levelAfter,
    wallPointsSpent: wallOutcome.spent,
    wallPointsDiscarded: wallOutcome.discarded,
    wallBreached,
    targetLevelBefore: targetBuildingLevel,
    targetLevelAfter: buildingOutcome.levelAfter,
    buildingPointsSpent: buildingOutcome.spent,
    buildingPointsDiscarded: buildingOutcome.discarded,
  };
}
