import type {
  BuildingLevels,
  BuildingType,
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
 * Mirrors the server's `MAX_ACTIVE_ORDERS_PER_BUILDING`
 * (`apps/server/src/settlements/settlements.constants.ts`) — one active training order *per
 * training building* (M3 §2, widened from M2b.2's per-settlement cap). Not importable across
 * the app boundary (`apps/web` must not depend on `apps/server`); same documented duplication
 * as `BUILD_QUEUE_CAPACITY` in `constants.ts`.
 */
const MAX_ACTIVE_ORDERS_PER_BUILDING = 1;

export type TrainBlockReason =
  | { kind: 'noFaction' }
  | { kind: 'buildingMissing'; building: BuildingType }
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
 * `SettlementsService.trainUnits`'s own validation order for the checks that make sense
 * client-side (faction, the training building present, one order at a time *at that
 * building*, the whole-batch Food gate, then affordability against the live resource values —
 * see that method's own comment). The unit-type/count *shape* checks the server also runs
 * (`errors.training.unknownType` / `invalidCount`) are skipped here: unlike the free-form
 * building-type picker, this UI only ever sends the caller's own faction scout and a count the
 * count-picker already keeps at `>= 1`, so there is nothing left for the player to get wrong
 * before submitting.
 *
 * Deliberately still scout-only (M3e boundary, not an oversight): the server's `trainUnits`
 * already accepts the whole roster, but the Barracks card only ever offers its faction's own
 * scout until the full Units tab ships — see `TrainingSection`'s own comment.
 */
export function computeTrainEligibility(
  config: GameConfig,
  buildings: BuildingLevels,
  trainingQueue: ReadonlyArray<{ unitType: string }>,
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
  // Every scout trains at the Barracks (`UnitDef.trainedIn`) — derived rather than hardcoded
  // so this stays correct if that ever changes, and so it reads exactly like the server's own
  // check 5 (`this.config.units[unitType].trainedIn`).
  const building = config.units[unitType].trainedIn as BuildingType;
  const buildingLevel = levelOf(buildings, building);

  // `calcTrainTimeMs`/`calcTrainBatchTimeMs` now take the training building's level and
  // throw below level 1, and a missing building means that level is legitimately 0 here — so
  // the time formulas can't be called with `buildingLevel` directly in the missing-building
  // case. But zeroing the preview (the `noFaction` branch's convention) is wrong for this
  // branch: unlike "no faction", where there is no unit to preview at all, a player without
  // the building still needs to see what training will cost them once they build it, and a
  // freshly-built building *is* level 1 — so previewing at `Math.max(1, buildingLevel)` shows
  // the real number the player will get, not a placeholder. It also means this line changes
  // nothing about the numbers shown pre-M3a.2: `0.91 ** 0 === 1`, so level 1 reproduces the
  // old (pre-building-level) time byte for byte.
  const previewLevel = Math.max(1, buildingLevel);
  const unitTimeMs = calcTrainTimeMs(config, unitType, previewLevel);
  const batchTimeMs = calcTrainBatchTimeMs(config, unitType, count, previewLevel);

  if (buildingLevel < 1) {
    return {
      unitType,
      cost,
      unitTimeMs,
      batchTimeMs,
      canStart: false,
      block: { kind: 'buildingMissing', building },
    };
  }

  // Per-building queue cap (M3 §2): only orders training *at this same building* count
  // against it, otherwise a legitimately-parallel order at another training building would
  // wrongly grey this one out. Mirrors the server's own check 7
  // (`config.units[item.unitType].trainedIn === building`).
  const ordersAtThisBuilding = trainingQueue.filter(
    (item) => config.units[item.unitType as UnitType].trainedIn === building,
  ).length;
  if (ordersAtThisBuilding >= MAX_ACTIVE_ORDERS_PER_BUILDING) {
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
