import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config/index.js';
import type { GameConfig } from '../config/types.js';
import { oasisTargetDefenders, settleOasis, type OasisLiveState } from './oasis-state.js';

const config = DEFAULT_CONFIG;
const seed = 'world-alpha';

function countOf(target: ReturnType<typeof oasisTargetDefenders>, unitType: string): number {
  return target.find((t) => t.unitType === unitType)?.count ?? 0;
}

describe('oasisTargetDefenders', () => {
  it('is deterministic for the same (seed, x, y)', () => {
    const a = oasisTargetDefenders(config, seed, 5, -3);
    const b = oasisTargetDefenders(config, seed, 5, -3);
    expect(a).toEqual(b);
  });

  it('differs across coordinates', () => {
    const a = oasisTargetDefenders(config, seed, 5, -3);
    const b = oasisTargetDefenders(config, seed, 6, -3);
    expect(a).not.toEqual(b);
  });

  it('differs across seeds for the same coordinates', () => {
    const a = oasisTargetDefenders(config, 'world-alpha', 5, -3);
    const b = oasisTargetDefenders(config, 'world-beta', 5, -3);
    expect(a).not.toEqual(b);
  });

  it('returns the two wildlife types in catalogue order (Feral Dog, then Scavenger Gang)', () => {
    const target = oasisTargetDefenders(config, seed, 0, 0);
    expect(target.map((t) => t.unitType)).toEqual(['feralDog', 'scavengerGang']);
  });

  // The off-by-one guard the brief calls out explicitly: `rollRange` is a COUNT of distinct
  // values, so the inclusive maximum (base + rollRange - 1) must actually be reachable, not
  // merely never exceeded. A large fixed sweep of coordinates is used so the reachability
  // assertion isn't relying on luck from a single (x, y).
  it('lands every roll inside [base, base + rollRange - 1] inclusive, with the max reachable', () => {
    const { feralDog, scavengerGang } = config.oasis.defenders;
    const feralDogMax = feralDog.base + feralDog.rollRange - 1;
    const scavengerGangMax = scavengerGang.base + scavengerGang.rollRange - 1;

    let sawFeralDogMax = false;
    let sawScavengerGangMax = false;

    for (let x = 0; x < 200; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        const target = oasisTargetDefenders(config, seed, x, y);
        const feralDogCount = countOf(target, 'feralDog');
        const scavengerGangCount = countOf(target, 'scavengerGang');

        expect(feralDogCount).toBeGreaterThanOrEqual(feralDog.base);
        expect(feralDogCount).toBeLessThanOrEqual(feralDogMax);
        expect(scavengerGangCount).toBeGreaterThanOrEqual(scavengerGang.base);
        expect(scavengerGangCount).toBeLessThanOrEqual(scavengerGangMax);

        if (feralDogCount === feralDogMax) sawFeralDogMax = true;
        if (scavengerGangCount === scavengerGangMax) sawScavengerGangMax = true;
      }
    }

    expect(sawFeralDogMax).toBe(true);
    expect(sawScavengerGangMax).toBe(true);
  });
});

const NEVER_TOUCHED: OasisLiveState = {
  defenders: [],
  food: 0,
  lastRegenAt: null,
  lastDefenderRegenAt: null,
};

describe('settleOasis: never-touched materialisation', () => {
  it('materialises at the full target composition with an empty Food pool, stamping both timestamps to now', () => {
    const target = oasisTargetDefenders(config, seed, 10, 10);
    const next = settleOasis(config, seed, 10, 10, NEVER_TOUCHED, 1_000);
    expect(next.defenders).toEqual(target);
    expect(next.food).toBe(0);
    expect(next.lastRegenAt).toBe(1_000);
    expect(next.lastDefenderRegenAt).toBe(1_000);
  });

  it('treats either timestamp being null as "never touched", not just both', () => {
    const target = oasisTargetDefenders(config, seed, 1, 1);
    const partial: OasisLiveState = {
      defenders: [{ unitType: 'feralDog', count: 3 }],
      food: 50,
      lastRegenAt: null,
      lastDefenderRegenAt: 500,
    };
    const next = settleOasis(config, seed, 1, 1, partial, 1_000);
    expect(next.defenders).toEqual(target);
    expect(next.food).toBe(0);
  });
});

