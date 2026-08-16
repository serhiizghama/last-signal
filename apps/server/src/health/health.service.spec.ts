import { GAME_CORE_VERSION } from '@last-signal/game-core';
import type { Connection } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { HealthService } from './health.service';

// A real Mongoose Connection is exercised in health.integration.spec.ts
// against an in-memory replica set; this unit test only needs `readyState`.
function fakeConnection(readyState: number): Connection {
  return { readyState } as unknown as Connection;
}

describe('HealthService', () => {
  it('returns a well-formed health status when the database is connected', () => {
    const service = new HealthService(fakeConnection(1));
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
    expect(health.db).toBe('up');
  });

  it('reports db as down when the connection is not ready', () => {
    const service = new HealthService(fakeConnection(0));

    expect(service.getHealth().db).toBe('down');
  });
});
