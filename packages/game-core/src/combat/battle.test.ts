import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config/index.js';
import type { TroopCounts } from '../units/index.js';
import { resolveBattle, type BattleContingent } from './battle.js';

const config = DEFAULT_CONFIG;

describe('resolveBattle — §0 contract table', () => {
  // docs/M3_DESIGN_DECISIONS.md §0: four hand-computed battle rows, `combat.randomFactor`
  // pinned to 0 as the record specifies (roll: 0 has the same effect, since
  // `atkPts = atkPtsBase * (1 + randomFactor * roll)` and `roll = 0` zeroes the term
  // regardless of `randomFactor`). These are a hand-computed contract, so hardcoding the
  // expected outcomes here is correct — this is the one place in the combat module where
  // hardcoded expectations against numbers (not shapes) are right, per the step brief; it
  // deliberately does NOT mirror the unit catalogue into this spec, only the table's own
  // pre-computed derivations.

  it('row 1: 100 Brute (assault) vs 20 Torcher, no wall', () => {
    const attacker: TroopCounts = [{ unitType: 'brute', count: 100 }];
    const defenders: BattleContingent[] = [
      { key: 'home', troops: [{ unitType: 'torcher', count: 20 }] },
    ];
    const result = resolveBattle(config, {
      attacker,
      defenders,
      wallLevel: 0,
      kind: 'assault',
      roll: 0,
    });

    expect(result.atkPtsBase).toBe(4000);
    expect(result.atkPts).toBe(4000);
    expect(result.defPts).toBeCloseTo(700, 9);
    expect(result.wallFactor).toBe(1);
    expect(result.x).toBeCloseTo(0.0732077523217316, 12);
    expect(result.attacker.losses).toEqual([{ unitType: 'brute', count: 7 }]);
    expect(result.attacker.survivors).toEqual([{ unitType: 'brute', count: 93 }]);
    expect(result.defenders).toEqual([
      {
        key: 'home',
        losses: [{ unitType: 'torcher', count: 20 }],
        survivors: [{ unitType: 'torcher', count: 0 }],
      },
    ]);
    // The §0 loot row: 93 surviving Brutes * carry 60 = 5580.
    expect(result.lootCapacity).toBe(5580);
    expect(result.attackerPrevailed).toBe(true);
  });

  it('row 2: 100 Brute (raid) vs 20 Torcher, no wall — partial engagement', () => {
    const attacker: TroopCounts = [{ unitType: 'brute', count: 100 }];
    const defenders: BattleContingent[] = [
      { key: 'home', troops: [{ unitType: 'torcher', count: 20 }] },
    ];
    const result = resolveBattle(config, {
      attacker,
      defenders,
      wallLevel: 0,
      kind: 'raid',
      roll: 0,
    });

    expect(result.x).toBeCloseTo(0.0732077523217316, 12);
    expect(result.attacker.losses).toEqual([{ unitType: 'brute', count: 7 }]);
    expect(result.defenders).toEqual([
      {
        key: 'home',
        // 1/(1+x) = 0.9317860... * 20 = 18.635... -> 19, one Torcher survives.
        losses: [{ unitType: 'torcher', count: 19 }],
        survivors: [{ unitType: 'torcher', count: 1 }],
      },
    ]);
    expect(result.attackerPrevailed).toBe(true);
  });

  it('row 3: 100 Brute (assault) vs 20 Torcher, L10 wall', () => {
    const attacker: TroopCounts = [{ unitType: 'brute', count: 100 }];
    const defenders: BattleContingent[] = [
      { key: 'home', troops: [{ unitType: 'torcher', count: 20 }] },
    ];
    const result = resolveBattle(config, {
      attacker,
      defenders,
      wallLevel: 10,
      kind: 'assault',
      roll: 0,
    });

    expect(result.wallFactor).toBeCloseTo(1.3439163793441222, 12); // 1.03^10
    expect(result.defPts).toBeCloseTo(940.7414655408855, 9);
    expect(result.x).toBeCloseTo(0.11405529275983686, 12);
    expect(result.attacker.losses).toEqual([{ unitType: 'brute', count: 11 }]);
    expect(result.defenders[0]!.losses).toEqual([{ unitType: 'torcher', count: 20 }]);
    expect(result.attackerPrevailed).toBe(true);
  });

  it('row 4: 50 Brute + 20 Biker (assault) vs 30 Torcher, no wall — infantry/cavalry split', () => {
    const attacker: TroopCounts = [
      { unitType: 'brute', count: 50 },
      { unitType: 'biker', count: 20 },
    ];
    const defenders: BattleContingent[] = [
      { key: 'home', troops: [{ unitType: 'torcher', count: 30 }] },
    ];
    const result = resolveBattle(config, {
      attacker,
      defenders,
      wallLevel: 0,
      kind: 'assault',
      roll: 0,
    });

    expect(result.atkPtsBase).toBe(4200);
    expect(result.atkInfantryShare).toBeCloseTo(0.47619047619047616, 12);
    expect(result.defPts).toBeCloseTo(1442.857142857143, 9);
    expect(result.x).toBeCloseTo(0.20135437255170202, 12);
    expect(result.attacker.losses).toEqual([
      { unitType: 'brute', count: 10 },
      { unitType: 'biker', count: 4 },
    ]);
    expect(result.defenders[0]!.losses).toEqual([{ unitType: 'torcher', count: 30 }]);
    expect(result.attackerPrevailed).toBe(true);
  });
});

