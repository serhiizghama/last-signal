import type {
  BuildingLevels,
  Faction,
  GameConfig,
  Resources,
  TroopCounts,
  UnitType,
} from '@last-signal/game-core';
import {
  calcTrainBatchTimeMs,
  calcTrainCost,
  calcTrainTimeMs,
  canAfford,
  emptyResources,
  scoutUnitForFaction,
  wouldStarveWithTroops,
} from '@last-signal/game-core';

import { levelOf } from './settlementSelectors';

/**
 * Mirrors the server's `MAX_ACTIVE_TRAINING_ORDERS`
 * (`apps/server/src/settlements/settlements.constants.ts`) — one active training order per
 * settlement at a time (§7, orchestrator decision 1). Not importable across the app boundary
 * (`apps/web` must not depend on `apps/server`); same documented duplication as
 * `BUILD_QUEUE_CAPACITY` in `constants.ts`.
 */
const MAX_ACTIVE_TRAINING_ORDERS = 1;

export type TrainBlockReason =
  | { kind: 'noFaction' }
  | { kind: 'noBarracks' }
  | { kind: 'queueBusy' }
  | { kind: 'wouldStarve' }
  | { kind: 'insufficientResources' };

export interface TrainEligibility {
  /** The caller's own faction scout — every faction has exactly one (§7). `undefined` only when the account has no faction yet. */
  unitType: UnitType | undefined;
  /** Cost of training `count` units of `unitType`; zero-valued (and not meaningful) when `unitType` is `undefined`. */
  cost: Resources;
  /** Time to train a single unit. */
  unitTimeMs: number;
  /** Time to train the whole `count`-unit batch. */
  batchTimeMs: number;
  canStart: boolean;
  block: TrainBlockReason | undefined;
}

/**
 * Whether — and why not — a training order of `count` scouts can be started right now. Mirrors
 * `SettlementsService.trainScouts`'s own validation order for the checks that make sense
 * client-side (faction, Barracks present, one order at a time, the whole-batch Food gate, then
 * affordability against the live resource values — see that method's own comment). The
 * unit-type/count *shape* checks the server also runs (`errors.training.unknownType` /
 * `invalidCount`) are skipped here: unlike the free-form building-type picker, this UI only
 * ever sends the caller's own faction scout and a count the count-picker already keeps at
 * `>= 1`, so there is nothing left for the player to get wrong before submitting.
 */
export function computeTrainEligibility(
  config: GameConfig,
  buildings: BuildingLevels,
  trainingQueueLength: number,
  troops: TroopCounts,
  liveValues: Resources,
  faction: Faction | undefined,
  count: number,
): TrainEligibility {
  if (!faction) {
    return {
      unitType: undefined,
      cost: emptyResources(),
      unitTimeMs: 0,
      batchTimeMs: 0,
      canStart: false,
      block: { kind: 'noFaction' },
    };
  }

  const unitType = scoutUnitForFaction(config, faction).type;
  const cost = calcTrainCost(config, unitType, count);
  const unitTimeMs = calcTrainTimeMs(config, unitType);
  const batchTimeMs = calcTrainBatchTimeMs(config, unitType, count);

  if (levelOf(buildings, 'barracks') < 1) {
    return {
      unitType,
      cost,
      unitTimeMs,
      batchTimeMs,
      canStart: false,
      block: { kind: 'noBarracks' },
    };
  }

  if (trainingQueueLength >= MAX_ACTIVE_TRAINING_ORDERS) {
    return {
      unitType,
      cost,
      unitTimeMs,
      batchTimeMs,
      canStart: false,
      block: { kind: 'queueBusy' },
    };
  }

  if (wouldStarveWithTroops(config, buildings, troops, [{ unitType, count }])) {
    return {
      unitType,
      cost,
      unitTimeMs,
      batchTimeMs,
      canStart: false,
      block: { kind: 'wouldStarve' },
    };
  }

  if (!canAfford(liveValues, cost)) {
    return {
      unitType,
      cost,
      unitTimeMs,
      batchTimeMs,
      canStart: false,
      block: { kind: 'insufficientResources' },
    };
  }

  return { unitType, cost, unitTimeMs, batchTimeMs, canStart: true, block: undefined };
}
