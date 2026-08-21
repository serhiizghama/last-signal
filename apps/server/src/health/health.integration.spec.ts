import { GAME_CORE_VERSION } from '@last-signal/game-core';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../app.module';

// A real one-node replica set, exactly like docker-compose.yml's dev Mongo —
// AppModule now wires up DatabaseModule, so booting it needs somewhere to
// connect. `MONGODB_URI` is read by ConfigService, same as at runtime.
describe('Health (integration)', () => {
  let app: INestApplication;
  let replSet: MongoMemoryReplSet;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    process.env['MONGODB_URI'] = replSet.getUri('last-signal-health-test');
    // This suite doesn't exercise NPC seeding — disabling it keeps boot fast.
    process.env['WORLD_NPC_COUNT'] = '0';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    // Explicit IPv4-bound single listener — avoids ephemeral-port collisions with other
    // local processes; see `accounts.integration.spec.ts`'s beforeAll for why this matters.
    await app.listen(0, '127.0.0.1');
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await replSet.stop();
    delete process.env['MONGODB_URI'];
    delete process.env['WORLD_NPC_COUNT'];
  }, 60_000);

  it('GET /api/health returns 200 with the expected shape', async () => {
    const response = await request(app.getHttpServer()).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'ok',
      gameCoreVersion: GAME_CORE_VERSION,
      db: 'up',
    });
    expect(typeof response.body.serverTime).toBe('number');
    expect(typeof response.body.uptimeMs).toBe('number');
    expect(typeof response.body.version).toBe('string');
  });

  it('GET /health without the api prefix returns 404', async () => {
    const response = await request(app.getHttpServer()).get('/health');

    expect(response.status).toBe(404);
  });
});
