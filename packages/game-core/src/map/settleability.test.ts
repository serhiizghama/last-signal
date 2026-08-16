import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config/index.js';
import { isSettleable, type SettleabilityInput } from './settleability.js';

const BASE: SettleabilityInput = {
  tile: { x: 5, y: 5 },
  terrain: 'wasteland',
  isOasis: false,
  existingSettlements: [],
};

describe('isSettleable', () => {
  it('accepts a legal tile: on-grid, non-lake, non-oasis, far enough from every settlement', () => {
    expect(isSettleable(DEFAULT_CONFIG, BASE)).toBe(true);
  });

  it('rejects a toxic lake tile', () => {
    expect(isSettleable(DEFAULT_CONFIG, { ...BASE, terrain: 'toxicLake' })).toBe(false);
  });

  it('rejects an oasis tile, even on otherwise-legal terrain', () => {
    expect(isSettleable(DEFAULT_CONFIG, { ...BASE, isOasis: true })).toBe(false);
  });

  it('rejects a tile within the configured minimum distance of an existing settlement', () => {
    const minDistance = DEFAULT_CONFIG.map.settlement.minDistance;
    const tooClose = { x: BASE.tile.x + minDistance - 1, y: BASE.tile.y };
    expect(isSettleable(DEFAULT_CONFIG, { ...BASE, existingSettlements: [tooClose] })).toBe(false);
  });

  it('accepts a tile exactly at the configured minimum distance from an existing settlement', () => {
    const minDistance = DEFAULT_CONFIG.map.settlement.minDistance;
    const justFarEnough = { x: BASE.tile.x + minDistance, y: BASE.tile.y };
    expect(isSettleable(DEFAULT_CONFIG, { ...BASE, existingSettlements: [justFarEnough] })).toBe(
      true,
    );
  });

  it('rejects a tile outside the grid', () => {
    const { radius } = DEFAULT_CONFIG.map;
    expect(isSettleable(DEFAULT_CONFIG, { ...BASE, tile: { x: radius + 1, y: 0 } })).toBe(false);
  });

  it('checks distance against every existing settlement, not just the first', () => {
    const minDistance = DEFAULT_CONFIG.map.settlement.minDistance;
    const farAway = { x: BASE.tile.x + 50, y: BASE.tile.y + 50 };
    const tooClose = { x: BASE.tile.x + minDistance - 1, y: BASE.tile.y };
    expect(
      isSettleable(DEFAULT_CONFIG, {
        ...BASE,
        existingSettlements: [farAway, tooClose],
      }),
    ).toBe(false);
  });
});