describe('settleOasis: defender regeneration', () => {
  const HOUR_MS = 3_600_000;

  it('grows one unit of EACH type per interval, never past target', () => {
    const target = oasisTargetDefenders(config, seed, 20, 20);
    const interval = config.oasis.regen.defenderIntervalMs;
    const start: OasisLiveState = {
      defenders: [],
      food: 0,
      lastRegenAt: 0,
      lastDefenderRegenAt: 0,
    };

    const afterOneInterval = settleOasis(config, seed, 20, 20, start, interval);
    for (const { unitType } of target) {
      expect(countOf(afterOneInterval.defenders, unitType)).toBe(1);
    }

    // Settle far enough that every type would overshoot its target if regen didn't clamp.
    const farFuture = interval * 1000;
    const afterMany = settleOasis(config, seed, 20, 20, start, farFuture);
    expect(afterMany.defenders).toEqual(target);
  });

  it('grants nothing to a type already at target', () => {
    const target = oasisTargetDefenders(config, seed, 3, 4);
    const interval = config.oasis.regen.defenderIntervalMs;
    const atTarget: OasisLiveState = {
      defenders: target,
      food: 0,
      lastRegenAt: 0,
      lastDefenderRegenAt: 0,
    };
    const next = settleOasis(config, seed, 3, 4, atTarget, interval * 5);
    expect(next.defenders).toEqual(target);
  });

  it('preserves the sub-interval remainder: settling in two steps matches settling once', () => {
    const interval = config.oasis.regen.defenderIntervalMs;
    const start: OasisLiveState = {
      defenders: [],
      food: 0,
      lastRegenAt: 0,
      lastDefenderRegenAt: 0,
    };

    // t1 lands partway through the second interval (1.5x), t2 finishes a third full interval.
    const t1 = Math.floor(interval * 1.5);
    const t2 = interval * 3;

    const stepwise = settleOasis(
      config,
      seed,
      7,
      -7,
      settleOasis(config, seed, 7, -7, start, t1),
      t2,
    );
    const direct = settleOasis(config, seed, 7, -7, start, t2);

    expect(stepwise.defenders).toEqual(direct.defenders);
  });

  it('now at or before the stored defender timestamp is a no-op on defender counts', () => {
    const settled: OasisLiveState = {
      defenders: [{ unitType: 'feralDog', count: 5 }],
      food: 100,
      lastRegenAt: 10_000,
      lastDefenderRegenAt: 10_000,
    };
    const next = settleOasis(config, seed, 8, 8, settled, 5_000);
    expect(next.defenders).toEqual(settled.defenders);
    expect(next.lastDefenderRegenAt).toBe(5_000);
  });

  it('never mutates the input state', () => {
    const start: OasisLiveState = {
      defenders: [{ unitType: 'feralDog', count: 2 }],
      food: 10,
      lastRegenAt: 0,
      lastDefenderRegenAt: 0,
    };
    const snapshot = JSON.parse(JSON.stringify(start)) as OasisLiveState;
    settleOasis(config, seed, 9, 9, start, HOUR_MS * 10);
    expect(start).toEqual(snapshot);
  });
});

describe('settleOasis: Food accrual', () => {
  const HOUR_MS = 3_600_000;

  it('accrues at foodPerHour', () => {
    const start: OasisLiveState = {
      defenders: [],
      food: 0,
      lastRegenAt: 0,
      lastDefenderRegenAt: 0,
    };
    const next = settleOasis(config, seed, 11, 11, start, HOUR_MS * 2);
    expect(next.food).toBeCloseTo(config.oasis.regen.foodPerHour * 2, 10);
  });

  it('clamps at foodCap, however long the gap', () => {
    const start: OasisLiveState = {
      defenders: [],
      food: 0,
      lastRegenAt: 0,
      lastDefenderRegenAt: 0,
    };
    const next = settleOasis(config, seed, 12, 12, start, HOUR_MS * 100_000);
    expect(next.food).toBe(config.oasis.regen.foodCap);
  });

  it('does not confiscate a pool already above the cap', () => {
    const configWithLowerCap: GameConfig = {
      ...config,
      oasis: { ...config.oasis, regen: { ...config.oasis.regen, foodCap: 10 } },
    };
    const start: OasisLiveState = {
      defenders: [],
      food: 50,
      lastRegenAt: 0,
      lastDefenderRegenAt: 0,
    };
    const next = settleOasis(configWithLowerCap, seed, 13, 13, start, HOUR_MS);
    expect(next.food).toBe(50);
  });

  it('now at or before the stored regen timestamp is a no-op on the Food pool', () => {
    const settled: OasisLiveState = {
      defenders: [],
      food: 42,
      lastRegenAt: 10_000,
      lastDefenderRegenAt: 10_000,
    };
    const next = settleOasis(config, seed, 14, 14, settled, 5_000);
    expect(next.food).toBe(42);
    expect(next.lastRegenAt).toBe(5_000);
  });
});
