import type {
  BuildingLevels,
  GameConfig,
  Resources,
  TroopCounts,
  UnitType,
} from '@last-signal/game-core';
import {
  RESOURCE_KINDS,
  UNIT_TYPES,
  addResources,
  calcStorageCaps,
  emptyResources,
} from '@last-signal/game-core';
import type { ClientSession, Model } from 'mongoose';

import type { GameEventDocument } from '../schemas/event.schema';
import type { MovementDocument } from '../schemas/movement.schema';
import {
  MOVEMENT_TYPE_ASSAULT,
  MOVEMENT_TYPE_RAID,
  MOVEMENT_TYPE_SCOUT,
  MOVEMENT_TYPE_SETTLE,
  MOVEMENT_TYPE_SUPPORT,
} from '../schemas/movement.schema';
import type { EventSchedulerService } from '../scheduler/event-scheduler.service';
import { MOVEMENT_RETURN_EVENT_TYPE } from './movements.constants';

export interface UnitCountEntry {
  unitType: string;
  count: number;
}

// The schema stores `unitType` as a plain `string` (same reason `Settlement.troops[].unitType`
// does — see `isUnitType`'s own comment in `settlements.util.ts`) — this is the one narrowing
// point `MovementsService.sendMovement` funnels every raw unit entry through before it reaches
// any `game-core` formula. Deliberately a local copy rather than importing
// `settlements/settlements.util.ts` — that file is settlements-module-local by the same
// "one small helper, not a cross-module dependency" convention `TrainCommandError`'s comment
// describes for its own mirroring of `BuildCommandError`.
export function isUnitType(value: string): value is UnitType {
  return (UNIT_TYPES as readonly string[]).includes(value);
}

// Sums duplicate `unitType` entries in a raw (client-supplied) unit list — two entries for
// the same type in one `sendMovement` request isn't a meaningful error, just a redundant
// encoding of the same intent.
export function mergeUnitCounts(units: ReadonlyArray<UnitCountEntry>): UnitCountEntry[] {
  const byType = new Map<string, number>();
  for (const { unitType, count } of units) {
    byType.set(unitType, (byType.get(unitType) ?? 0) + count);
  }
  return [...byType.entries()].map(([unitType, count]) => ({ unitType, count }));
}

// The movement types `MovementsService.sendMovement` can actually produce: `scout` (M2,
// unchanged), `raid`, `assault`, `support` (M3c.3), and — as of M3d.1, §9/§13 — `settle`.
// `trade` reached the schema in M3c.2 (`MovementType` was widened for storage) and gained a
// real producer in M3d.3 — but that producer is `MarketService.acceptOffer`
// (`POST /api/market/offers/:id/accept`), never this generic endpoint: a trade movement
// carries `cargo` (a resource bundle) and `merchants` (a count), never `units`, and always
// comes paired with a sibling leg created atomically in the same transaction — a shape this
// single-movement, unit-list-shaped command has no way to express and was never asked to.
// So `trade` stays permanently absent from this list, and a DTO naming it is rejected with
// `errors.movement.unknownType`, same as any other unrecognised string — not because it is
// unimplemented, but because this is deliberately not its entry point. Same array-narrowing
// pattern as `isUnitType` above.
const SENDABLE_MOVEMENT_TYPES = [
  MOVEMENT_TYPE_SCOUT,
  MOVEMENT_TYPE_RAID,
  MOVEMENT_TYPE_ASSAULT,
  MOVEMENT_TYPE_SUPPORT,
  MOVEMENT_TYPE_SETTLE,
] as const;

export type SendableMovementType = (typeof SENDABLE_MOVEMENT_TYPES)[number];

export function isSendableMovementType(value: string): value is SendableMovementType {
  return (SENDABLE_MOVEMENT_TYPES as readonly string[]).includes(value);
}

