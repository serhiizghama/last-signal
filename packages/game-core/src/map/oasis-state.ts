import type { GameConfig, UnitType } from '../config/types.js';
import { HOUR_MS } from '../economy/resources.js';
import type { TroopCounts } from '../units/index.js';
import { hashStringToUint32, mulberry32 } from './rng.js';

/**
 * The wildlife garrison one oasis regenerates toward, fixed for the whole round (§10): a
 * deterministic function of the world seed and the oasis coordinates, via the same FNV-1a +
 * mulberry32 pair `terrainAt`/`generateOases` already use — never `Math.random()`, never the
 * clock, so two nodes deriving the same `(seed, x, y)` always agree.
 *
 * One stream is seeded from `${seed}:oasis:${x}:${y}` and takes two successive draws: **Feral
 * Dogs first, then Scavenger Gangs** — the same order as the §10 table and `UNIT_TYPES`'s
 * catalogue order. That draw order is part of the contract: swapping it would silently reroll
 * the garrison of every oasis in an already-generated world.
 */
export function oasisTargetDefenders(
  config: GameConfig,
  seed: string,
  x: number,
  y: number,
): TroopCounts {
  const draw = mulberry32(hashStringToUint32(`${seed}:oasis:${x}:${y}`));
  const feralDogRoll = draw();
  const scavengerGangRoll = draw();

  const { feralDog, scavengerGang } = config.oasis.defenders;
  const feralDogCount = feralDog.base + Math.floor(feralDogRoll * feralDog.rollRange);
  const scavengerGangCount =
    scavengerGang.base + Math.floor(scavengerGangRoll * scavengerGang.rollRange);

  const result: Array<{ unitType: UnitType; count: number }> = [];
  if (feralDogCount > 0) {
    result.push({ unitType: 'feralDog', count: feralDogCount });
  }
  if (scavengerGangCount > 0) {
    result.push({ unitType: 'scavengerGang', count: scavengerGangCount });
  }
  return result;
}

/**
 * An oasis's live, persisted state (§10): the wildlife garrison actually present, the lootable
 * Food pool, and the two regen timestamps below. `lastRegenAt === null` (equivalently
 * `lastDefenderRegenAt === null` — they are only ever both null or both set) means "never
 * settled since world generation": `settleOasis` reads that as licence to materialise the oasis
 * at its full target composition with an empty pool, so world generation can write nothing but
 * coordinates and the oasis comes alive on first contact.
 */
export interface OasisLiveState {
  defenders: TroopCounts;
  /** The lootable Food pool. */
  food: number;
  /** When `food` was last accrued to. `null` on an oasis never touched since world generation. */
  lastRegenAt: number | null;
  /** When the last WHOLE defender interval was credited. `null` likewise. */
  lastDefenderRegenAt: number | null;
}

/**
 * Settles one oasis's live state forward to `now` (§10) — the same lazy pattern
 * `settleResources` already uses for settlements: no background tick, any command or handler
 * that touches an oasis calls this first.
 *
 * **Why two timestamps, not one (the one design call this module makes; §10 names only
 * `lastRegenAt` in its field list).** Food is continuous, so `lastRegenAt` can simply advance
 * all the way to `now` on every settle, exactly like `SettlementResources.lastCalcAt` — there is
 * no such thing as a "partial" Food tick. Defenders are discrete: they grow one unit per WHOLE
 * `defenderIntervalMs`, so a timestamp that advanced all the way to `now` would silently discard
 * whatever fraction of the current interval had already elapsed, and an oasis settled every few
 * minutes by passing scouts would then regenerate its garrison *never* — every settle would see
 * `elapsed < interval` and credit nothing, forever. One shared timestamp cannot advance fully
 * (what continuous Food accrual needs) and only by whole steps (what discrete defender regen
 * needs) at the same time, so `lastDefenderRegenAt` exists purely to give the discrete mechanic
 * its own clock: it advances only by `floor(elapsed / interval) * interval`, banking the
 * remainder for the next settle. This is what makes the identity below hold.
 *
 * **Consequence, chosen and applied uniformly rather than special-cased:** when defenders are
 * already at target there is no remainder left to matter (further growth is capped at 0 either
 * way), so this function does not special-case "at target -> stamp to `now`" — it always applies
 * the same remainder-preserving formula. Simpler, and behaviourally identical for defender
 * counts either way; only the exact stored timestamp value would differ, and nothing reads it
 * for any other purpose.
 *
 * **Purity and the remainder-preservation property (tested explicitly):** never mutates `state`;
 * `settleOasis(c, seed, x, y, settleOasis(c, seed, x, y, s, t1), t2)` equals
 * `settleOasis(c, seed, x, y, s, t2)` on the defender count, for any `t1 < t2` — the whole reason
 * `lastDefenderRegenAt` exists rather than reusing `lastRegenAt`.
 *
 * **Clock skew:** `now` at or before a stored timestamp is a no-op for that timestamp's own
 * mechanic (never a negative accrual) — mirrors `settleResources`'s `elapsedMs <= 0` handling:
 * the value is carried through unchanged and the timestamp is simply set to `now`. The two
 * timestamps are checked independently, since `lastDefenderRegenAt` normally lags behind
 * `lastRegenAt` (it only advances in whole-interval jumps) and a `now` that is stale for one can
 * still be fresh for the other.
 */
