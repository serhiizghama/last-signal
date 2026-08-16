import type { BuildingLevels, BuildingType } from '@last-signal/game-core';

import type { SettlementBuildingView, SettlementBuildQueueItemView } from '../api/types';

/** The read-only `{type, level}` shape every `game-core` formula accepts, from the wire view. */
export function toBuildingLevels(buildings: readonly SettlementBuildingView[]): BuildingLevels {
  return buildings.map((b) => ({ type: b.type, level: b.level }));
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
