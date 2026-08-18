import type { BuildingLevels, GameConfig, UnitDef, UnitType } from '../config/types.js';
import { UNIT_TYPES } from '../config/types.js';
import { calcNetFoodPerHour } from '../formulas/buildings.js';
import { unionTroops, type TroopCounts } from './troops.js';

/** One stationed (foreign, hosted-as-support) contingent subject to starvation (M3 §3, §4). */
export interface StarvationContingent {
  /** Opaque, caller-supplied stable identifier for one stationed contingent. */
  key: string;
  troops: TroopCounts;
}

export interface StarvationInput {
  buildings: BuildingLevels;
  troops: TroopCounts;
  /**
   * Own units currently in transit (M3 §3). Still fed into the Food-upkeep union below — a
   * marching army pays its own rations, and that is untouched (M3a.4's exploit fix: sending an
   * army away must not zero out its upkeep). **Never a kill target**, though (owner decision
   * 2026-08-17, amending §4).
   *
   * M3a's live acceptance run found a defect: units starved out of `awayTroops` were
   * *resurrected* when their movement resolved, because the movement document still listed the
   * full count it departed with, and nothing kept `awayTroops` — a denormalized counter — in
   * sync with a kill that happened to it mid-flight. Closing that properly needs a write from
   * this function into every outbound movement document, which breaks the single-document
   * purity §3 relies on for the whole lazy-resource model. The owner chose the simpler trade
   * instead: in-transit troops carry their own rations and can no longer die of starvation at
   * all — a marching army is immortal to starvation, so a starving settlement's home garrison
   * and its guests die in its place. Accepted knowingly: a player can dodge starvation deaths by
   * keeping units perpetually in transit, at the cost of never using them for anything else.
   *
   * Consequence, not a bug: because `awayTroops` upkeep still counts toward the deficit but
   * `awayTroops` itself can never be killed to close it, `resolved: false` is now reachable
   * whenever the deficit is driven by in-transit upkeep (or by buildings, which never starve,
   * §4) — killing every killable `troops`/`stationed` unit may still leave net Food negative.
   * `resolveStarvation` handles this exactly as it already handles the buildings-only case: one
   * forward pass over a fixed, finite target list, then `resolved: false`. It cannot spin.
   */
  awayTroops: TroopCounts;
  stationed: readonly StarvationContingent[];
}

export interface StarvationResult {
  killed: { troops: TroopCounts; stationed: StarvationContingent[] };
  remaining: { troops: TroopCounts; stationed: StarvationContingent[] };
  netFoodPerHourAfter: number;
  /** True when net Food reached >= 0; false when every killable troop died and it is still negative. */
  resolved: boolean;
}

/** A troop list's counts, keyed by unit type, for cheap in-place bookkeeping during a resolve pass. */
type CountMap = Map<UnitType, number>;

function toCountMap(list: TroopCounts): CountMap {
  const map: CountMap = new Map();
  for (const { unitType, count } of list) {
    map.set(unitType, (map.get(unitType) ?? 0) + count);
  }
  return map;
}

/** Inverse of `toCountMap`: catalogue order, zero-count entries dropped — same shape `unionTroops` returns. */
function fromCountMap(map: CountMap): TroopCounts {
  const result: Array<{ unitType: UnitType; count: number }> = [];
  for (const unitType of UNIT_TYPES) {
    const count = map.get(unitType) ?? 0;
    if (count > 0) {
      result.push({ unitType, count });
    }
  }
  return result;
}

/** Ascending plain-string comparison, the deterministic backstop used at two levels here. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Total training cost of one unit — starvation's tie-break, never anything else (§4). */
function totalTrainCost(config: GameConfig, unitType: UnitType): number {
  const { scrap, fuel, electronics, food } = config.units[unitType].cost;
  return scrap + fuel + electronics + food;
}

