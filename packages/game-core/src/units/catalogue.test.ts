import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config/defaultConfig.js';
import { FACTIONS, UNIT_TYPES } from '../config/types.js';
import { resolveScoutCombat } from '../scouting/combat.js';
import { UNITS } from './catalogue.js';

// Full-roster mirror tables were deliberately NOT kept here (reviewer decision after this
// step's first pass): a table transcribed from the same source (M3 §1) in the same sitting
// catches nothing at authoring time — it only detects *later* edits, at the cost of a
// lockstep two-file update on every M4 tuning pass. That is exactly the drag the project's
// standing lesson ("derive test expectations from `game-core` at assertion time") exists to
// avoid. `EXPECTED` below is narrowed to only the three units whose exact values a *shipped
// contract* depends on: M3b's battle resolution reproduces the four §0 battle-contract rows
// exactly, and those rows were hand-computed from Brute's, Torcher's and Biker's
// `attack`/`defInfantry`/`defCavalry`/`carry` — a silent edit to any of those four fields on
// these three units would break a shipped contract, not just rebalance a draft. Every other
// unit (and every other field, including these three units' cost/speed/trainedIn/etc.) is
// covered by the structural property tests below instead — roster shape, trainability,
// training-building mapping, split class, siege damage, scout fields, carry — which are
// immune to rebalancing by construction.
const EXPECTED = {
  brute: {
    faction: 'raiders',
    role: 'offenseInfantry',
    cost: { scrap: 95, fuel: 15, electronics: 0, food: 25 },
    baseTrainTimeSec: 300,
    speed: 7,
    attack: 40,
    defInfantry: 20,
    defCavalry: 5,
    carry: 60,
    splitClass: 'infantry',
    scoutAttack: 0,
    scoutDefense: 0,
    foodUpkeepPerHour: 1,
    trainedIn: 'barracks',
  },
  torcher: {
    faction: 'raiders',
    role: 'defenseInfantry',
    cost: { scrap: 70, fuel: 30, electronics: 10, food: 25 },
    baseTrainTimeSec: 380,
    speed: 7,
    attack: 10,
    defInfantry: 35,
    defCavalry: 60,
    carry: 40,
    splitClass: 'infantry',
    scoutAttack: 0,
    scoutDefense: 0,
    foodUpkeepPerHour: 1,
    trainedIn: 'barracks',
  },
  biker: {
    faction: 'raiders',
    role: 'fast',
    cost: { scrap: 180, fuel: 230, electronics: 50, food: 60 },
    baseTrainTimeSec: 1150,
    speed: 10,
    attack: 110,
    defInfantry: 45,
    defCavalry: 60,
    carry: 90,
    splitClass: 'cavalry',
    scoutAttack: 0,
    scoutDefense: 0,
    foodUpkeepPerHour: 3,
    trainedIn: 'machineShop',
  },
} as const;

const CONTRACT_UNIT_TYPES = Object.keys(EXPECTED) as (keyof typeof EXPECTED)[];

describe('UNITS catalogue', () => {
  it('has exactly 18 entries, one per UNIT_TYPES', () => {
    expect(Object.keys(UNITS)).toHaveLength(18);
    expect(UNIT_TYPES).toHaveLength(18);
    expect(new Set(Object.keys(UNITS))).toEqual(new Set(UNIT_TYPES));
  });

  it('has a `type` field matching its own key for every entry', () => {
    for (const type of UNIT_TYPES) {
      expect(UNITS[type].type).toBe(type);
    }
  });

  // §0 battle-contract regression: Brute/Torcher/Biker only — see the comment on `EXPECTED`.
  it.each(CONTRACT_UNIT_TYPES)('matches the §0 battle-contract table exactly for %s', (type) => {
    expect(UNITS[type]).toEqual({ type, ...EXPECTED[type] });
  });
});

describe('roster shape (M3 §1: 5 units per faction, 1 settler, 2 wildlife)', () => {
  const rosterRoles = ['offenseInfantry', 'defenseInfantry', 'scout', 'fast', 'siege'] as const;

  it('gives each faction exactly one unit per combat role, 15 total', () => {
    for (const faction of FACTIONS) {
      const forFaction = UNIT_TYPES.filter((type) => UNITS[type].faction === faction);
      expect(forFaction).toHaveLength(5);
      for (const role of rosterRoles) {
        expect(forFaction.filter((type) => UNITS[type].role === role)).toHaveLength(1);
      }
    }
    const facUnits = UNIT_TYPES.filter((type) => UNITS[type].faction !== null);
    expect(facUnits).toHaveLength(15);
  });

  it('has exactly one settler and exactly two wildlife, all with faction === null', () => {
    const settlers = UNIT_TYPES.filter((type) => UNITS[type].role === 'settler');
    const wildlife = UNIT_TYPES.filter((type) => UNITS[type].role === 'wildlife');
    expect(settlers).toHaveLength(1);
    expect(wildlife).toHaveLength(2);
    for (const type of [...settlers, ...wildlife]) {
      expect(UNITS[type].faction).toBeNull();
    }
  });
});

