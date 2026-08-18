import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config/index.js';
import type { Resources } from '../types.js';
import type { TroopCounts } from '../units/index.js';
import { resolveBattle, type BattleContingent } from './battle.js';
import { hiddenCacheProtection, resolveLoot, type LootTarget } from './loot.js';

const config = DEFAULT_CONFIG;

describe('hiddenCacheProtection', () => {
  it('level 0 -> 0 (no cache, not the raw formula’s 148.1)', () => {
    expect(hiddenCacheProtection(config, 0)).toBe(0);
  });

  it('negative levels are folded into the level-0 case', () => {
    expect(hiddenCacheProtection(config, -3)).toBe(0);
  });

  it('level 1 -> base, 200', () => {
    expect(hiddenCacheProtection(config, 1)).toBe(200);
  });

  it('level 5 -> 664.30125 (200 * 1.35^4), the §0 contract value', () => {
    expect(hiddenCacheProtection(config, 5)).toBeCloseTo(664.30125, 9);
  });

  it('level 10 (max level) -> 2978.749… (200 * 1.35^9)', () => {
    expect(hiddenCacheProtection(config, 10)).toBeCloseTo(2978.7490175730486, 9);
  });
});

describe('resolveLoot — §0 loot contract row', () => {
  // docs/M3_DESIGN_DECISIONS.md §0: 93 surviving Brutes * carry 60 = 5580 capacity against a
  // target holding scrap 3000 / fuel 1200 / electronics 400 / food 2000 behind a Hidden Cache
  // L5 (200 * 1.35^4 = 664.30125 protected per resource): available = 2335.69875 / 535.69875
  // / 0 / 1335.69875 = 4207.09625 total, below capacity, so all of it is taken and the cache
  // is what saved the Electronics entirely. This is a hand-computed contract, so hardcoding
  // its expected numbers here is correct — same convention `battle.test.ts` already uses
  // for the four battle rows. The 5580 capacity itself is *not* hardcoded: it is derived below
  // from a real `resolveBattle` call for §0 row 1, so this test also proves the wiring between
  // `resolveBattle` and `resolveLoot` end to end.
  it('reproduces the §0 loot row exactly, capacity derived from resolveBattle row 1', () => {
    const attacker: TroopCounts = [{ unitType: 'brute', count: 100 }];
    const defenders: BattleContingent[] = [
      { key: 'home', troops: [{ unitType: 'torcher', count: 20 }] },
    ];
    const battle = resolveBattle(config, {
      attacker,
      defenders,
      wallLevel: 0,
      kind: 'assault',
      roll: 0,
    });
    expect(battle.lootCapacity).toBe(5580);
    expect(battle.attackerPrevailed).toBe(true);

    const target: LootTarget = {
      stored: { scrap: 3000, fuel: 1200, electronics: 400, food: 2000 },
      hiddenCacheLevel: 5,
    };
    const result = resolveLoot(config, battle, target);

    expect(result.protectedPerResource).toBeCloseTo(664.30125, 9);
    expect(result.available.scrap).toBeCloseTo(2335.69875, 9);
    expect(result.available.fuel).toBeCloseTo(535.69875, 9);
    expect(result.available.electronics).toBe(0); // the cache saved the Electronics entirely
    expect(result.available.food).toBeCloseTo(1335.69875, 9);

    // Below capacity: everything available is taken, nothing scaled down.
    expect(result.capacityBound).toBe(false);
    expect(result.taken.scrap).toBeCloseTo(2335.69875, 9);
    expect(result.taken.fuel).toBeCloseTo(535.69875, 9);
    expect(result.taken.electronics).toBe(0);
    expect(result.taken.food).toBeCloseTo(1335.69875, 9);
    expect(result.totalTaken).toBeCloseTo(4207.09625, 9);
  });
});