/**
 * "Dies-last rank" (owner decision 2026-08-17, amending §4): settlers rank above siege, which
 * ranks above everything else, regardless of stats. Settlers were already exempt by their own
 * special case — a 2500-resource investment (900 scrap + 700 fuel + 400 electronics + 500
 * food) with 80/80 defence, losing them to a Food dip would be brutal (§4). The owner extended
 * the same reasoning to siege once M3a's roster landed: siege is deliberately built with poor
 * defensive stats (it is not meant to defend), so the plain combat-weight sum starved a Rail
 * Sling — at 790 resources the most expensive unit after the Settler — before every cavalry
 * unit and before infantry costing a quarter as much. That is the same "large investment lost
 * to a Food dip" problem the Settler case was written for, so it gets the same fix: a rank
 * checked before combat weight, not a tweak to the weight itself (which would also change
 * *battle* strength ordering — no such thing here, but the shared formula is the point).
 */
function diesLastRank(role: UnitDef['role']): number {
  if (role === 'settler') {
    return 2;
  }
  if (role === 'siege') {
    return 1;
  }
  return 0;
}

/**
 * Comparator backing `starvationOrder` (§4): dies-last rank first (settlers above siege above
 * everything else — see `diesLastRank`), then ascending combat weight
 * (`attack + defInfantry + defCavalry`), then ascending total training cost, then ascending
 * unit type id as the final deterministic backstop so the order can never depend on catalogue
 * declaration order or `Object.keys`.
 */
function compareStarvationOrder(config: GameConfig, a: UnitType, b: UnitType): number {
  const defA = config.units[a];
  const defB = config.units[b];
  const rankA = diesLastRank(defA.role);
  const rankB = diesLastRank(defB.role);
  if (rankA !== rankB) {
    return rankA - rankB;
  }
  const weightA = defA.attack + defA.defInfantry + defA.defCavalry;
  const weightB = defB.attack + defB.defInfantry + defB.defCavalry;
  if (weightA !== weightB) {
    return weightA - weightB;
  }
  const costA = totalTrainCost(config, a);
  const costB = totalTrainCost(config, b);
  if (costA !== costB) {
    return costA - costB;
  }
  return compareStrings(a, b);
}

/**
 * Every unit type, ordered weakest-dies-first for starvation (M3 §4), per
 * `compareStarvationOrder`. Includes the two wildlife types even though they can never appear
 * in a settlement's troop lists — wildlife only ever hold an oasis and are never trained,
 * moved, or stationed (see `catalogue.ts`'s `feralDog`/`scavengerGang` comments) — because
 * returning a total order over `UNIT_TYPES` keeps this function total and usable as a
 * comparator anywhere, rather than a partial one that needs a special case at every call site.
 */
export function starvationOrder(config: GameConfig): UnitType[] {
  return [...UNIT_TYPES].sort((a, b) => compareStarvationOrder(config, a, b));
}

/** Zero-troops shape for one contingent, used for both the "nothing killed" and "resolved: false" fallouts. */
function emptyContingent(key: string): StarvationContingent {
  return { key, troops: [] };
}

/**
 * Kills troops on a starving settlement (M3 §4): while net Food is negative, removes units —
 * weakest first (`starvationOrder`), `stationedTroops` first, then `troops` — until net Food
 * reaches >= 0 or nothing killable is left. `awayTroops` still count toward the deficit (they
 * are part of `unionOfAll` below) but are never a target — see `StarvationInput.awayTroops`'s
 * doc comment for why (owner decision 2026-08-17, amending §4).
 *
 * Implementation note: the priority order (scope, then unit type, then — within `stationed` —
 * ascending contingent `key`) is entirely determined up front from `config` and the input
 * shape, not from anything that changes as units die. So this builds ONE fixed, ordered list
 * of "targets" (an ordered pool of undifferentiated troops belonging to one settlement's
 * stationed/troops slice, of a single unit type) and visits each exactly once, killing
 * `min(available, ceil(deficit / upkeepPerUnit))` from it in a single step and re-checking net
 * Food before moving to the next target. That is the "batch, don't loop per unit" shape the
 * perf budget needs (a settlement's army is at most a few thousand units, but looping
 * one-at-a-time over 5 000 units for an hourly tick is still wasteful cleverness this function
 * doesn't need) — and because the target list is fixed and finite (at most `UNIT_TYPES.length *
 * (1 + contingent count)` entries) and every target is visited exactly once, a single forward
 * pass can never spin: a unit type with `foodUpkeepPerHour === 0` (never true for a real troop
 * today, but a config retune could make it true) simply frees nothing and is skipped, and if net
 * Food is still negative once every target has been visited once, that IS "a full pass freed no
 * more Food" — the loop has nothing left to try, so it stops and reports `resolved: false`
 * rather than needing a separate no-progress check. This is also exactly what makes `awayTroops`
 * being unkillable safe rather than a spin risk: it is simply absent from `targets`, so the pass
 * still terminates after the same fixed, finite walk.
 *
 * `stationed`'s tie-break is ascending `key`, not array position (§4): array order is an
 * accident of how the caller assembled the settlement document and can differ between two
 * replays of the same event (every handler in this codebase must be idempotent — a scheduler
 * can hand the same starvation tick to a handler twice), so this function's output must not
 * depend on it. To make that guarantee easy to rely on, `killed.stationed` and
 * `remaining.stationed` are both returned sorted by ascending `key` too, regardless of the
 * order `input.stationed` arrived in.
 */
