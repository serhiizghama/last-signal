import { describe, expect, it } from 'vitest';
import { RESOURCE_KINDS, type Resources } from './types.js';

describe('RESOURCE_KINDS', () => {
  it('contains exactly the four expected resource kinds, in order', () => {
    expect(RESOURCE_KINDS).toEqual(['scrap', 'fuel', 'electronics', 'food']);
  });

  it('is usable to build a fully-keyed Resources record', () => {
    const resources: Resources = RESOURCE_KINDS.reduce((acc, kind) => {
      acc[kind] = 0;
      return acc;
    }, {} as Resources);

    for (const kind of RESOURCE_KINDS) {
      expect(resources[kind]).toBe(0);
    }
  });
});
