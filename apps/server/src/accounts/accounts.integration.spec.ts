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
import { Session } from '../schemas/session.schema';
import type { SessionDocument } from '../schemas/session.schema';

// Registration & faction choice (§13 of the M1 design record) against a real MongoDB
// replica set — same boot pattern as `health.integration.spec.ts`.
describe('Accounts (integration)', () => {
  let app: INestApplication;
  let replSet: MongoMemoryReplSet;
  let accountModel: Model<AccountDocument>;
  let sessionModel: Model<SessionDocument>;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    process.env['MONGODB_URI'] = replSet.getUri('last-signal-accounts-test');
    // This suite doesn't exercise NPC seeding — disabling it keeps boot fast and keeps the
    // `accounts` collection limited to the accounts this file itself creates.
    process.env['WORLD_NPC_COUNT'] = '0';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    // One stable listener for the whole file, bound explicitly to IPv4 loopback, so
    // `request(app.getHttpServer())` reuses it instead of supertest opening/closing its own
    // ephemeral `listen(0)` per request — that per-request churn let a foreign process's
    // IPv4-only bind on a recycled port shadow ours (observed: a foreign Express server on
    // 127.0.0.1:49915 answering `POST /api/auth/guest` with an unrelated 401/403/404). Do not
    // simplify this back to `app.init()` alone.
    await app.listen(0, '127.0.0.1');

    accountModel = moduleRef.get(getModelToken(Account.name));
    sessionModel = moduleRef.get(getModelToken(Session.name));
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await replSet.stop();
    delete process.env['MONGODB_URI'];
    delete process.env['WORLD_NPC_COUNT'];
  }, 60_000);

  afterEach(async () => {
    await Promise.all([accountModel.deleteMany({}), sessionModel.deleteMany({})]);
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

  function register(cookie: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/api/accounts/register')
      .set('Cookie', cookie)
      .send(body);
  }

  it('registration: happy path turns a guest into a named, factioned account', async () => {
    const { cookie, accountId } = await createGuestSession();

    const response = await register(cookie, { name: 'Wanderer', faction: 'raiders' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: accountId,
      name: 'Wanderer',
      isGuest: false,
      faction: 'raiders',
    });

    const stored = await accountModel.findById(accountId);
    expect(stored?.isGuest).toBe(false);
    expect(stored?.faction).toBe('raiders');
  });

  it('registration accepts an optional side', async () => {
    const { cookie } = await createGuestSession();

    const response = await register(cookie, {
      name: 'Signal Keeper',
      faction: 'nomads',
      side: 'beacon',
    });

    expect(response.status).toBe(200);
    expect(response.body.side).toBe('beacon');
  });

  it('duplicate name is rejected with errors.account.nameTaken', async () => {
    const first = await createGuestSession();
    const second = await createGuestSession();

    const firstResponse = await register(first.cookie, { name: 'TakenName', faction: 'raiders' });
    expect(firstResponse.status).toBe(200);

    const secondResponse = await register(second.cookie, {
      name: 'TakenName',
      faction: 'engineers',
    });
    expect(secondResponse.status).toBe(409);
    expect(secondResponse.body.error.key).toBe('errors.account.nameTaken');

    const secondStored = await accountModel.findById(second.accountId);
    expect(secondStored?.isGuest).toBe(true);
    expect(secondStored?.faction).toBeUndefined();
  });

  it('an invalid faction is rejected with errors.account.invalidFaction', async () => {
    const { cookie } = await createGuestSession();

    const response = await register(cookie, { name: 'Someone', faction: 'wizards' });

    expect(response.status).toBe(400);
    expect(response.body.error.key).toBe('errors.account.invalidFaction');
  });

  it('an invalid side is rejected with errors.account.invalidSide', async () => {
    const { cookie } = await createGuestSession();

    const response = await register(cookie, {
      name: 'Someone',
      faction: 'raiders',
      side: 'twilight',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.key).toBe('errors.account.invalidSide');
  });

  it('a too-short name is rejected with errors.account.invalidName', async () => {
    const { cookie } = await createGuestSession();

    const response = await register(cookie, { name: 'x', faction: 'raiders' });

    expect(response.status).toBe(400);
    expect(response.body.error.key).toBe('errors.account.invalidName');
  });

  it('double registration is rejected with errors.account.alreadyRegistered', async () => {
    const { cookie } = await createGuestSession();
    const first = await register(cookie, { name: 'OnceOnly', faction: 'raiders' });
    expect(first.status).toBe(200);

    const second = await register(cookie, { name: 'OnceOnly Again', faction: 'engineers' });

    expect(second.status).toBe(409);
    expect(second.body.error.key).toBe('errors.account.alreadyRegistered');
  });

  it('registration without a session cookie is 401', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/accounts/register')
      .send({ name: 'Nobody', faction: 'raiders' });

    expect(response.status).toBe(401);
    expect(response.body.error.key).toBe('errors.auth.notAuthenticated');
  });
});
