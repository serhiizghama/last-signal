import type { BuildingLevels, BuildingType, TroopCounts, UnitType } from '@last-signal/game-core';

import type {
  SettlementBuildingView,
  SettlementBuildQueueItemView,
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
