import type { BuildingLevels, GameConfig, UnitType } from '../config/types.js';
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
  awayTroops: TroopCounts;
  stationed: readonly StarvationContingent[];
}

export interface StarvationResult {
  killed: { troops: TroopCounts; awayTroops: TroopCounts; stationed: StarvationContingent[] };
  remaining: { troops: TroopCounts; awayTroops: TroopCounts; stationed: StarvationContingent[] };
  netFoodPerHourAfter: number;
  /** True when net Food reached >= 0; false when every troop died and it is still negative. */
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
 * Comparator backing `starvationOrder` (§4): settlers sort after every non-settler regardless
 * of stats; otherwise ascending combat weight (`attack + defInfantry + defCavalry`), then
 * ascending total training cost, then ascending unit type id as the final deterministic
 * backstop so the order can never depend on catalogue declaration order or `Object.keys`.
 */
function compareStarvationOrder(config: GameConfig, a: UnitType, b: UnitType): number {
  const defA = config.units[a];
  const defB = config.units[b];
  const settlerA = defA.role === 'settler';
  const settlerB = defB.role === 'settler';
  if (settlerA !== settlerB) {
    return settlerA ? 1 : -1;
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
 * weakest first (`starvationOrder`), `stationedTroops` first, then `awayTroops`, then `troops`
 * — until net Food reaches >= 0 or nothing is left to kill.
 *
 * Implementation note: the priority order (scope, then unit type, then — within `stationed` —
 * ascending contingent `key`) is entirely determined up front from `config` and the input
 * shape, not from anything that changes as units die. So this builds ONE fixed, ordered list
 * of "targets" (an ordered pool of undifferentiated troops belonging to one settlement's
 * troops/awayTroops/stationed slice, of a single unit type) and visits each exactly once,
 * killing `min(available, ceil(deficit / upkeepPerUnit))` from it in a single step and
 * re-checking net Food before moving to the next target. That is the "batch, don't loop per
 * unit" shape the perf budget needs (a settlement's army is at most a few thousand units, but
 * looping one-at-a-time over 5 000 units for an hourly tick is still wasteful cleverness this
 * function doesn't need) — and because the target list is fixed and finite (at most
 * `UNIT_TYPES.length * (1 + contingent count)` entries) and every target is visited exactly
 * once, a single forward pass can never spin: a unit type with `foodUpkeepPerHour === 0` (never
 * true for a real troop today, but a config retune could make it true) simply frees nothing and
 * is skipped, and if net Food is still negative once every target has been visited once, that
 * IS "a full pass freed no more Food" — the loop has nothing left to try, so it stops and
 * reports `resolved: false` rather than needing a separate no-progress check.
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
  const awayCounts = toCountMap(awayTroops);
  // One entry per contingent, carrying its live counts AND its killed-so-far counts together —
  // avoids ever needing to re-look-up "the killed map for this contingent" by key or index.
  const stationedState = [...stationed]
    .map((c) => ({ key: c.key, counts: toCountMap(c.troops), killed: new Map() as CountMap }))
    .sort((a, b) => compareStrings(a.key, b.key));
  const killedHome: CountMap = new Map();
  const killedAway: CountMap = new Map();

  const unionOfAll = (): TroopCounts =>
    unionTroops(
      fromCountMap(homeCounts),
      fromCountMap(awayCounts),
      ...stationedState.map((s) => fromCountMap(s.counts)),
    );

  let netFood = calcNetFoodPerHour(config, buildings, unionOfAll());

  if (netFood >= 0) {
    return {
      killed: {
        troops: [],
        awayTroops: [],
        stationed: stationedState.map((s) => emptyContingent(s.key)),
      },
      remaining: {
        troops: fromCountMap(homeCounts),
        awayTroops: fromCountMap(awayCounts),
        stationed: stationedState.map((s) => ({ key: s.key, troops: fromCountMap(s.counts) })),
      },
      netFoodPerHourAfter: netFood,
      resolved: true,
    };
  }

  const order = starvationOrder(config);

  // The fixed, ordered target list described in the doc comment above: stationed (by unit
  // type, then by contingent key) exhausted before awayTroops, before troops.
  const targets: Array<{ unitType: UnitType; counts: CountMap; killed: CountMap }> = [];
  for (const unitType of order) {
    for (const contingent of stationedState) {
      targets.push({ unitType, counts: contingent.counts, killed: contingent.killed });
    }
  }
  for (const unitType of order) {
    targets.push({ unitType, counts: awayCounts, killed: killedAway });
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
      awayTroops: fromCountMap(killedAway),
      stationed: stationedState.map((s) => ({ key: s.key, troops: fromCountMap(s.killed) })),
    },
    remaining: {
      troops: fromCountMap(homeCounts),
      awayTroops: fromCountMap(awayCounts),
      stationed: stationedState.map((s) => ({ key: s.key, troops: fromCountMap(s.counts) })),
    },
    netFoodPerHourAfter: netFood,
    resolved: netFood >= 0,
  };
}