// Total attack points a merged unit list would bring to a regular battle (§9 step 1,
// `errors.movement.noAttackPower`) — extracted as its own pure function so the rejection can
// be exercised by a direct unit test even though, at the time this was written, no catalogued
// non-scout/wildlife/settler unit in `DEFAULT_CONFIG` actually has `attack: 0` (every
// `offenseInfantry`/`defenseInfantry`/`fast`/`siege` unit does) — see the call site's own
// comment in `movements.service.ts` for why the rejection is otherwise unreachable through
// the real catalogue alone. Silently skips any entry that isn't a real unit type rather than
// throwing: callers run this only after `isUnitType` has already rejected the whole command
// over any unrecognised entry, so by the time this runs every entry is guaranteed real — this
// guard is just what keeps the function honest as a standalone, independently-testable unit.
export function sumAttackPoints(config: GameConfig, units: ReadonlyArray<UnitCountEntry>): number {
  return units.reduce((total, { unitType, count }) => {
    if (!isUnitType(unitType)) {
      return total;
    }
    return total + config.units[unitType].attack * count;
  }, 0);
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

// The §9/§6 "target missing at arrival" turn-around, shared by every per-type arrival
// resolver (`ScoutArrivalResolver`, `BattleArrivalResolver`) — see
// `MovementArrivalResolver.resolveMissingTarget`'s own comment for why each resolver still
// writes its own report first: only the report's shape/`type` differs per movement type, the
// mechanics of turning the whole force around unharmed do not, so this is the one place that
// mechanics is written. No `awayTroops` change (M3a.4, §3): nobody died, every unit is still
// genuinely in transit, so this settlement should keep paying their Food exactly as it
// already is.
export async function turnAroundOutboundMovement(
  movement: MovementDocument,
  event: GameEventDocument,
  eventScheduler: EventSchedulerService,
  movementModel: Model<MovementDocument>,
  session: ClientSession,
): Promise<void> {
  const returnAt = computeReturnAt(movement.departAt, event.dueAt);
  const returnEvent = await eventScheduler.scheduleEvent(
    {
      type: MOVEMENT_RETURN_EVENT_TYPE,
      dueAt: returnAt,
      payload: { movementId: String(movement._id) },
    },
    session,
  );

  const updated = await movementModel.findOneAndUpdate(
    { _id: movement._id, version: movement.version },
    {
      $set: {
        status: 'returning',
        survivors: movement.units.map((u) => ({ unitType: u.unitType, count: u.count })),
        returnAt,
        returnEventId: returnEvent._id,
        version: movement.version + 1,
      },
    },
    { session },
  );
  if (!updated) {
    throw new Error(
      `turnAroundOutboundMovement: version conflict applying movement ${String(movement._id)} ` +
        '(missing target)',
    );
  }
}

export interface ResourceCreditResult {
  /** `currentValues` grown by `amount` and clamped to `buildings`' own storage caps. */
  values: Resources;
  /** How much of `amount`, per resource, actually landed in storage. */
  delivered: Resources;
  /** How much overflowed the cap and was lost — not banked, not retroactively wasted elsewhere. */
  lost: Resources;
}

/**
 * Credits `amount` (all four resources at once) into `currentValues`, clamped to `buildings`'
 * own storage caps — the general, four-resource shape of the "credit then clamp, overflow
 * lost" rule this codebase already applies twice: `MovementReturnHandler` inlined it for a
 * raid/assault's `loot` (M3c.5a, §6/M1 §5), and `market/market.util.ts`'s `computeOfferRefund`
 * (M3d.2) implements the same rule for a single resource (an offer only ever refunds the one
 * resource it named). M3d.3 (§14) needed the identical arithmetic a THIRD time for a trade
 * movement's `cargo` — both delivered to the destination at arrival
 * (`TradeArrivalResolver.resolveArrival`) and, when a leg never delivers (cancelled, or
 * `resolveMissingTarget`'s "destination gone" edge case), refunded home at return
 * (`MovementReturnHandler`) — so this is extracted here rather than written a third time.
 *
 * Deliberately NOT unified with `computeOfferRefund`: that function's whole signature is
 * built around crediting exactly one named resource (an offer's `give` side), and forcing it
 * through a four-resource `Resources` bundle would mean every call site invents a
 * `{...zeroed, [resource]: amount}` object just to satisfy a shape it doesn't need — more
 * ceremony than the three lines of arithmetic it would save. This function lives in
 * `movements/movements.util.ts`, not `market/market.util.ts`, because its first two callers
 * (loot, cargo) are both movement concerns; `computeOfferRefund` stays where it is, for the
 * one concern (an offer's own refund) that is never expressed as a full four-resource bundle.
 *
 * `MovementReturnHandler`'s existing loot block is refactored to call this rather than
 * keeping its own copy — behaviourally identical, since the arithmetic here is copied from it
 * verbatim.
 */
export function creditResourcesClamped(
  config: GameConfig,
  buildings: BuildingLevels,
  currentValues: Resources,
  amount: Resources,
): ResourceCreditResult {
  const caps = calcStorageCaps(config, buildings);
  const grown = addResources(currentValues, amount);
  const values = emptyResources();
  const delivered = emptyResources();
  const lost = emptyResources();
  for (const kind of RESOURCE_KINDS) {
    values[kind] = Math.min(caps[kind], grown[kind]);
    delivered[kind] = Math.max(0, values[kind] - currentValues[kind]);
    lost[kind] = grown[kind] - values[kind];
  }
  return { values, delivered, lost };
}
