import { BUILDINGS } from './buildings.js';
import type { GameConfig } from './types.js';

/**
 * First-pass balance config (§3, §9, §10). All numbers are draft values meant to be tuned by
 * the balance simulator later; formulas always take a `GameConfig` as an injected first
 * argument so sweeping these values never requires editing source.
 */
export const DEFAULT_CONFIG: GameConfig = {
  // Bumped in M1a.4b: storage, electronicsWorkshop.baseCost.scrap and upkeep shape all
  // changed (see below) — past seasons archived under configVersion 1 keep their original
  // numbers.
  configVersion: 2,
  speed: { build: 5, production: 5, training: 5, travel: 2.5 },
  curves: {
    resource: { costRatio: 1.67, timeRatio: 1.35 },
    functional: { costRatio: 1.28, timeRatio: 1.28 },
  },
  production: { ratioStart: 1.5, ratioEnd: 1.28 },
  // Raised in M1a.4b to remove the storage ceiling (§0 contract, root cause #1): 800 was
  // authored for classic x1, but speed.production is 5, so 800*5 = 4000 restores the
  // original time-to-fill instead of inventing a new one. generalRatio/foodRatio raised
  // from 1.25 to 1.30 so max storage (level 20) clears the L19 cost of every resource-family
  // building — see balance/storageCeiling.test.ts for the exact arithmetic.
  storage: {
    generalBase: 4000,
    generalRatio: 1.3,
    foodBase: 4000,
    foodRatio: 1.3,
  },
  commandCenter: {
    buildTimeRatio: 0.964,
  },
  // Added in M1a.4b to fix Food upkeep's decay into irrelevance (§0 contract, root cause
  // #2): geometric-in-level and speed-scaled so upkeep's share of gross Food output can
  // grow instead of shrinking against production's own compounding growth. 1.58 chosen by
  // sweeping against the reference-player harness (see balance/foodUpkeepShape.test.ts) —
  // paired with the ~0.1x-rescaled per-building foodUpkeepWeight values in buildings.ts.
  upkeep: {
    ratio: 1.58,
  },
  influence: {
    settlementThresholds: [90, 160],
    maxSettlements: 3,
  },
  buildings: BUILDINGS,
};