describe('resolveBattle — the roll', () => {
  it('roll: +1 scales atkPts up by (1 + randomFactor); roll: -1 scales it down', () => {
    const attacker: TroopCounts = [{ unitType: 'brute', count: 100 }]; // atkPtsBase = 4000
    const defenders: BattleContingent[] = [
      { key: 'home', troops: [{ unitType: 'torcher', count: 20 }] },
    ];
    const up = resolveBattle(config, {
      attacker,
      defenders,
      wallLevel: 0,
      kind: 'assault',
      roll: 1,
    });
    const down = resolveBattle(config, {
      attacker,
      defenders,
      wallLevel: 0,
      kind: 'assault',
      roll: -1,
    });
    expect(config.combat.randomFactor).toBe(0.05);
    expect(up.atkPtsBase).toBe(4000);
    expect(up.atkPts).toBeCloseTo(4000 * 1.05, 9);
    expect(down.atkPts).toBeCloseTo(4000 * 0.95, 9);
  });
});

describe('resolveBattle — atkPts = 0 guard', () => {
  it('throws when the attacker has 0 attack points', () => {
    const attacker: TroopCounts = [{ unitType: 'brute', count: 0 }];
    const defenders: BattleContingent[] = [
      { key: 'home', troops: [{ unitType: 'torcher', count: 20 }] },
    ];
    expect(() =>
      resolveBattle(config, { attacker, defenders, wallLevel: 0, kind: 'assault', roll: 0 }),
    ).toThrow(/atkPts = 0/);
  });

  it('throws for a genuinely empty attacking army', () => {
    expect(() =>
      resolveBattle(config, {
        attacker: [],
        defenders: [],
        wallLevel: 0,
        kind: 'assault',
        roll: 0,
      }),
    ).toThrow();
  });
});

describe('resolveBattle — defender contingents', () => {
  it('splits losses proportionally to body count and is order-independent', () => {
    // 3000 Brute vs 1000 Torcher spread across two contingents (900 home / 100 ally, the ally
    // holding 10% of the defending bodies) gives a non-clamped, non-trivial x.
    const attacker: TroopCounts = [{ unitType: 'brute', count: 3000 }];
    const home: BattleContingent = { key: 'home', troops: [{ unitType: 'torcher', count: 900 }] };
    const ally: BattleContingent = { key: 'ally', troops: [{ unitType: 'torcher', count: 100 }] };

    const forward = resolveBattle(config, {
      attacker,
      defenders: [home, ally],
      wallLevel: 0,
      kind: 'raid',
      roll: 0,
    });
    const reversed = resolveBattle(config, {
      attacker,
      defenders: [ally, home],
      wallLevel: 0,
      kind: 'raid',
      roll: 0,
    });

    // Order-independence: byte-identical regardless of the input contingent order (§18).
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));

    const homeOutcome = forward.defenders.find((d) => d.key === 'home')!;
    const allyOutcome = forward.defenders.find((d) => d.key === 'ally')!;
    // x = (35000/120000)^1.5 = 0.157518..., raid defenderLossFraction = 1/(1+x) = 0.863917...
    expect(homeOutcome.losses).toEqual([{ unitType: 'torcher', count: 778 }]);
    expect(allyOutcome.losses).toEqual([{ unitType: 'torcher', count: 86 }]);
    const totalLoss = homeOutcome.losses[0]!.count + allyOutcome.losses[0]!.count;
    // The ally holds 10% of the 1000 defending bodies -> ~10% of the casualties, modulo the
    // independent per-contingent rounding the design record's uniform-fraction rule implies.
    expect(allyOutcome.losses[0]!.count / totalLoss).toBeCloseTo(0.1, 1);

    // Also sorted by ascending key regardless of input order.
    expect(forward.defenders.map((d) => d.key)).toEqual(['ally', 'home']);
  });
});

