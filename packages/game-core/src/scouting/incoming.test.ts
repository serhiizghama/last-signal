import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config/index.js';
import { incomingDetailTier } from './incoming.js';

const config = DEFAULT_CONFIG; // radioTower.incomingTiers: { kind: 1, full: 5 }

describe('incomingDetailTier', () => {
  it('is "existence" at level 0 — never gated, even with no Radio Tower at all (§12)', () => {
    expect(incomingDetailTier(config, 0)).toBe('existence');
  });

  it('is "kind" at the kind threshold (1)', () => {
    expect(incomingDetailTier(config, 1)).toBe('kind');
  });

  it('stays "kind" below the full threshold (4)', () => {
    expect(incomingDetailTier(config, 4)).toBe('kind');
  });

  it('is "full" at the full threshold (5)', () => {
    expect(incomingDetailTier(config, 5)).toBe('full');
  });

  it('stays "full" well above the full threshold (20)', () => {
    expect(incomingDetailTier(config, 20)).toBe('full');
  });
});
