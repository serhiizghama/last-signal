import { GAME_CORE_VERSION } from '@last-signal/game-core';
import { describe, expect, it } from 'vitest';

import { HealthService } from './health.service';

describe('HealthService', () => {
  it('returns a well-formed health status', () => {
    const service = new HealthService();
    const before = Date.now();
    const health = service.getHealth();
    const after = Date.now();

    expect(health.status).toBe('ok');
    expect(Number.isFinite(health.serverTime)).toBe(true);
    expect(health.serverTime).toBeGreaterThanOrEqual(before);
    expect(health.serverTime).toBeLessThanOrEqual(after);
    expect(health.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(health.uptimeMs)).toBe(true);
    expect(health.gameCoreVersion).toBe(GAME_CORE_VERSION);
    expect(typeof health.version).toBe('string');
  });
});
