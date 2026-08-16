import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Model } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../app.module';
import type { AccountDocument } from '../schemas/account.schema';
import { Account } from '../schemas/account.schema';
import type { OasisDocument } from '../schemas/oasis.schema';
import { Oasis } from '../schemas/oasis.schema';
import type { SettlementDocument } from '../schemas/settlement.schema';
import { Settlement } from '../schemas/settlement.schema';
import type { WorldDocument } from '../schemas/world.schema';
import { World } from '../schemas/world.schema';

// `GET /api/map` (M2a.6, `docs/M2_DESIGN_DECISIONS.md` §5) against a real MongoDB replica set —
// same whole-`AppModule`-over-HTTP boot pattern as `world/world.integration.spec.ts` and
// `npc/npc-seeder.integration.spec.ts`.
describe('GET /api/map (integration)', () => {
  let app: INestApplication;
  let replSet: MongoMemoryReplSet;
  let worldModel: Model<WorldDocument>;
  let oasisModel: Model<OasisDocument>;
  let settlementModel: Model<SettlementDocument>;
  let accountModel: Model<AccountDocument>;

  let humanCookie: string;
  let humanAccountId: string;
  let humanSettlement: { id: string; x: number; y: number; name: string };

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    process.env['MONGODB_URI'] = replSet.getUri('last-signal-map-test');
    // A small, real NPC population — not 0 — because the indistinguishability assertion below
    // needs at least one NPC settlement seeded through the actual `NpcSeederService`. 2 is
    // enough for that while keeping `app.init()` fast; every other spec that wants zero seeding
    // noise sets this to '0' instead (see each of their own comments).
    process.env['WORLD_NPC_COUNT'] = '2';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    // Bootstraps the world + oases and seeds the 2 NPCs as a side effect, exactly like a real
    // fresh boot.
    await app.init();

    worldModel = moduleRef.get(getModelToken(World.name));
    oasisModel = moduleRef.get(getModelToken(Oasis.name));
    settlementModel = moduleRef.get(getModelToken(Settlement.name));
    accountModel = moduleRef.get(getModelToken(Account.name));

    // One real, registered human settlement (so faction/side are actually set — see
    // `MapSettlementView`'s comment on why they're optional in general) to exercise the
    // owner-join path end to end.
    const guestResponse = await request(app.getHttpServer()).post('/api/auth/guest').send({});
    const guestCookies = guestResponse.headers['set-cookie'] as unknown as string[];
    const cookie = guestCookies.find((c) => c.startsWith('lsSession='));
    if (!cookie) throw new Error('unreachable');
    humanCookie = cookie;
    humanAccountId = guestResponse.body.id as string;

    await request(app.getHttpServer())
      .post('/api/accounts/register')
      .set('Cookie', humanCookie)
      .send({ name: 'Map Tester', faction: 'raiders', side: 'beacon' });

    const createResponse = await request(app.getHttpServer())
      .post('/api/settlements')
      .set('Cookie', humanCookie);
    humanSettlement = {
      id: createResponse.body.id as string,
      x: createResponse.body.x as number,
      y: createResponse.body.y as number,
      name: createResponse.body.name as string,
    };
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await replSet.stop();
    delete process.env['MONGODB_URI'];
    delete process.env['WORLD_NPC_COUNT'];
  }, 60_000);

  it('unauthenticated access is rejected with errors.auth.notAuthenticated', async () => {
    const response = await request(app.getHttpServer()).get('/api/map');
    expect(response.status).toBe(401);
    expect(response.body.error.key).toBe('errors.auth.notAuthenticated');
  });

  it('the world header carries the stored seed, round and act, plus a server time', async () => {
    const world = await worldModel.findOne({});
    const before = Date.now();
    const response = await request(app.getHttpServer()).get('/api/map').set('Cookie', humanCookie);
    const after = Date.now();

    expect(response.status).toBe(200);
    expect(response.body.world.seed).toBe(world!.seed);
    expect(response.body.world.roundNumber).toBe(world!.roundNumber);
    expect(response.body.world.act).toBe(world!.act);
    expect(typeof response.body.world.serverTime).toBe('number');
    expect(response.body.world.serverTime).toBeGreaterThanOrEqual(before);
    expect(response.body.world.serverTime).toBeLessThanOrEqual(after);
  });

  it('every seeded settlement appears with exactly the public fields, and the payload leaks none of resources/buildings/buildQueue/troops/isNpc/version', async () => {
    const response = await request(app.getHttpServer()).get('/api/map').set('Cookie', humanCookie);
    expect(response.status).toBe(200);

    const totalSettlements = await settlementModel.countDocuments({});
    expect(response.body.settlements).toHaveLength(totalSettlements);

    const humanEntry = response.body.settlements.find(
      (s: { id: string }) => s.id === humanSettlement.id,
    );
    expect(humanEntry).toEqual({
      id: humanSettlement.id,
      x: humanSettlement.x,
      y: humanSettlement.y,
      name: humanSettlement.name,
      ownerAccountId: humanAccountId,
      ownerName: 'Map Tester',
      ownerFaction: 'raiders',
      ownerSide: 'beacon',
    });

    // Guards against a serialization leak specifically (a field present on the Mongoose
    // document but accidentally spread/forwarded into the response), not just against the
    // typed `MapSettlementView` shape being clean — see `toPlainResources`'s comment in
    // `settlements.view.ts` for why that distinction matters.
    const serialized = JSON.stringify(response.body);
    for (const leakedField of [
      'resources',
      'buildings',
      'buildQueue',
      'troops',
      'isNpc',
      'version',
    ]) {
      expect(serialized).not.toContain(leakedField);
    }
  });

  it('all oases appear with coordinates and type, and the payload carries no terrain', async () => {
    const response = await request(app.getHttpServer()).get('/api/map').set('Cookie', humanCookie);
    expect(response.status).toBe(200);

    const oases = await oasisModel.find({});
    expect(oases.length).toBeGreaterThan(0);
    expect(response.body.oases).toHaveLength(oases.length);
    for (const oasis of response.body.oases as Array<Record<string, unknown>>) {
      expect(Object.keys(oasis).sort()).toEqual(['type', 'x', 'y']);
      expect(oasis['type']).toBe('farm');
    }
    expect(JSON.stringify(response.body)).not.toContain('terrain');
  });

  it('an NPC-seeded settlement is indistinguishable from a human one: identical key set, no marker', async () => {
    const npcAccounts = await accountModel.find({ isNpc: true });
    expect(npcAccounts.length).toBeGreaterThan(0);
    const npcSettlement = await settlementModel.findOne({
      accountId: { $in: npcAccounts.map((a) => a._id) },
    });
    expect(npcSettlement).not.toBeNull();

    const response = await request(app.getHttpServer()).get('/api/map').set('Cookie', humanCookie);
    const npcEntry = response.body.settlements.find(
      (s: { id: string }) => s.id === String(npcSettlement!._id),
    );
    const humanEntry = response.body.settlements.find(
      (s: { id: string }) => s.id === humanSettlement.id,
    );
    expect(npcEntry).toBeDefined();
    expect(Object.keys(npcEntry).sort()).toEqual(Object.keys(humanEntry).sort());
  });

  it('a settlement created after the first call shows up on the next call (no stale server-side caching)', async () => {
    const before = await request(app.getHttpServer()).get('/api/map').set('Cookie', humanCookie);
    const beforeIds = new Set(before.body.settlements.map((s: { id: string }) => s.id));

    const guestResponse = await request(app.getHttpServer()).post('/api/auth/guest').send({});
    const guestCookies = guestResponse.headers['set-cookie'] as unknown as string[];
    const cookie = guestCookies.find((c) => c.startsWith('lsSession='));
    if (!cookie) throw new Error('unreachable');
    const createResponse = await request(app.getHttpServer())
      .post('/api/settlements')
      .set('Cookie', cookie);
    expect(createResponse.status).toBe(201);
    const newId = createResponse.body.id as string;
    expect(beforeIds.has(newId)).toBe(false);

    const after = await request(app.getHttpServer()).get('/api/map').set('Cookie', humanCookie);
    const afterIds = new Set(after.body.settlements.map((s: { id: string }) => s.id));
    expect(afterIds.has(newId)).toBe(true);
    expect(after.body.settlements).toHaveLength(before.body.settlements.length + 1);
  });
});
