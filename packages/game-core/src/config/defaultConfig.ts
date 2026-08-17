import { UNITS } from '../units/index.js';
import { BUILDINGS } from './buildings.js';
import type { GameConfig } from './types.js';

/**
 * First-pass balance config (§3, §9, §10). All numbers are draft values meant to be tuned by
 * the balance simulator later; formulas always take a `GameConfig` as an injected first
 * argument so sweeping these values never requires editing source.
 */
export const DEFAULT_CONFIG: GameConfig = {
  // Bumped in M3a.1 (M3 §5, §19.3): the unit roster widened to 18 types and the `combat`
  // block was added. configVersion policy for the rest of M3 (orchestrator decision): the
  // whole of M3 lands under configVersion 7 — later M3 steps add more blocks
  // (combat.randomFactor, wall, hiddenCache, siege, training, protection, market, …)
  // without bumping again, since M3 is unreleased and the field's purpose is letting an
  // *archived season* stay interpretable, not tracking in-development edits. Past seasons
  // archived under configVersion 6 keep their original (pre-M3, movement-only) shape.
  configVersion: 7,
  // travel pinned at 2 (down from 2.5) in M2 §0 so the travel-time contract table is
  // concrete; the knob stays sweepable by tools/sim.
  speed: { build: 5, production: 5, training: 5, travel: 2 },
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
  units: UNITS,
  // Added in M2b.1 (§8 of the M2 design record): the Radio Tower differential that unlocks
  // the buildings intel tier. Draft number, sweepable by tools/sim like everything else in
  // this file. `lossExponent` used to live here too — moved to `combat` below in M3a.1.
  scouting: {
    buildingsTierMinDiff: 1,
  },
  // Added in M3a.1 (§0, §5 of the M3 design record): the shared casualty-curve exponent,
  // promoted out of `scouting` so scout-vs-scout and regular battle resolution read one
  // constant — a player who has learned to read scout losses can read battle losses too.
  // Same value (1.5) M2 §8 already shipped for scouts; `scouting/combat.ts` now reads this
  // field instead of `scouting.lossExponent`, with identical behaviour.
  combat: {
    lossExponent: 1.5,
  },
  // Added in M2b.3 (§6 of the M2 design record): the window after send during which a
  // movement can still be cancelled. 90s is the Kirilloid/T4 recall-window draft; a number,
  // sweepable by tools/sim like everything else in this file.
  movement: {
    cancelWindowMs: 90_000,
  },
  // Added in M3a.2 (§2 of the M3 design record): training time now scales with the training
  // building's level — the reason Barracks levels stop being dead weight. Same shape as the
  // Command Center's build-time divisor (`commandCenter.buildTimeRatio`), the same config
  // style: `timeFactor = training.buildingTimeRatio ** (level - 1)`. Draft 0.91 -> a level-20
  // Barracks trains 6.0x faster than level 1 (`0.91^19 = 0.1666`). A draft number, sweepable
  // by tools/sim in M4 like everything else in this file.
  training: {
    buildingTimeRatio: 0.91,
  },
  // Added in M2a.1 (§1, §2, §3 of the M2 design record): map geometry, derived terrain,
  // farm oases and the center-out expanding spawn policy. All draft numbers, sweepable by
  // tools/sim like everything else in this file.
  map: {
    radius: 30,
    terrainWeights: {
      wasteland: 0.55,
      deadForest: 0.12,
      rockyHills: 0.1,
      ruinedCity: 0.08,
      brokenHighway: 0.08,
      toxicLake: 0.07,
    },
    oases: {
      count: 24,
      minDistance: 5,
      edgeMargin: 2,
    },
    spawn: {
      baseRadius: 4,
      growthCoefficient: 1.8,
      bandWidth: 6,
      maxRadius: 30,
    },
    settlement: {
      minDistance: 3,
    },
  },
};
