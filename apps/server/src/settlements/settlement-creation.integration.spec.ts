import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Model } from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../app.module';
import { Account } from '../schemas/account.schema';
import type { AccountDocument } from '../schemas/account.schema';
import { PlacementCounter } from '../schemas/placement-counter.schema';
import type { PlacementCounterDocument } from '../schemas/placement-counter.schema';
import { Session } from '../schemas/session.schema';
import type { SessionDocument } from '../schemas/session.schema';
import { Settlement } from '../schemas/settlement.schema';
import type { SettlementDocument } from '../schemas/settlement.schema';
import { STARTING_RESOURCES } from './settlements.constants';

// `POST /api/settlements` end to end: real outer-ring placement (§14 of the M1 design
// record), the Influence-gated settlement limit (§7 — M1b only ever exercises "first
// settlement always allowed" / "second rejected"), and — the headline acceptance criterion
// for the whole M1b milestone — a fresh account registering, picking a faction, and getting
// a settlement, entirely through the API.
describe('Settlement creation (integration)', () => {
  let app: INestApplication;
  let replSet: MongoMemoryReplSet;
  let accountModel: Model<AccountDocument>;
  let settlementModel: Model<SettlementDocument>;
  let sessionModel: Model<SessionDocument>;
  let placementCounterModel: Model<PlacementCounterDocument>;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    process.env['MONGODB_URI'] = replSet.getUri('last-signal-settlement-creation-test');

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();

    accountModel = moduleRef.get(getModelToken(Account.name));
    settlementModel = moduleRef.get(getModelToken(Settlement.name));
    sessionModel = moduleRef.get(getModelToken(Session.name));
    placementCounterModel = moduleRef.get(getModelToken(PlacementCounter.name));
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await replSet.stop();
    delete process.env['MONGODB_URI'];
  }, 60_000);

  afterEach(async () => {
    await Promise.all([
      accountModel.deleteMany({}),
      settlementModel.deleteMany({}),
      sessionModel.deleteMany({}),
      placementCounterModel.deleteMany({}),
    ]);
  });

  interface GuestSession {
    cookie: string;
    accountId: string;
  }

  async function createGuestSession(): Promise<GuestSession> {
    const response = await request(app.getHttpServer()).post('/api/auth/guest').send({});
    const cookies = response.headers['set-cookie'] as unknown as string[];
    const cookie = cookies.find((c) => c.startsWith('lsSession='));
    expect(cookie).toBeDefined();
    if (!cookie) throw new Error('unreachable');
    return { cookie, accountId: response.body.id as string };
  }

  function createSettlement(cookie: string) {
    return request(app.getHttpServer()).post('/api/settlements').set('Cookie', cookie);
  }

  it('happy path: on-grid coordinates, a level-1 Command Center, resources initialised', async () => {
    const { cookie } = await createGuestSession();

    const response = await createSettlement(cookie);

    expect(response.status).toBe(201);
    expect(response.body.x).toBeGreaterThanOrEqual(-30);
    expect(response.body.x).toBeLessThanOrEqual(30);
    expect(response.body.y).toBeGreaterThanOrEqual(-30);
    expect(response.body.y).toBeLessThanOrEqual(30);
    expect(response.body.buildings).toEqual([
      expect.objectContaining({ type: 'commandCenter', level: 1, slot: 0 }),
    ]);
    expect(response.body.resources.values).toEqual(STARTING_RESOURCES);
  });

  it('a second settlement attempt is rejected with errors.settlement.limitReached', async () => {
    const { cookie } = await createGuestSession();

    const first = await createSettlement(cookie);
    expect(first.status).toBe(201);

    const second = await createSettlement(cookie);
    expect(second.status).toBe(409);
    expect(second.body.error.key).toBe('errors.settlement.limitReached');

    const stored = await settlementModel.find({});
    expect(stored).toHaveLength(1);
  });

  it('two accounts never collide on the same tile even under a forced placement collision', async () => {
    const first = await createGuestSession();
    const firstSettlement = await createSettlement(first.cookie);
    expect(firstSettlement.status).toBe(201);

    // Forces the very next placement candidate to collide with the tile just allocated
    // above, by rewinding the shared counter back to the value that produced it — proving
    // the collision-retry path (the unique `{x,y}` index is the ultimate authority: on a
    // duplicate-key collision, advance to the next candidate and retry) rather than relying
    // on luck to ever exercise it.
    await placementCounterModel.updateOne({}, { $inc: { value: -1 } });

    const second = await createGuestSession();
    const secondSettlement = await createSettlement(second.cookie);

    expect(secondSettlement.status).toBe(201);
    expect(
      secondSettlement.body.x === firstSettlement.body.x &&
        secondSettlement.body.y === firstSettlement.body.y,
    ).toBe(false);

    const allSettlements = await settlementModel.find({});
    const tileKeys = allSettlements.map((s) => `${s.x},${s.y}`);
    expect(new Set(tileKeys).size).toBe(tileKeys.length);
  });

  it('unauthenticated creation is rejected with errors.auth.notAuthenticated', async () => {
    const response = await request(app.getHttpServer()).post('/api/settlements').send({});
    expect(response.status).toBe(401);
    expect(response.body.error.key).toBe('errors.auth.notAuthenticated');
  });

  it('GET /api/settlements/mine returns only the caller own settlements', async () => {
    const owner = await createGuestSession();
    const other = await createGuestSession();
    const created = await createSettlement(owner.cookie);
    expect(created.status).toBe(201);
    await createSettlement(other.cookie);

    const mine = await request(app.getHttpServer())
      .get('/api/settlements/mine')
      .set('Cookie', owner.cookie);

    expect(mine.status).toBe(200);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0].id).toBe(created.body.id);
  });

  // The M1b acceptance criterion, verbatim: "a fresh account can register, pick a faction,
  // and get a settlement, entirely through the API."
  it('acceptance path: guest -> register with faction -> create settlement -> read it back', async () => {
    const guestResponse = await request(app.getHttpServer()).post('/api/auth/guest').send({});
    expect(guestResponse.status).toBe(201);
    const cookies = guestResponse.headers['set-cookie'] as unknown as string[];
    const cookie = cookies.find((c) => c.startsWith('lsSession='));
    expect(cookie).toBeDefined();
    if (!cookie) throw new Error('unreachable');

    const registerResponse = await request(app.getHttpServer())
      .post('/api/accounts/register')
      .set('Cookie', cookie)
      .send({ name: 'Acceptance Traveller', faction: 'engineers', side: 'silence' });
    expect(registerResponse.status).toBe(200);
    expect(registerResponse.body).toMatchObject({
      name: 'Acceptance Traveller',
      isGuest: false,
      faction: 'engineers',
      side: 'silence',
    });

    const createResponse = await request(app.getHttpServer())
      .post('/api/settlements')
      .set('Cookie', cookie);
    expect(createResponse.status).toBe(201);
    expect(createResponse.body.buildings).toEqual([
      expect.objectContaining({ type: 'commandCenter', level: 1 }),
    ]);

    const readBackResponse = await request(app.getHttpServer())
      .get(`/api/settlements/${createResponse.body.id}`)
      .set('Cookie', cookie);
    expect(readBackResponse.status).toBe(200);
    expect(readBackResponse.body.id).toBe(createResponse.body.id);
    expect(readBackResponse.body.x).toBeGreaterThanOrEqual(-30);
    expect(readBackResponse.body.x).toBeLessThanOrEqual(30);
    expect(readBackResponse.body.y).toBeGreaterThanOrEqual(-30);
    expect(readBackResponse.body.y).toBeLessThanOrEqual(30);
  });
});