export function resolveStarvation(config: GameConfig, input: StarvationInput): StarvationResult {
  const { buildings, troops, awayTroops, stationed } = input;

  const homeCounts = toCountMap(troops);
  // One entry per contingent, carrying its live counts AND its killed-so-far counts together —
  // avoids ever needing to re-look-up "the killed map for this contingent" by key or index.
  const stationedState = [...stationed]
    .map((c) => ({ key: c.key, counts: toCountMap(c.troops), killed: new Map() as CountMap }))
    .sort((a, b) => compareStrings(a.key, b.key));
  const killedHome: CountMap = new Map();

  // `awayTroops` feeds the upkeep union (it must still raise the deficit, per M3a.4) but is
  // never rebuilt into a `CountMap` target — passing the input list straight through is the
  // simplest proof that this function never mutates or kills it.
  const unionOfAll = (): TroopCounts =>
    unionTroops(
      fromCountMap(homeCounts),
      awayTroops,
      ...stationedState.map((s) => fromCountMap(s.counts)),
    );

  let netFood = calcNetFoodPerHour(config, buildings, unionOfAll());

  if (netFood >= 0) {
    return {
      killed: {
        troops: [],
        stationed: stationedState.map((s) => emptyContingent(s.key)),
      },
      remaining: {
        troops: fromCountMap(homeCounts),
        stationed: stationedState.map((s) => ({ key: s.key, troops: fromCountMap(s.counts) })),
      },
      netFoodPerHourAfter: netFood,
      resolved: true,
    };
  }

  const order = starvationOrder(config);

  // The fixed, ordered target list described in the doc comment above: stationed (by unit
  // type, then by contingent key) exhausted before troops. `awayTroops` is deliberately absent.
  const targets: Array<{ unitType: UnitType; counts: CountMap; killed: CountMap }> = [];
  for (const unitType of order) {
    for (const contingent of stationedState) {
      targets.push({ unitType, counts: contingent.counts, killed: contingent.killed });
    }
  }
  for (const unitType of order) {
    targets.push({ unitType, counts: homeCounts, killed: killedHome });
  }

  for (const target of targets) {
    if (netFood >= 0) {
      break;
    }
    const available = target.counts.get(target.unitType) ?? 0;
    const upkeepPerUnit = config.units[target.unitType].foodUpkeepPerHour;
    if (available <= 0 || upkeepPerUnit <= 0) {
      continue;
    }
    const deficit = -netFood;
    const toKill = Math.min(available, Math.ceil(deficit / upkeepPerUnit));
    target.counts.set(target.unitType, available - toKill);
    target.killed.set(target.unitType, (target.killed.get(target.unitType) ?? 0) + toKill);
    netFood += toKill * upkeepPerUnit;
  }

  return {
    killed: {
      troops: fromCountMap(killedHome),
      stationed: stationedState.map((s) => ({ key: s.key, troops: fromCountMap(s.killed) })),
    },
    remaining: {
      troops: fromCountMap(homeCounts),
      stationed: stationedState.map((s) => ({ key: s.key, troops: fromCountMap(s.counts) })),
    },
    netFoodPerHourAfter: netFood,
    resolved: netFood >= 0,
  };
}
