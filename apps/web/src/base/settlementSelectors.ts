import type { BuildingLevels, BuildingType, TroopCounts, UnitType } from '@last-signal/game-core';
import { unionTroops } from '@last-signal/game-core';

import type {
  SettlementBuildingView,
  SettlementBuildQueueItemView,
  SettlementStateView,
  SettlementTroopView,
} from '../api/types';

/** The read-only `{type, level}` shape every `game-core` formula accepts, from the wire view. */
export function toBuildingLevels(buildings: readonly SettlementBuildingView[]): BuildingLevels {
  return buildings.map((b) => ({ type: b.type, level: b.level }));
}

/**
 * The read-only troop-list shape every `game-core` economy formula accepts (`settleResources`,
 * `msUntilFull`, `wouldStarveSettlement`, `msUntilAffordable`), from the wire view. Mirrors
 * `toBuildingLevels` above and the server's own `toTroopCounts`
 * (`apps/server/src/settlements/settlements.util.ts`) — a pure reshape, not a second
 * validation pass: entries here only ever come from the server's `troops` field, which only
 * ever contains real `UnitType` values.
 */
export function toTroopCounts(troops: readonly SettlementTroopView[]): TroopCounts {
  return troops.map((t) => ({ unitType: t.unitType as UnitType, count: t.count }));
}

/**
 * The union of a settlement's three troop lists — `troops` (home), `awayTroops` (in
 * transit), `stationedTroops` (hosted for an ally) — mirroring the server's own
 * `upkeepTroopsOf` (`apps/server/src/settlements/settlements.util.ts`). Food upkeep is
 * charged on this union, not `troops` alone (M3 §3): `useLiveResources` runs the exact same
 * `settleResources` the server does, locally, against the server clock, so it must feed it
 * the exact same troop set the server would — otherwise a marching or hosted army would make
 * the client's live resource bar visibly disagree with what the server computes a moment
 * later.
 */
export function upkeepTroopsOf(settlement: SettlementStateView): TroopCounts {
  return unionTroops(
    toTroopCounts(settlement.troops),
    toTroopCounts(settlement.awayTroops),
    ...settlement.stationedTroops.map((contingent) => toTroopCounts(contingent.troops)),
  );
}

/** Current level of `type`, or 0 when the settlement hasn't built it yet. */
export function levelOf(buildings: BuildingLevels, type: BuildingType): number {
  const found = buildings.find((b) => b.type === type);
  return found ? found.level : 0;
}

/** How many builds of `type` are already sitting in the queue (active or waiting). */
export function queuedCountForType(
  buildQueue: readonly SettlementBuildQueueItemView[],
  type: BuildingType,
): number {
  return buildQueue.filter((item) => item.type === type).length;
}

/**
 * The level a *new* build of `type` would target. Mirrors
 * `SettlementsService.startBuild`'s own computation server-side (current level, plus
 * however many builds of this type are already queued, plus one) — not a `game-core`
 * formula itself, but the business rule that feeds `calcBuildCost`/`calcBuildTimeMs`, kept
 * identical to the server so the client never shows a cost/time for the wrong level.
 */
export function nextTargetLevel(
  buildings: BuildingLevels,
  buildQueue: readonly SettlementBuildQueueItemView[],
  type: BuildingType,
): number {
  return levelOf(buildings, type) + queuedCountForType(buildQueue, type) + 1;
}
