import type { Resources, TroopCounts, UnitType } from '@last-signal/game-core';
import { UNIT_TYPES } from '@last-signal/game-core';

export interface UnitCountEntry {
  unitType: string;
  count: number;
}

// The schema stores `unitType` as a plain `string` (same reason `Settlement.troops[].unitType`
// does — see `isUnitType`'s own comment in `settlements.util.ts`) — this is the one narrowing
// point `MovementsService.sendScouts` funnels every raw unit entry through before it reaches
// any `game-core` formula. Deliberately a local copy rather than importing
// `settlements/settlements.util.ts` — that file is settlements-module-local by the same
// "one small helper, not a cross-module dependency" convention `TrainCommandError`'s comment
// describes for its own mirroring of `BuildCommandError`.
export function isUnitType(value: string): value is UnitType {
  return (UNIT_TYPES as readonly string[]).includes(value);
}

// Sums duplicate `unitType` entries in a raw (client-supplied) unit list — two entries for
// the same type in one `sendScouts` request isn't a meaningful error, just a redundant
// encoding of the same intent.
export function mergeUnitCounts(units: ReadonlyArray<UnitCountEntry>): UnitCountEntry[] {
  const byType = new Map<string, number>();
  for (const { unitType, count } of units) {
    byType.set(unitType, (byType.get(unitType) ?? 0) + count);
  }
  return [...byType.entries()].map(([unitType, count]) => ({ unitType, count }));
}

// The per-unit-type shortfall `subtractUnitCounts` reports when `from` didn't hold enough of
// some type to cover `counts` — empty in the normal case. `missing` is how much more than
// `from` held was requested to be removed.
export interface UnitCountShortfall {
  unitType: string;
  missing: number;
}

export interface SubtractUnitCountsResult {
  result: UnitCountEntry[];
  shortfall: UnitCountShortfall[];
}

// Subtracts `counts` from `from`, dropping any entry that lands at exactly zero — the
// inverse of `mergeUnitCounts` above. Feeds `awayTroops` maintenance (M3a.4,
// `docs/M3_DESIGN_DECISIONS.md` §3) in three places: `MovementReturnHandler` (subtract the
// survivors that just came home), and `MovementArriveHandler` (subtract combat losses, and
// separately the whole army on a total wipe). One helper, used everywhere, so the three
// call sites can't quietly diverge on how a subtraction is done.
//
// A subtraction that would take some unit type below zero means `awayTroops` has already
// drifted from what the movement lifecycle actually recorded — a real defect, worth
// reporting loudly. But this function clamps at zero and returns the drift as `shortfall`
// rather than throwing: the units this is subtracting (survivors landing home, or combat
// losses) are *already resolved fact* by the time this runs — the player's army already came
// home or already died — so refusing to apply that and dead-lettering the event instead
// would mean the scheduler retries a handler whose outcome can never change, then gives up,
// leaving `MovementReturnHandler`'s survivors permanently uncredited into `troops`: an army
// that safely returned would simply vanish. A wrong-but-recoverable Food number is a far
// smaller cost than deleting a player's returning army, and this drift is not hypothetical —
// every movement already in flight the moment this step deploys predates `awayTroops`
// entirely (it was `[]` under the pre-M3a.4 code path that deducted `troops` at send but
// never populated `awayTroops`), so its return or arrival legitimately trips this exact case
// once. Callers are expected to log `shortfall` through their own `Logger` (see
// `MovementReturnHandler`/`MovementArriveHandler`) so the drift is diagnosable without
// destroying the write it accompanies.
export function subtractUnitCounts(
  from: ReadonlyArray<UnitCountEntry>,
  counts: ReadonlyArray<UnitCountEntry>,
): SubtractUnitCountsResult {
  const totals = new Map(from.map(({ unitType, count }) => [unitType, count]));
  const shortfall: UnitCountShortfall[] = [];
  for (const { unitType, count } of counts) {
    const available = totals.get(unitType) ?? 0;
    if (count > available) {
      shortfall.push({ unitType, missing: count - available });
    }
    totals.set(unitType, Math.max(0, available - count));
  }
  const result = [...totals.entries()]
    .filter(([, count]) => count > 0)
    .map(([unitType, count]) => ({ unitType, count }));
  return { result, shortfall };
}

// Mongoose subdocuments are not plain objects (see `toPlainQueueItem`'s comment in
// `settlements/build-queue.util.ts` for the general hazard) — this is the same reshape for a
// troop/unit list headed for a `$set` or a report `payload`.
export function toPlainUnitCounts(units: TroopCounts): UnitCountEntry[] {
  return units.map(({ unitType, count }) => ({ unitType, count }));
}

// Same hazard, for a resources subdocument — mirrors `toPlainResources` in
// `settlements/settlements.view.ts` (kept as its own small copy here rather than exported
// cross-module for one caller, same reasoning as `currentLevelOf`'s comment in
// `settlements/settlements.util.ts`).
export function toPlainResourceValues(values: Resources): Resources {
  return {
    scrap: values.scrap,
    fuel: values.fuel,
    electronics: values.electronics,
    food: values.food,
  };
}

// The return trip's arrival time (§6): turning around at `turnAroundAt` (a cancel, or a
// completed arrival) means the army has covered `turnAroundAt - departAt` worth of distance
// at whatever speed got it that far; covering that same distance home, at the same speed,
// takes exactly as long again. Shared by `MovementsService.cancelMovement` and
// `MovementArriveHandler` so the two round-trip-timing rules can never drift apart — for a
// movement that completes its outbound leg on schedule, this lands survivors home at
// `departAt + 2 * (arriveAt - departAt)`, i.e. a symmetric round trip.
export function computeReturnAt(departAt: number, turnAroundAt: number): number {
  return turnAroundAt + (turnAroundAt - departAt);
}
