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
  canFactionTrain,
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
  | { kind: 'wrongFaction' }
  | { kind: 'buildingMissing'; building: BuildingType }
  | { kind: 'queueBusy' }
  | { kind: 'wouldStarve' }
  | { kind: 'insufficientResources' };

export interface TrainEligibility {
  /** The unit type this eligibility describes. `undefined` only when the account has no faction yet — see `computeTrainEligibility`'s own comment on why that case has no unit to name. */
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
 * Whether — and why not — a training order of `count` `unitType` can be started right now.
 * The general form behind the Units tab's roster (M3e.2, §17): mirrors `SettlementsService.
 * trainUnits`'s own validation order for the checks that make sense client-side — faction lock
 * (`canFactionTrain`, covering the server's own checks 2+3: no faction chosen, or this unit
 * belongs to someone else's), the training building present, one order at a time *at that
 * building*, the whole-batch Food gate, then affordability against the live resource values —
 * see that method's own comment. The unit-type/count *shape* checks the server also runs
 * (`errors.training.unknownType` / `invalidCount`) are skipped here: every caller in this app
 * only ever offers a real `UnitType` already filtered to what the building trains (`
 * unitsTrainableAt` on the Units tab, `scoutUnitForFaction` on the Barracks card) and a count
 * the count-picker already keeps at `>= 1`, so there is nothing left for the player to get
 * wrong before submitting.
 */
export function computeUnitTrainEligibility(
  config: GameConfig,
  unitType: UnitType,
  buildings: BuildingLevels,
  trainingQueue: ReadonlyArray<{ unitType: string }>,
  troops: TroopCounts,
  liveValues: Resources,
  faction: Faction | undefined,
  count: number,
): TrainEligibility {
  const cost = calcTrainCost(config, unitType, count);
  // Derived rather than hardcoded so this stays correct if the catalogue ever changes, and so
  // it reads exactly like the server's own check 5 (`this.config.units[unitType].trainedIn`).
  const building = config.units[unitType].trainedIn as BuildingType;
  const buildingLevel = levelOf(buildings, building);

  // `calcTrainTimeMs`/`calcTrainBatchTimeMs` take the training building's level and throw
  // below level 1, and a missing building means that level is legitimately 0 here — so the
  // time formulas can't be called with `buildingLevel` directly in the missing-building case.
  // A player without the building still needs to see what training will cost them once they
  // build it, and a freshly-built building *is* level 1 — so previewing at
  // `Math.max(1, buildingLevel)` shows the real number the player will get, not a placeholder.
  const previewLevel = Math.max(1, buildingLevel);
  const unitTimeMs = calcTrainTimeMs(config, unitType, previewLevel);
  const batchTimeMs = calcTrainBatchTimeMs(config, unitType, count, previewLevel);

  if (!faction) {
    return {
      unitType,
      cost,
      unitTimeMs,
      batchTimeMs,
      canStart: false,
      block: { kind: 'noFaction' },
    };
  }

  // Mirrors the server's check 3 (`canFactionTrain`): true unless `unitType` belongs to
  // another faction. The Units tab never renders a unit this would reject — its roster is
  // already filtered to the caller's own faction plus the faction-neutral Settler
  // (`unitsTrainableAt`) — but the check stays here rather than being assumed away, so this
  // function agrees with the server for every input, not just the ones this app happens to
  // construct today.
  if (!canFactionTrain(config, unitType, faction)) {
    return {
      unitType,
      cost,
      unitTimeMs,
      batchTimeMs,
      canStart: false,
      block: { kind: 'wrongFaction' },
    };
  }

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

/**
 * The Barracks card's own scout-only eligibility (`TrainingSection`, unchanged since M3a.5):
 * resolves the caller's faction scout and delegates to `computeUnitTrainEligibility` above.
 * Kept as its own function (rather than inlining `scoutUnitForFaction` at every call site)
 * because it alone has a real "no unit to preview at all" case: unlike a building the player
 * merely hasn't built yet, an account with no faction has no scout to look up in the first
 * place, so this is the one branch `computeUnitTrainEligibility` cannot express — it always
 * takes a concrete `unitType`.
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
  return computeUnitTrainEligibility(
    config,
    unitType,
    buildings,
    trainingQueue,
    troops,
    liveValues,
    faction,
    count,
  );
}
