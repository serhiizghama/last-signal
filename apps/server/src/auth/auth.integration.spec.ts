import type { INestApplication } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
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
import { SESSION_COOKIE_NAME } from './auth.constants';

// Guest auth + sessions end to end (§13 of the M1 design record) against a real MongoDB
// replica set — same boot pattern as `health.integration.spec.ts`.
describe('Auth (integration)', () => {
  let app: INestApplication;
  let replSet: MongoMemoryReplSet;
  let accountModel: Model<AccountDocument>;
  let sessionModel: Model<SessionDocument>;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    process.env['MONGODB_URI'] = replSet.getUri('last-signal-auth-test');
    // This suite doesn't exercise NPC seeding — disabling it keeps boot fast and keeps the
    // `accounts` collection limited to the accounts this file itself creates.
    process.env['WORLD_NPC_COUNT'] = '0';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();

    accountModel = moduleRef.get(getModelToken(Account.name));
    sessionModel = moduleRef.get(getModelToken(Session.name));
    // Referenced only to prove the DI wiring resolves cleanly end to end; no direct use.
    void moduleRef.get(getConnectionToken());
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

  function extractSessionCookie(setCookieHeader: unknown): string {
    const cookies = setCookieHeader as string[];
    const sessionCookie = cookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
    expect(sessionCookie).toBeDefined();
    if (!sessionCookie) throw new Error('unreachable');
    return sessionCookie;
  }

  it('guest login sets an httpOnly cookie and GET /api/auth/me then works', async () => {
    const guestResponse = await request(app.getHttpServer()).post('/api/auth/guest').send({});

    expect(guestResponse.status).toBe(201);
    expect(guestResponse.body.isGuest).toBe(true);
    expect(typeof guestResponse.body.id).toBe('string');
    // Never the raw session id in the body — it only ever travels as the cookie.
    expect(guestResponse.body.sessionId).toBeUndefined();

    const setCookie = guestResponse.headers['set-cookie'] as unknown as string[];
    expect(setCookie).toBeDefined();
    const sessionCookie = extractSessionCookie(setCookie);
    expect(sessionCookie).toMatch(/HttpOnly/i);
    expect(sessionCookie).toMatch(/SameSite=Lax/i);

    const meResponse = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Cookie', sessionCookie);

    expect(meResponse.status).toBe(200);
    expect(meResponse.body.id).toBe(guestResponse.body.id);
    expect(meResponse.body.isGuest).toBe(true);
  });

  it('GET /api/auth/me without a cookie is 401 with errors.auth.notAuthenticated', async () => {
    const response = await request(app.getHttpServer()).get('/api/auth/me');

    expect(response.status).toBe(401);
    expect(response.body.error.key).toBe('errors.auth.notAuthenticated');
  });

  it('GET /api/auth/me with an unknown session cookie is 401', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Cookie', `${SESSION_COOKIE_NAME}=not-a-real-session-id`);

    expect(response.status).toBe(401);
    expect(response.body.error.key).toBe('errors.auth.notAuthenticated');
  });

  it('session revocation: deleting the session document immediately invalidates it', async () => {
    const guestResponse = await request(app.getHttpServer()).post('/api/auth/guest').send({});
    const sessionCookie = extractSessionCookie(guestResponse.headers['set-cookie']);

    const before = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Cookie', sessionCookie);
    expect(before.status).toBe(200);

    // Simulates an admin/system revoking the session out from under its owner — deletion
    // is what makes revocation immediate (see `Session`'s schema comment), not waiting for
    // the TTL sweep.
    await sessionModel.deleteMany({});

    const after = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Cookie', sessionCookie);
    expect(after.status).toBe(401);
    expect(after.body.error.key).toBe('errors.auth.notAuthenticated');
  });

  it('logout clears the session server-side and the cookie', async () => {
    const guestResponse = await request(app.getHttpServer()).post('/api/auth/guest').send({});
    const sessionCookie = extractSessionCookie(guestResponse.headers['set-cookie']);
    const accountId = guestResponse.body.id as string;

    const sessionBefore = await sessionModel.findOne({ accountId });
    expect(sessionBefore).not.toBeNull();

    const logoutResponse = await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Cookie', sessionCookie);
    expect(logoutResponse.status).toBe(200);
    const clearedCookie = (logoutResponse.headers['set-cookie'] as unknown as string[])?.find((c) =>
      c.startsWith(`${SESSION_COOKIE_NAME}=`),
    );
    expect(clearedCookie).toBeDefined();

    const sessionAfter = await sessionModel.findOne({ accountId });
    expect(sessionAfter).toBeNull();

    const meAfterLogout = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Cookie', sessionCookie);
    expect(meAfterLogout.status).toBe(401);
  });

  it('logout with no cookie is a harmless no-op', async () => {
    const response = await request(app.getHttpServer()).post('/api/auth/logout');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });
});
