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
