import { performance } from 'node:perf_hooks';

import { GAME_CORE_VERSION } from '@last-signal/game-core';
import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';

import { SERVER_VERSION } from '../version';

export type DbStatus = 'up' | 'down';

export interface HealthStatus {
  status: 'ok';
  serverTime: number;
  uptimeMs: number;
  version: string;
  gameCoreVersion: string;
  db: DbStatus;
}

// Mongoose connection `readyState`: 0 disconnected, 1 connected,
// 2 connecting, 3 disconnecting.
const MONGOOSE_READY_STATE_CONNECTED = 1;

@Injectable()
export class HealthService {
  // Monotonic clock reading captured at construction, used to derive uptimeMs
  // without being affected by wall-clock adjustments.
  private readonly startedAt: number = performance.now();

  // Explicit @Inject-based decorator (InjectConnection wraps @Inject with a
  // resolved token), so this does not depend on emitted design:paramtypes
  // metadata — same reasoning as HealthController's @Inject(HealthService).
  constructor(@InjectConnection() private readonly connection: Connection) {}

  getHealth(): HealthStatus {
    return {
      status: 'ok',
      serverTime: Date.now(),
      uptimeMs: Math.round(performance.now() - this.startedAt),
      version: SERVER_VERSION,
      gameCoreVersion: GAME_CORE_VERSION,
      db: this.connection.readyState === MONGOOSE_READY_STATE_CONNECTED ? 'up' : 'down',
    };
  }
}
