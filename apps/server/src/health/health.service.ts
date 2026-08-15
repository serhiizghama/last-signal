import { performance } from 'node:perf_hooks';

import { GAME_CORE_VERSION } from '@last-signal/game-core';
import { Injectable } from '@nestjs/common';

export interface HealthStatus {
  status: 'ok';
  serverTime: number;
  uptimeMs: number;
  version: string;
  gameCoreVersion: string;
}

const SERVER_VERSION = process.env['npm_package_version'] ?? '0.0.0';

@Injectable()
export class HealthService {
  // Monotonic clock reading captured at construction, used to derive uptimeMs
  // without being affected by wall-clock adjustments.
  private readonly startedAt: number = performance.now();

  getHealth(): HealthStatus {
    return {
      status: 'ok',
      serverTime: Date.now(),
      uptimeMs: Math.round(performance.now() - this.startedAt),
      version: SERVER_VERSION,
      gameCoreVersion: GAME_CORE_VERSION,
    };
  }
}
