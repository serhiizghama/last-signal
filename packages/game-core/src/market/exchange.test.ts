import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../config/index.js';
import { exchangeOutput } from './exchange.js';

// market.valueWeights: {scrap:1, fuel:1, electronics:2, food:1}, exchangeSpread: 0.25
const config = DEFAULT_CONFIG;

describe('exchangeOutput — the world exchange conversion (§14, M3d.4)', () => {
  it('a same-weight conversion (scrap -> fuel) loses exactly the spread', () => {
    // Both weight 1, so the rate is 1:1 before the spread — the output is simply
    // `amount * (1 - exchangeSpread)`.
    expect(exchangeOutput(config, 'scrap', 'fuel', 1000)).toBeCloseTo(750, 9);
    expect(exchangeOutput(config, 'fuel', 'food', 400)).toBeCloseTo(300, 9);
  });

  it('scrap -> electronics halves the raw amount before the spread (electronics weighs double)', () => {
    // 1000 scrap (weighted value 1000) buys 500 electronics-worth before the spread, then
    // loses 25% of that -> 375.
    expect(exchangeOutput(config, 'scrap', 'electronics', 1000)).toBeCloseTo(375, 9);
  });

  it('electronics -> scrap doubles the raw amount before the spread (electronics weighs double)', () => {
    // 100 electronics (weighted value 200) buys 200 scrap-worth before the spread, then
    // loses 25% -> 150.
    expect(exchangeOutput(config, 'electronics', 'scrap', 100)).toBeCloseTo(150, 9);
  });

  it('scrap->electronics and electronics->scrap are NOT inverses, and a round trip strictly loses (§14’s whole anti-abuse argument)', () => {
    const start = 1000;
    const toElectronics = exchangeOutput(config, 'scrap', 'electronics', start);
    const backToScrap = exchangeOutput(config, 'electronics', 'scrap', toElectronics);

    // If the two conversions were inverses, `backToScrap` would equal `start`. They are not:
    // each hop independently applies the spread, so the round trip compounds it.
    expect(backToScrap).not.toBeCloseTo(start, 6);
    expect(backToScrap).toBeLessThan(start);
    // Exactly `(1 - exchangeSpread) ** 2` of the original amount survives — the weight ratio
    // (2 out, 1/2 back) cancels itself over the round trip, leaving only the two spread
    // multiplications, algebraically independent of which two resources were chosen.
    expect(backToScrap).toBeCloseTo(start * (1 - config.market.exchangeSpread) ** 2, 9);
  });

  it('a round trip through equal-weight resources (fuel -> food -> fuel) also strictly loses', () => {
    const start = 500;
    const out = exchangeOutput(config, 'fuel', 'food', start);
    const back = exchangeOutput(config, 'food', 'fuel', out);
    expect(back).toBeLessThan(start);
    expect(back).toBeCloseTo(start * (1 - config.market.exchangeSpread) ** 2, 9);
  });

  it('a zero amount yields zero output, for any resource pair', () => {
    expect(exchangeOutput(config, 'scrap', 'fuel', 0)).toBe(0);
    expect(exchangeOutput(config, 'electronics', 'food', 0)).toBe(0);
  });

  it('a negative amount (never produced by a real, validated caller) is folded into the zero case, never negative output', () => {
    expect(exchangeOutput(config, 'scrap', 'fuel', -50)).toBe(0);
  });

  it('the function never returns a negative output for any positive amount', () => {
    for (const amount of [1, 10, 100, 1000, 999_999]) {
      expect(exchangeOutput(config, 'scrap', 'electronics', amount)).toBeGreaterThanOrEqual(0);
      expect(exchangeOutput(config, 'electronics', 'scrap', amount)).toBeGreaterThanOrEqual(0);
    }
  });

  it('does not round — the raw float survives (M1’s numeric convention: floored only for display)', () => {
    // 3 scrap * (1/1) * 0.75 = 2.25, not floored/rounded here.
    expect(exchangeOutput(config, 'scrap', 'fuel', 3)).toBeCloseTo(2.25, 9);
  });
});