describe('resolveBattle — x clamps at 1', () => {
  const attacker: TroopCounts = [{ unitType: 'brute', count: 10 }]; // atkPts = 400
  const defenders: BattleContingent[] = [
    { key: 'home', troops: [{ unitType: 'torcher', count: 1000 }] }, // defInfantry = 35000
  ];

  it('assault: both sides lose everything and attackerPrevailed is false', () => {
    const result = resolveBattle(config, {
      attacker,
      defenders,
      wallLevel: 0,
      kind: 'assault',
      roll: 0,
    });
    expect(result.x).toBe(1);
    expect(result.attacker.survivors).toEqual([{ unitType: 'brute', count: 0 }]);
    expect(result.defenders[0]!.survivors).toEqual([{ unitType: 'torcher', count: 0 }]);
    expect(result.attackerPrevailed).toBe(false);
  });

  it('raid: the attacker leaves survivors but still did not prevail (§6)', () => {
    const result = resolveBattle(config, {
      attacker,
      defenders,
      wallLevel: 0,
      kind: 'raid',
      roll: 0,
    });
    expect(result.x).toBe(1);
    // x = 1 -> attackerLossFraction = 1/2 -> 10 * 0.5 = 5 survive.
    expect(result.attacker.survivors).toEqual([{ unitType: 'brute', count: 5 }]);
    expect(result.attacker.survivors.some((s) => s.count > 0)).toBe(true);
    expect(result.attackerPrevailed).toBe(false);
  });
});

describe('resolveBattle — wallLevel: 0', () => {
  it('gives wallFactor exactly 1', () => {
    const attacker: TroopCounts = [{ unitType: 'brute', count: 100 }];
    const defenders: BattleContingent[] = [
      { key: 'home', troops: [{ unitType: 'torcher', count: 20 }] },
    ];
    const result = resolveBattle(config, {
      attacker,
      defenders,
      wallLevel: 0,
      kind: 'assault',
      roll: 0,
    });
    expect(result.wallFactor).toBe(1);
  });
});

describe('resolveBattle — losses never exceed the army (property matrix)', () => {
  // A fixed matrix of hand-written scenarios spanning x from far below 1 to clamped at 1,
  // across both kinds, several wall levels and both roll extremes. No Math.random() — every
  // input here is a concrete, hand-written value, per the step brief.
  const scenarios: Array<{ name: string; attacker: TroopCounts; defenderTroops: TroopCounts }> = [
    {
      name: 'atkPts >> defPts (x near 0)',
      attacker: [{ unitType: 'brute', count: 1000 }],
      defenderTroops: [{ unitType: 'torcher', count: 1 }],
    },
    {
      name: 'moderate ratio (§0 row 1 shape)',
      attacker: [{ unitType: 'brute', count: 100 }],
      defenderTroops: [{ unitType: 'torcher', count: 20 }],
    },
    {
      name: 'mixed infantry/cavalry attacker (§0 row 4 shape)',
      attacker: [
        { unitType: 'brute', count: 50 },
        { unitType: 'biker', count: 20 },
      ],
      defenderTroops: [{ unitType: 'torcher', count: 30 }],
    },
    {
      name: 'defPts >> atkPts (x clamped at 1)',
      attacker: [{ unitType: 'brute', count: 10 }],
      defenderTroops: [{ unitType: 'torcher', count: 1000 }],
    },
    {
      name: 'extreme clamp, single attacking unit',
      attacker: [{ unitType: 'brute', count: 1 }],
      defenderTroops: [{ unitType: 'torcher', count: 2000 }],
    },
  ];
  const kinds = ['raid', 'assault'] as const;
  const wallLevels = [0, 5, 20];
  const rolls = [-1, 0, 1];

  for (const scenario of scenarios) {
    for (const kind of kinds) {
      for (const wallLevel of wallLevels) {
        for (const roll of rolls) {
          it(`${scenario.name} / ${kind} / wall L${wallLevel} / roll ${roll}: losses stay within the army on both sides`, () => {
            const defenders: BattleContingent[] = [
              { key: 'home', troops: scenario.defenderTroops },
            ];
            const result = resolveBattle(config, {
              attacker: scenario.attacker,
              defenders,
              wallLevel,
              kind,
              roll,
            });

            const attackerCountByType = new Map(
              scenario.attacker.map((a) => [a.unitType, a.count]),
            );
            for (const loss of result.attacker.losses) {
              const count = attackerCountByType.get(loss.unitType) ?? 0;
              expect(loss.count).toBeGreaterThanOrEqual(0);
              expect(loss.count).toBeLessThanOrEqual(count);
            }
            for (const survivor of result.attacker.survivors) {
              const count = attackerCountByType.get(survivor.unitType) ?? 0;
              const lost =
                result.attacker.losses.find((l) => l.unitType === survivor.unitType)?.count ?? 0;
              expect(survivor.count).toBe(count - lost);
            }

            const defenderCountByType = new Map(
              scenario.defenderTroops.map((d) => [d.unitType, d.count]),
            );
            const outcome = result.defenders[0]!;
            for (const loss of outcome.losses) {
              const count = defenderCountByType.get(loss.unitType) ?? 0;
              expect(loss.count).toBeGreaterThanOrEqual(0);
              expect(loss.count).toBeLessThanOrEqual(count);
            }
            for (const survivor of outcome.survivors) {
              const count = defenderCountByType.get(survivor.unitType) ?? 0;
              const lost = outcome.losses.find((l) => l.unitType === survivor.unitType)?.count ?? 0;
              expect(survivor.count).toBe(count - lost);
            }
          });
        }
      }
    }
  }
});
