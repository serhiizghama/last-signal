import type { UnitDef, UnitType } from '../config/types.js';

/**
 * First-pass unit catalogue (M2 §7): the three faction scouts only — the other 12 units land
 * in M3. Values are draft numbers at classic x1 (before `speed.training`), taken verbatim from
 * the design record and sanity-checked there against Kirilloid's Travian scout costs/times in
 * order of magnitude only (see this step's report for the re-check).
 *
 * Nomads get the best scouts (their locked faction identity is "efficient scouts"), Raiders
 * the cheapest and slowest, Engineers pay Electronics for a fast drone.
 */
export const UNITS: Record<UnitType, UnitDef> = {
  lookout: {
    type: 'lookout',
    faction: 'raiders',
    role: 'scout',
    cost: { scrap: 120, fuel: 40, electronics: 20, food: 30 },
    baseTrainTimeSec: 1200,
    speed: 9,
    scoutAttack: 35,
    scoutDefense: 20,
    foodUpkeepPerHour: 1,
  },
  surveyorDrone: {
    type: 'surveyorDrone',
    faction: 'engineers',
    role: 'scout',
    cost: { scrap: 100, fuel: 80, electronics: 60, food: 20 },
    baseTrainTimeSec: 1600,
    speed: 16,
    scoutAttack: 35,
    scoutDefense: 35,
    foodUpkeepPerHour: 1,
  },
  falconer: {
    type: 'falconer',
    faction: 'nomads',
    role: 'scout',
    cost: { scrap: 110, fuel: 50, electronics: 30, food: 30 },
    baseTrainTimeSec: 1300,
    speed: 17,
    scoutAttack: 45,
    scoutDefense: 40,
    foodUpkeepPerHour: 1,
  },
};
