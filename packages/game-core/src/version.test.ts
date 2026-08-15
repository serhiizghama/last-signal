import { describe, expect, it } from 'vitest';
import { GAME_CORE_VERSION } from './version.js';

describe('GAME_CORE_VERSION', () => {
  it('is a semver-shaped string', () => {
    expect(GAME_CORE_VERSION).toBe('0.0.0');
    expect(GAME_CORE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
