import { describe, expect, it } from 'vitest';
import { BUILDING_TYPES, DEFAULT_CONFIG, type BuildingType } from './index.js';

const buildings = DEFAULT_CONFIG.buildings;

describe('BUILDINGS catalogue', () => {
  it('has exactly 13 entries', () => {
    expect(Object.keys(buildings)).toHaveLength(13);
    expect(BUILDING_TYPES).toHaveLength(13);
  });

  it('has a key for every BuildingType, and no extras', () => {
    expect(new Set(Object.keys(buildings))).toEqual(new Set(BUILDING_TYPES));
  });

  it('has a `type` field matching its own key for every entry', () => {
    for (const type of BUILDING_TYPES) {
      expect(buildings[type].type).toBe(type);
    }
  });

  it('references only existing BuildingTypes in requires, at a level within that building maxLevel', () => {
    for (const type of BUILDING_TYPES) {
      for (const req of buildings[type].requires) {
        expect(BUILDING_TYPES).toContain(req.type);
        const requiredDef = buildings[req.type];
        expect(req.level).toBeGreaterThanOrEqual(1);
        expect(req.level).toBeLessThanOrEqual(requiredDef.maxLevel);
      }
    }
  });

  it('has an acyclic prerequisite graph', () => {
    // Real reachability check: DFS from every node, failing if we revisit a node
    // still on the current path (a back edge = a cycle).
    const visiting = new Set<BuildingType>();
    const done = new Set<BuildingType>();

    function visit(type: BuildingType, path: BuildingType[]): void {
      if (done.has(type)) {
        return;
      }
      if (visiting.has(type)) {
        throw new Error(`Cycle detected: ${[...path, type].join(' -> ')}`);
      }
      visiting.add(type);
      for (const req of buildings[type].requires) {
        visit(req.type, [...path, type]);
      }
      visiting.delete(type);
      done.add(type);
    }

    for (const type of BUILDING_TYPES) {
      expect(() => visit(type, [])).not.toThrow();
    }
  });

  it('caps Hidden Cache at level 10 and every other building at level 20', () => {
    for (const type of BUILDING_TYPES) {
      const expected = type === 'hiddenCache' ? 10 : 20;
      expect(buildings[type].maxLevel).toBe(expected);
    }
  });

  it('has exactly four buildings with production, one per resource kind', () => {
    const producers = BUILDING_TYPES.filter((type) => buildings[type].production !== undefined);
    expect(producers).toHaveLength(4);

    const resourceKinds = producers.map((type) => buildings[type].production?.resource);
    expect(new Set(resourceKinds)).toEqual(new Set(['scrap', 'fuel', 'electronics', 'food']));
  });

  it('has exactly two buildings with storage, one general and one food', () => {
    const storers = BUILDING_TYPES.filter((type) => buildings[type].storage !== undefined);
    expect(storers).toHaveLength(2);

    const kinds = storers.map((type) => buildings[type].storage).sort();
    expect(kinds).toEqual(['food', 'general']);
  });

  it('gives the Command Center an influence weight of 3, and everything else 1', () => {
    for (const type of BUILDING_TYPES) {
      const expected = type === 'commandCenter' ? 3 : 1;
      expect(buildings[type].influenceWeight).toBe(expected);
    }
  });
});
