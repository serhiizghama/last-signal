import type {
  BuildingLevels,
  BuildingRequirement,
  BuildingType,
  GameConfig,
  Resources,
} from '@last-signal/game-core';
import {
  RESOURCE_KINDS,
  calcBuildCost,
  calcBuildTimeMs,
  calcStorageCaps,
  canAfford,
  emptyResources,
  missingPrerequisites,
  msUntilAffordable,
  wouldStarveSettlement,
} from '@last-signal/game-core';

import type { SettlementBuildQueueItemView } from '../api/types';
import { BUILD_QUEUE_CAPACITY } from './constants';
import { levelOf, nextTargetLevel } from './settlementSelectors';

export type BuildBlockReason =
  | { kind: 'maxLevel' }
  | { kind: 'prerequisites'; missing: readonly BuildingRequirement[] }
  | { kind: 'queueFull' }
  | { kind: 'wouldStarve' }
  | { kind: 'exceedsStorage' }
  | { kind: 'neverAffordable' }
  | { kind: 'waiting'; waitMs: number };

export interface BuildEligibility {
  type: BuildingType;
  currentLevel: number;
  targetLevel: number;
  atMaxLevel: boolean;
  /** Cost of `targetLevel`; only meaningful when `atMaxLevel` is false. */
  cost: Resources;
  /** Only meaningful when `canStart` is true. */
  buildTimeMs: number;
  canStart: boolean;
  block: BuildBlockReason | undefined;
}

/**
 * Whether — and why not — a new build of `type` can be started right now. Every number here
 * comes straight from a `game-core` formula; this function only orders the checks, mirroring
 * `SettlementsService.startBuild`'s own validation order (max level, prerequisites, queue
 * capacity, the Food gate, storage, then affordability) so the client never disables a
 * building for a different reason than the server would reject it for.
 */
export function computeBuildEligibility(
  config: GameConfig,
  buildings: BuildingLevels,
  buildQueue: readonly SettlementBuildQueueItemView[],
  liveValues: Resources,
  now: number,
  type: BuildingType,
): BuildEligibility {
  const currentLevel = levelOf(buildings, type);
  const targetLevel = nextTargetLevel(buildings, buildQueue, type);
  const maxLevel = config.buildings[type].maxLevel;
  const atMaxLevel = targetLevel > maxLevel;

  if (atMaxLevel) {
    return {
      type,
      currentLevel,
      targetLevel,
      atMaxLevel,
      cost: emptyResources(),
      buildTimeMs: 0,
      canStart: false,
      block: { kind: 'maxLevel' },
    };
  }

  const cost = calcBuildCost(config, type, targetLevel);

  const missing = missingPrerequisites(config, buildings, type);
  if (missing.length > 0) {
    return {
      type,
      currentLevel,
      targetLevel,
      atMaxLevel,
      cost,
      buildTimeMs: 0,
      canStart: false,
      block: { kind: 'prerequisites', missing },
    };
  }

  if (buildQueue.length >= BUILD_QUEUE_CAPACITY) {
    return {
      type,
      currentLevel,
      targetLevel,
      atMaxLevel,
      cost,
      buildTimeMs: 0,
      canStart: false,
      block: { kind: 'queueFull' },
    };
  }

  if (wouldStarveSettlement(config, buildings, type, targetLevel)) {
    return {
      type,
      currentLevel,
      targetLevel,
      atMaxLevel,
      cost,
      buildTimeMs: 0,
      canStart: false,
      block: { kind: 'wouldStarve' },
    };
  }

  const caps = calcStorageCaps(config, buildings);
  const exceedsStorage = RESOURCE_KINDS.some((kind) => cost[kind] > caps[kind]);
  if (exceedsStorage) {
    return {
      type,
      currentLevel,
      targetLevel,
      atMaxLevel,
      cost,
      buildTimeMs: 0,
      canStart: false,
      block: { kind: 'exceedsStorage' },
    };
  }

  const buildTimeMs = calcBuildTimeMs(
    config,
    type,
    targetLevel,
    levelOf(buildings, 'commandCenter'),
  );

  if (canAfford(liveValues, cost)) {
    return {
      type,
      currentLevel,
      targetLevel,
      atMaxLevel,
      cost,
      buildTimeMs,
      canStart: true,
      block: undefined,
    };
  }

  const waitMs = msUntilAffordable(
    config,
    buildings,
    { values: liveValues, lastCalcAt: now },
    cost,
  );
  if (waitMs === null) {
    return {
      type,
      currentLevel,
      targetLevel,
      atMaxLevel,
      cost,
      buildTimeMs,
      canStart: false,
      block: { kind: 'neverAffordable' },
    };
  }

  return {
    type,
    currentLevel,
    targetLevel,
    atMaxLevel,
    cost,
    buildTimeMs,
    canStart: false,
    block: { kind: 'waiting', waitMs },
  };
}