describe('trainability', () => {
  it('every faction-locked unit has a trainedIn', () => {
    for (const type of UNIT_TYPES) {
      const unit = UNITS[type];
      if (unit.faction !== null) {
        expect(unit.trainedIn).toBeDefined();
      }
    }
  });

  it('the settler is trainedIn commandCenter despite faction === null', () => {
    expect(UNITS.settler.faction).toBeNull();
    expect(UNITS.settler.trainedIn).toBe('commandCenter');
  });

  it('both wildlife types have no trainedIn and an all-zero cost and 0 baseTrainTimeSec', () => {
    for (const type of ['feralDog', 'scavengerGang'] as const) {
      const unit = UNITS[type];
      expect(unit.trainedIn).toBeUndefined();
      expect(unit.cost).toEqual({ scrap: 0, fuel: 0, electronics: 0, food: 0 });
      expect(unit.baseTrainTimeSec).toBe(0);
    }
  });
});

describe('training-building mapping (M3 §2)', () => {
  it('every offenseInfantry / defenseInfantry / scout unit trains in barracks', () => {
    const barracksRoles = ['offenseInfantry', 'defenseInfantry', 'scout'] as const;
    for (const type of UNIT_TYPES) {
      const unit = UNITS[type];
      if (barracksRoles.includes(unit.role as (typeof barracksRoles)[number])) {
        expect(unit.trainedIn).toBe('barracks');
      }
    }
  });

  it('every fast / siege unit trains in machineShop', () => {
    for (const type of UNIT_TYPES) {
      const unit = UNITS[type];
      if (unit.role === 'fast' || unit.role === 'siege') {
        expect(unit.trainedIn).toBe('machineShop');
      }
    }
  });
});

describe('split class', () => {
  it('exactly the three fast units are cavalry; everything else is infantry', () => {
    const cavalry = UNIT_TYPES.filter((type) => UNITS[type].splitClass === 'cavalry');
    const fastUnits = UNIT_TYPES.filter((type) => UNITS[type].role === 'fast');
    expect(cavalry).toHaveLength(3);
    expect(new Set(cavalry)).toEqual(new Set(fastUnits));
    for (const type of UNIT_TYPES) {
      if (UNITS[type].role !== 'fast') {
        expect(UNITS[type].splitClass).toBe('infantry');
      }
    }
  });
});

describe('siege damage', () => {
  it('exactly the three siege units define wallDamage/buildingDamage, both > 0', () => {
    const siegeUnits = UNIT_TYPES.filter((type) => UNITS[type].role === 'siege');
    expect(siegeUnits).toHaveLength(3);
    for (const type of siegeUnits) {
      expect(UNITS[type].wallDamage).toBeGreaterThan(0);
      expect(UNITS[type].buildingDamage).toBeGreaterThan(0);
    }
  });

  it('no non-siege unit defines wallDamage or buildingDamage', () => {
    for (const type of UNIT_TYPES) {
      if (UNITS[type].role !== 'siege') {
        expect(UNITS[type].wallDamage).toBeUndefined();
        expect(UNITS[type].buildingDamage).toBeUndefined();
      }
    }
  });
});

describe('scout fields', () => {
  it('every scout has scoutAttack > 0 and scoutDefense > 0', () => {
    for (const type of UNIT_TYPES) {
      if (UNITS[type].role === 'scout') {
        expect(UNITS[type].scoutAttack).toBeGreaterThan(0);
        expect(UNITS[type].scoutDefense).toBeGreaterThan(0);
      }
    }
  });

  it('every non-scout unit has scoutAttack === 0 and scoutDefense === 0', () => {
    for (const type of UNIT_TYPES) {
      if (UNITS[type].role !== 'scout') {
        expect(UNITS[type].scoutAttack).toBe(0);
        expect(UNITS[type].scoutDefense).toBe(0);
      }
    }
  });
});

describe('M2 scouting is untouched (regression, M3 §1/§19.3)', () => {
  it('combat units in the defender garrison contribute nothing to scout defence', () => {
    const attackers = [{ unitType: 'lookout' as const, count: 10 }];
    const scoutsOnly = [{ unitType: 'falconer' as const, count: 2 }];
    const withCombatUnitsMixedIn = [
      { unitType: 'falconer' as const, count: 2 },
      { unitType: 'brute' as const, count: 50 },
      { unitType: 'torcher' as const, count: 30 },
    ];
    const baseline = resolveScoutCombat(DEFAULT_CONFIG, attackers, scoutsOnly);
    const withCombatUnits = resolveScoutCombat(DEFAULT_CONFIG, attackers, withCombatUnitsMixedIn);
    expect(withCombatUnits.defPts).toBe(baseline.defPts);
    expect(withCombatUnits.lossFraction).toBe(baseline.lossFraction);
    expect(withCombatUnits.losses).toEqual(baseline.losses);
    expect(withCombatUnits.survivors).toEqual(baseline.survivors);
  });

  it('DEFAULT_CONFIG.combat.lossExponent is 1.5 (promoted from scouting.lossExponent, §5)', () => {
    expect(DEFAULT_CONFIG.combat.lossExponent).toBe(1.5);
  });
});

describe('carry capacity', () => {
  it('every unit has carry >= 0', () => {
    for (const type of UNIT_TYPES) {
      expect(UNITS[type].carry).toBeGreaterThanOrEqual(0);
    }
  });

  it('siege units, scouts and the settler have carry === 0 (not looters)', () => {
    for (const type of UNIT_TYPES) {
      const unit = UNITS[type];
      if (unit.role === 'siege' || unit.role === 'scout' || unit.role === 'settler') {
        expect(unit.carry).toBe(0);
      }
    }
  });
});