export function settleOasis(
  config: GameConfig,
  seed: string,
  x: number,
  y: number,
  state: OasisLiveState,
  now: number,
): OasisLiveState {
  const target = oasisTargetDefenders(config, seed, x, y);

  // Never touched since world generation: materialise at the full target composition with an
  // empty pool, both timestamps stamped to `now`. This is what lets the world generator write
  // nothing but coordinates.
  if (state.lastRegenAt === null || state.lastDefenderRegenAt === null) {
    return { defenders: target, food: 0, lastRegenAt: now, lastDefenderRegenAt: now };
  }

  const { food, lastRegenAt } = settleOasisFood(config, state, now);
  const { defenders, lastDefenderRegenAt } = settleOasisDefenders(config, target, state, now);

  return { defenders, food, lastRegenAt, lastDefenderRegenAt };
}

/** The Food half of `settleOasis`: continuous accrual, capped, never negative (§10). */
function settleOasisFood(
  config: GameConfig,
  state: OasisLiveState,
  now: number,
): { food: number; lastRegenAt: number } {
  const elapsedMs = now - (state.lastRegenAt as number);
  if (elapsedMs <= 0) {
    return { food: state.food, lastRegenAt: now };
  }
  const cap = config.oasis.regen.foodCap;
  const grown = state.food + (config.oasis.regen.foodPerHour * elapsedMs) / HOUR_MS;
  // Mirrors settleResources: never confiscate a pool already above the cap (a possible config
  // retune), just stop growing it further.
  return { food: Math.min(grown, Math.max(cap, state.food)), lastRegenAt: now };
}

/**
 * The defenders half of `settleOasis`: discrete, whole-interval growth toward `target`, with the
 * remainder-preserving timestamp discipline documented on `settleOasis` itself.
 */
function settleOasisDefenders(
  config: GameConfig,
  target: TroopCounts,
  state: OasisLiveState,
  now: number,
): { defenders: TroopCounts; lastDefenderRegenAt: number } {
  const interval = config.oasis.regen.defenderIntervalMs;
  const elapsedMs = now - (state.lastDefenderRegenAt as number);
  if (elapsedMs <= 0) {
    return { defenders: [...state.defenders], lastDefenderRegenAt: now };
  }

  const wholeIntervals = Math.floor(elapsedMs / interval);
  // Advance only by the whole intervals actually credited — never all the way to `now` — so the
  // sub-interval remainder survives for the next settle call. See the module doc comment.
  const lastDefenderRegenAt = (state.lastDefenderRegenAt as number) + wholeIntervals * interval;

  if (wholeIntervals <= 0) {
    return { defenders: [...state.defenders], lastDefenderRegenAt };
  }

  const currentByType = new Map(state.defenders.map(({ unitType, count }) => [unitType, count]));
  const defenders: Array<{ unitType: UnitType; count: number }> = [];
  for (const { unitType, count: targetCount } of target) {
    const current = currentByType.get(unitType) ?? 0;
    const grown = Math.min(targetCount, current + wholeIntervals);
    if (grown > 0) {
      defenders.push({ unitType, count: grown });
    }
  }

  return { defenders, lastDefenderRegenAt };
}
