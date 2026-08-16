import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Model } from 'mongoose';
import { io } from 'socket.io-client';
import type { Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../app.module';
import { SESSION_COOKIE_NAME } from '../auth/auth.constants';
import { Session } from '../schemas/session.schema';
import type { SessionDocument } from '../schemas/session.schema';
import { RealtimeGateway } from './realtime.gateway';

// Proves the M2b.4 gateway mechanics in isolation from any feature module: handshake auth
// (accepted with a real session cookie, rejected without one/with a bogus one/with an expired
// one) and per-account room isolation for the injectable `emitToAccount` API. The
// report-specific "reportArrived actually fires on a scouting arrival" scenario, which needs
// the full movements/scheduler machinery, lives in `reports/reports.integration.spec.ts`
// instead — this file only needs a socket and a session, so it stays deliberately small.
describe('Realtime gateway (integration)', () => {
  let app: INestApplication;
  let replSet: MongoMemoryReplSet;
  let moduleRef: TestingModule;
  let sessionModel: Model<SessionDocument>;
  let gateway: RealtimeGateway;
  let baseUrl: string;
  const openSockets: ClientSocket[] = [];

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    process.env['MONGODB_URI'] = replSet.getUri('last-signal-realtime-test');
    process.env['SCHEDULER_ENABLED'] = 'false';
    process.env['WORLD_NPC_COUNT'] = '0';

    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    // Unlike the REST-only integration specs, a real socket.io client needs an actual
    // listening TCP port to connect to — `supertest(app.getHttpServer())` manages its own
    // ephemeral listen internally, which is fine for HTTP alone, but a raw websocket upgrade
    // needs the server already bound. `supertest` is still used below for REST calls (guest
    // login) against this same, now-listening server.
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    sessionModel = moduleRef.get(getModelToken(Session.name));
    gateway = moduleRef.get(RealtimeGateway);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await replSet.stop();
    delete process.env['MONGODB_URI'];
    delete process.env['SCHEDULER_ENABLED'];
    delete process.env['WORLD_NPC_COUNT'];
  }, 60_000);

  afterEach(async () => {
    for (const socket of openSockets.splice(0)) {
      socket.disconnect();
    }
    await sessionModel.deleteMany({});
  });

  interface GuestSession {
    accountId: string;
    cookieHeader: string;
  }

  // A fresh guest account + session via the real `POST /api/auth/guest` endpoint, reduced to
  // the one raw `name=value` pair the gateway's handshake cookie parser expects — the
  // `Set-Cookie` response header carries extra attributes (`Path`, `HttpOnly`, ...) a plain
  // `Cookie` request header never repeats.
  async function createGuestSession(): Promise<GuestSession> {
    const response = await request(app.getHttpServer()).post('/api/auth/guest').send({});
    expect(response.status).toBe(201);
    const setCookie = (response.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith(`${SESSION_COOKIE_NAME}=`),
    );
    expect(setCookie).toBeDefined();
    if (!setCookie) throw new Error('unreachable');
    return {
      accountId: response.body.id as string,
      cookieHeader: setCookie.split(';')[0] as string,
    };
  }

  // Connects a raw socket.io-client against the real listening server, over the websocket
  // transport only (no polling fallback — keeps the handshake to exactly one HTTP request,
  // whose headers this helper controls directly, same convention as `extraHeaders` below).
  function connect(cookieHeader?: string): ClientSocket {
    const socket = io(baseUrl, {
      path: '/ws',
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      extraHeaders: cookieHeader ? { Cookie: cookieHeader } : {},
    });
    openSockets.push(socket);
    return socket;
  }

  function waitForEvent<T = unknown>(
    socket: ClientSocket,
    event: string,
    timeoutMs = 4_000,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting for "${event}"`));
      }, timeoutMs);
      socket.once(event, (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  }

  it('handshake: a valid session cookie connects successfully', async () => {
    const guest = await createGuestSession();
    const socket = connect(guest.cookieHeader);
    await waitForEvent(socket, 'connect');
    expect(socket.connected).toBe(true);
  });

  it('handshake: no cookie at all is rejected (connect_error, never connect)', async () => {
    const socket = connect();
    const error = await waitForEvent<Error>(socket, 'connect_error');
    expect(error).toBeDefined();
    expect(socket.connected).toBe(false);
  });

  it('handshake: a bogus/unknown session id is rejected', async () => {
    const socket = connect(`${SESSION_COOKIE_NAME}=not-a-real-session-id`);
    const error = await waitForEvent<Error>(socket, 'connect_error');
    expect(error).toBeDefined();
    expect(socket.connected).toBe(false);
  });

  it('handshake: an expired session is rejected', async () => {
    const guest = await createGuestSession();
    // Same technique `auth.integration.spec.ts` would use for an expired cookie: backdate
    // the session's own `expiresAt` directly rather than waiting out the real TTL.
    await sessionModel.updateOne(
      { accountId: guest.accountId },
      { $set: { expiresAt: new Date(Date.now() - 1_000) } },
    );

    const socket = connect(guest.cookieHeader);
    const error = await waitForEvent<Error>(socket, 'connect_error');
    expect(error).toBeDefined();
    expect(socket.connected).toBe(false);
  });

  it('emitToAccount: reaches every socket for the target account (multiple tabs), never a stranger', async () => {
    const accountA = await createGuestSession();
    const accountB = await createGuestSession();

    const aTabOne = connect(accountA.cookieHeader);
    const aTabTwo = connect(accountA.cookieHeader);
    const bTab = connect(accountB.cookieHeader);
    await Promise.all([
      waitForEvent(aTabOne, 'connect'),
      waitForEvent(aTabTwo, 'connect'),
      waitForEvent(bTab, 'connect'),
    ]);

    const bGotSomething: unknown[] = [];
    bTab.on('testEvent', (payload: unknown) => bGotSomething.push(payload));

    const payload = { hello: 'accountA' };
    gateway.emitToAccount(accountA.accountId, 'testEvent', payload);

    const [receivedOne, receivedTwo] = await Promise.all([
      waitForEvent(aTabOne, 'testEvent'),
      waitForEvent(aTabTwo, 'testEvent'),
    ]);
    expect(receivedOne).toEqual(payload);
    expect(receivedTwo).toEqual(payload);

    // Give account B's socket a fair chance to (wrongly) receive the same push before
    // asserting it never did.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(bGotSomething).toEqual([]);
  });
});