describe('resolveLoot — capacity-bound proportional split', () => {
  it('distributes the take proportionally to availability — a raider cannot cherry-pick', () => {
    const battle = { lootCapacity: 500, attackerPrevailed: true };
    const target: LootTarget = {
      // No Hidden Cache: available === stored.
      stored: { scrap: 1000, fuel: 500, electronics: 300, food: 200 },
      hiddenCacheLevel: 0,
    };
    const result = resolveLoot(config, battle, target);

    expect(result.capacityBound).toBe(true);
    // Total availability is 2000, well above the 500 capacity.
    const totalAvailable = 2000;
    expect(result.taken.scrap).toBeCloseTo((500 * 1000) / totalAvailable, 9);
    expect(result.taken.fuel).toBeCloseTo((500 * 500) / totalAvailable, 9);
    expect(result.taken.electronics).toBeCloseTo((500 * 300) / totalAvailable, 9);
    expect(result.taken.food).toBeCloseTo((500 * 200) / totalAvailable, 9);
    expect(result.totalTaken).toBeCloseTo(500, 9);

    // The point: Electronics' share of the take equals its share of availability — a
    // raider cannot skew the mix toward the resource they want most.
    const electronicsAvailabilityShare = target.stored.electronics / totalAvailable;
    const electronicsTakeShare = result.taken.electronics / result.totalTaken;
    expect(electronicsTakeShare).toBeCloseTo(electronicsAvailabilityShare, 9);
  });
});

describe('resolveLoot — attackerPrevailed: false', () => {
  it('loots nothing, even with large capacity and a rich, unprotected target', () => {
    const battle = { lootCapacity: 1_000_000, attackerPrevailed: false };
    const target: LootTarget = {
      stored: { scrap: 50_000, fuel: 50_000, electronics: 50_000, food: 50_000 },
      hiddenCacheLevel: 0,
    };
    const result = resolveLoot(config, battle, target);

    expect(result.taken).toEqual({ scrap: 0, fuel: 0, electronics: 0, food: 0 });
    expect(result.totalTaken).toBe(0);
    expect(result.capacityBound).toBe(false);
  });
});

describe('resolveLoot — edge cases', () => {
  it('every resource below the protection threshold -> nothing is taken', () => {
    const battle = { lootCapacity: 5000, attackerPrevailed: true };
    const target: LootTarget = {
      stored: { scrap: 100, fuel: 200, electronics: 50, food: 600 },
      hiddenCacheLevel: 5, // protection 664.30125, above every stored amount
    };
    const result = resolveLoot(config, battle, target);

    expect(result.available).toEqual({ scrap: 0, fuel: 0, electronics: 0, food: 0 });
    expect(result.taken).toEqual({ scrap: 0, fuel: 0, electronics: 0, food: 0 });
    expect(result.totalTaken).toBe(0);
    expect(result.capacityBound).toBe(false);
  });

  it('lootCapacity: 0 -> nothing is taken', () => {
    const battle = { lootCapacity: 0, attackerPrevailed: true };
    const target: LootTarget = {
      stored: { scrap: 1000, fuel: 1000, electronics: 1000, food: 1000 },
      hiddenCacheLevel: 0,
    };
    const result = resolveLoot(config, battle, target);

    expect(result.taken).toEqual({ scrap: 0, fuel: 0, electronics: 0, food: 0 });
    expect(result.totalTaken).toBe(0);
  });
});

describe('resolveLoot — purity', () => {
  it('is deterministic across repeated calls and never mutates the input stored object', () => {
    const battle = { lootCapacity: 500, attackerPrevailed: true };
    const stored: Resources = { scrap: 1000, fuel: 500, electronics: 300, food: 200 };
    const storedCopy = { ...stored };
    const target: LootTarget = { stored, hiddenCacheLevel: 0 };

    const first = resolveLoot(config, battle, target);
    const second = resolveLoot(config, battle, target);

    expect(first).toEqual(second);
    expect(stored).toEqual(storedCopy);
  });
});
