import { describe, expect, it } from 'vitest';
import type { Resources } from './types.js';
import {
  addResources,
  canAfford,
  ceilSecondsToMs,
  emptyResources,
  floorForDisplay,
  roundCost,
  scaleResources,
  subtractResources,
} from './numeric.js';

function resources(scrap: number, fuel: number, electronics: number, food: number): Resources {
  return { scrap, fuel, electronics, food };
}

describe('roundCost', () => {
  it('rounds down below the half', () => {
    expect(roundCost(4.4)).toBe(4);
  });

  it('rounds up at exactly .5', () => {
    expect(roundCost(4.5)).toBe(5);
  });

  it('rounds a negative value toward positive infinity at .5', () => {
    expect(roundCost(-4.5)).toBe(-4);
  });

  it('leaves zero unchanged', () => {
    expect(roundCost(0)).toBe(0);
  });
});

describe('ceilSecondsToMs', () => {
  it('ceils a fractional number of seconds and converts to ms', () => {
    expect(ceilSecondsToMs(2.1)).toBe(3000);
  });

  it('leaves a whole number of seconds unchanged, converted to ms', () => {
    expect(ceilSecondsToMs(2)).toBe(2000);
  });

  it('returns 0 for 0 seconds', () => {
    expect(ceilSecondsToMs(0)).toBe(0);
  });

  it('ceils a negative fractional value toward zero', () => {
    expect(ceilSecondsToMs(-2.5)).toBe(-2000);
  });
});

describe('floorForDisplay', () => {
  it('floors a fractional value', () => {
    expect(floorForDisplay(4.9)).toBe(4);
  });

  it('floors exactly .5 down', () => {
    expect(floorForDisplay(4.5)).toBe(4);
  });

  it('floors a negative fractional value down', () => {
    expect(floorForDisplay(-4.5)).toBe(-5);
  });

  it('leaves zero unchanged', () => {
    expect(floorForDisplay(0)).toBe(0);
  });
});

describe('emptyResources', () => {
  it('sets every resource kind to 0', () => {
    expect(emptyResources()).toEqual({ scrap: 0, fuel: 0, electronics: 0, food: 0 });
  });
});

describe('addResources', () => {
  it('sums each resource kind element-wise', () => {
    const a = resources(1, 2, 3, 4);
    const b = resources(10, 20, 30, 40);
    expect(addResources(a, b)).toEqual(resources(11, 22, 33, 44));
  });

  it('does not mutate its arguments', () => {
    const a = resources(1, 2, 3, 4);
    const b = resources(10, 20, 30, 40);
    const aCopy = { ...a };
    const bCopy = { ...b };
    addResources(a, b);
    expect(a).toEqual(aCopy);
    expect(b).toEqual(bCopy);
  });
});

describe('subtractResources', () => {
  it('subtracts each resource kind element-wise', () => {
    const a = resources(10, 20, 30, 40);
    const b = resources(1, 2, 3, 4);
    expect(subtractResources(a, b)).toEqual(resources(9, 18, 27, 36));
  });

  it('does not mutate its arguments', () => {
    const a = resources(10, 20, 30, 40);
    const b = resources(1, 2, 3, 4);
    const aCopy = { ...a };
    const bCopy = { ...b };
    subtractResources(a, b);
    expect(a).toEqual(aCopy);
    expect(b).toEqual(bCopy);
  });
});

describe('scaleResources', () => {
  it('scales every resource kind by the given factor', () => {
    const a = resources(1, 2, 3, 4);
    expect(scaleResources(a, 2)).toEqual(resources(2, 4, 6, 8));
  });

  it('does not mutate its argument', () => {
    const a = resources(1, 2, 3, 4);
    const aCopy = { ...a };
    scaleResources(a, 3);
    expect(a).toEqual(aCopy);
  });
});

describe('canAfford', () => {
  it('is true when available exactly equals cost', () => {
    const available = resources(10, 10, 10, 10);
    const cost = resources(10, 10, 10, 10);
    expect(canAfford(available, cost)).toBe(true);
  });

  it('is false when available is one short on a single resource', () => {
    const available = resources(10, 10, 9, 10);
    const cost = resources(10, 10, 10, 10);
    expect(canAfford(available, cost)).toBe(false);
  });

  it('is true when available exceeds cost on every resource', () => {
    const available = resources(20, 20, 20, 20);
    const cost = resources(10, 10, 10, 10);
    expect(canAfford(available, cost)).toBe(true);
  });
});
