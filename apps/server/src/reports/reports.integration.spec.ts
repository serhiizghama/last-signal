import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import { io } from 'socket.io-client';
import type { Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../app.module';
import { Account } from '../schemas/account.schema';
import type { AccountDocument } from '../schemas/account.schema';
import { GameEvent } from '../schemas/event.schema';
import type { GameEventDocument } from '../schemas/event.schema';
import { Movement } from '../schemas/movement.schema';
import type { MovementDocument } from '../schemas/movement.schema';
import type { ReportType } from '../schemas/report.schema';
import { Report } from '../schemas/report.schema';
import type { ReportDocument } from '../schemas/report.schema';
import { Settlement } from '../schemas/settlement.schema';
import type { SettlementDocument } from '../schemas/settlement.schema';
import { SchedulerService } from '../scheduler/scheduler.service';
import { SESSION_COOKIE_NAME } from '../auth/auth.constants';

// Proves the M2b.4 reports API end to end against a real MongoDB replica set: listing +
// cursor pagination + unread count (REST only, seeded directly via the model — no need to
// drive the whole movements/scheduler machinery just to get rows into the `reports`
// collection), read-on-open, ownership/auth, and — needing the real scout-arrival flow — the
// `reportArrived` WS push and its commit-ordering guarantee. Follows
// `movements.integration.spec.ts`'s conventions (whole `AppModule`, `MongoMemoryReplSet`,
// `SCHEDULER_ENABLED=false` + manual `runOnce()`) for the scenarios that need them.
describe('Reports (integration)', () => {
  let app: INestApplication;
  let replSet: MongoMemoryReplSet;
  let moduleRef: TestingModule;
  let accountModel: Model<AccountDocument>;
  let settlementModel: Model<SettlementDocument>;
  let movementModel: Model<MovementDocument>;
  let reportModel: Model<ReportDocument>;
  let eventModel: Model<GameEventDocument>;
  let schedulerService: SchedulerService;
  let baseUrl: string;
  const openSockets: ClientSocket[] = [];

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    process.env['MONGODB_URI'] = replSet.getUri('last-signal-reports-test');
    process.env['SCHEDULER_ENABLED'] = 'false';
    process.env['WORLD_NPC_COUNT'] = '0';

    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    // The WS scenarios below need a real listening port — see `realtime.integration.spec.ts`
    // for why `supertest(app.getHttpServer())` alone (used for every REST call here too)
    // isn't enough for a raw websocket upgrade. Binding `127.0.0.1` explicitly (not just
    // `listen(0)`) matters too — see `accounts.integration.spec.ts`'s beforeAll for why.
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    accountModel = moduleRef.get(getModelToken(Account.name));
    settlementModel = moduleRef.get(getModelToken(Settlement.name));
    movementModel = moduleRef.get(getModelToken(Movement.name));
    reportModel = moduleRef.get(getModelToken(Report.name));
    eventModel = moduleRef.get(getModelToken(GameEvent.name));
    schedulerService = moduleRef.get(SchedulerService);
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
    await Promise.all([
      accountModel.deleteMany({}),
      settlementModel.deleteMany({}),
      movementModel.deleteMany({}),
      reportModel.deleteMany({}),
      eventModel.deleteMany({}),
    ]);
  });

  interface GuestSession {
    accountId: Types.ObjectId;
    cookie: string[];
    cookieHeader: string;
  }

  async function createGuestSession(): Promise<GuestSession> {
    const response = await request(app.getHttpServer()).post('/api/auth/guest').send({});
    expect(response.status).toBe(201);
    const setCookie = response.headers['set-cookie'] as unknown as string[];
    expect(setCookie).toBeDefined();
    const sessionCookie = setCookie.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
    if (!sessionCookie) throw new Error('unreachable');
    return {
      accountId: new Types.ObjectId(response.body.id as string),
      cookie: setCookie,
      cookieHeader: sessionCookie.split(';')[0] as string,
    };
  }

  function getReports(cookie: string[], query: Record<string, string> = {}) {
    return request(app.getHttpServer()).get('/api/reports').set('Cookie', cookie).query(query);
  }

  function getReport(cookie: string[], id: string) {
    return request(app.getHttpServer()).get(`/api/reports/${id}`).set('Cookie', cookie);
  }

  interface SeededReport {
    _id: Types.ObjectId;
    accountId: Types.ObjectId;
    type: ReportType;
    read: boolean;
    payload: Record<string, unknown>;
    createdAt: number;
    updatedAt: number;
  }

  // Raw driver `insertMany` (via `Model.collection`, bypassing Mongoose's own casting/
  // timestamps middleware) so this fixture controls `createdAt` — and hence sort order —
  // exactly, rather than depending on real wall-clock spacing between sequential `create()`
  // calls, which is both slow and non-deterministic at millisecond resolution.
  async function seedReports(
    accountId: Types.ObjectId,
    entries: ReadonlyArray<{ createdAt: number; read?: boolean; type?: ReportType }>,
  ): Promise<SeededReport[]> {
    const now = Date.now();
    const docs: SeededReport[] = entries.map((entry) => ({
      _id: new Types.ObjectId(),
      accountId,
      type: entry.type ?? 'scout',
      read: entry.read ?? false,
      payload: { note: 'seeded-for-test' },
      createdAt: entry.createdAt,
      updatedAt: now,
    }));
    await reportModel.collection.insertMany(docs);
    return docs;
  }

  it('listing: newest-first, paginates through 3+ pages via the cursor with no gaps or duplicates, never leaks another account', async () => {
    const owner = await createGuestSession();
    const stranger = await createGuestSession();

    const base = Date.now();
    // 45 rows at the default limit (20) needs exactly 3 pages (20 + 20 + 5). Two entries
    // deliberately share the same `createdAt` (indices 10 and 11) — plausible in practice
    // (an attacker's report and the defender's counter-report land in the same transaction,
    // at the same `Date.now()` read) and exactly what the `{createdAt: -1, _id: -1}` index's
    // `_id` tiebreak exists to resolve without skipping or repeating a row.
    const entries: Array<{ createdAt: number; read: boolean }> = Array.from(
      { length: 45 },
      (_, i) => ({ createdAt: base - i * 1_000, read: i % 3 === 0 }),
    );
    const tenth = entries[10];
    const eleventh = entries[11];
    if (!tenth || !eleventh) throw new Error('unreachable');
    entries[11] = { createdAt: tenth.createdAt, read: eleventh.read };

    const seeded = await seedReports(owner.accountId, entries);
    await seedReports(stranger.accountId, [{ createdAt: base, read: false }]);

    const expectedUnread = entries.filter((e) => !e.read).length;

    // The full, stable sort order this account's paginated walk must reproduce exactly —
    // computed independently of `ReportsService`'s own implementation, from the same rule
    // its comment documents (`createdAt` desc, `_id` desc tiebreak).
    const expectedOrderIds = [...seeded]
      .sort((a, b) => {
        if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
        return String(a._id) < String(b._id) ? 1 : -1;
      })
      .map((doc) => String(doc._id));

    const collectedIds: string[] = [];
    let cursor: string | undefined;
    let pageCount = 0;
    let unreadFromFirstPage = -1;
    for (;;) {
      const response = await getReports(owner.cookie, cursor ? { cursor } : {});
      expect(response.status).toBe(200);
      pageCount += 1;
      if (pageCount === 1) {
        expect(response.body.reports).toHaveLength(20);
        unreadFromFirstPage = response.body.unreadCount as number;
      }
      const pageIds = (response.body.reports as Array<{ id: string }>).map((r) => r.id);
      collectedIds.push(...pageIds);
      cursor = response.body.nextCursor ?? undefined;
      if (!cursor) break;
      expect(pageCount).toBeLessThan(10); // guards against a pathological infinite loop
    }

    expect(pageCount).toBe(3);
    expect(collectedIds).toEqual(expectedOrderIds);
    expect(unreadFromFirstPage).toBe(expectedUnread);

    // Never another account's reports, on either side.
    const strangerListing = await getReports(stranger.cookie);
    expect(strangerListing.status).toBe(200);
    expect(strangerListing.body.reports).toHaveLength(1);
    expect(collectedIds).not.toContain(strangerListing.body.reports[0].id);
  });

  it('read-on-open: fetching a report marks it read, drops the unread count by exactly one, and is idempotent', async () => {
    const owner = await createGuestSession();
    const base = Date.now();
    const seeded = await seedReports(owner.accountId, [
      { createdAt: base, read: false },
      { createdAt: base - 1_000, read: false },
      { createdAt: base - 2_000, read: true },
    ]);
    const newest = seeded[0];
    if (!newest) throw new Error('unreachable');
    const targetId = String(newest._id);

    const before = await getReports(owner.cookie);
    expect(before.body.unreadCount).toBe(2);

    const opened = await getReport(owner.cookie, targetId);
    expect(opened.status).toBe(200);
    expect(opened.body.id).toBe(targetId);
    expect(opened.body.read).toBe(true);
    expect(opened.body.payload).toEqual({ note: 'seeded-for-test' });

    const after = await getReports(owner.cookie);
    expect(after.body.unreadCount).toBe(1);

    // Idempotent: opening it again changes nothing further.
    const openedAgain = await getReport(owner.cookie, targetId);
    expect(openedAgain.status).toBe(200);
    expect(openedAgain.body.read).toBe(true);
    const afterAgain = await getReports(owner.cookie);
    expect(afterAgain.body.unreadCount).toBe(1);
  });

  it('ownership: another account’s report id 404s, not 403; a malformed id 404s too', async () => {
    const owner = await createGuestSession();
    const stranger = await createGuestSession();
    const [seeded] = await seedReports(owner.accountId, [{ createdAt: Date.now() }]);
    if (!seeded) throw new Error('unreachable');

    const foreignAttempt = await getReport(stranger.cookie, String(seeded._id));
    expect(foreignAttempt.status).toBe(404);
    expect(foreignAttempt.body.error.key).toBe('errors.report.notFound');

    const malformedAttempt = await getReport(owner.cookie, 'not-an-id');
    expect(malformedAttempt.status).toBe(404);
    expect(malformedAttempt.body.error.key).toBe('errors.report.notFound');

    // Unaffected by the foreign attempt above.
    const stillThere = await getReport(owner.cookie, String(seeded._id));
    expect(stillThere.status).toBe(200);
  });

  it('auth: both routes 401 without a session cookie', async () => {
    const listResponse = await request(app.getHttpServer()).get('/api/reports');
    expect(listResponse.status).toBe(401);
    expect(listResponse.body.error.key).toBe('errors.auth.notAuthenticated');

    const oneResponse = await request(app.getHttpServer()).get(
      `/api/reports/${new Types.ObjectId().toString()}`,
    );
    expect(oneResponse.status).toBe(401);
    expect(oneResponse.body.error.key).toBe('errors.auth.notAuthenticated');
  });

  it('validation: a malformed cursor 400s with its own key', async () => {
    const owner = await createGuestSession();
    const response = await getReports(owner.cookie, { cursor: 'not-a-real-cursor' });
    expect(response.status).toBe(400);
    expect(response.body.error.key).toBe('errors.report.invalidCursor');
  });

  // --- WS scenarios: need the real movements/scheduler flow to produce reports. ---

  interface SeedSettlementOptions {
    troops?: Array<{ unitType: string; count: number }>;
  }

  async function seedSettlementAt(
    accountId: Types.ObjectId,
    x: number,
    y: number,
    options: SeedSettlementOptions = {},
  ): Promise<SettlementDocument> {
    return settlementModel.create({
      accountId,
      name: 'Test Settlement',
      x,
      y,
      buildings: [{ id: randomUUID(), type: 'commandCenter', level: 1, slot: 0 }],
      resources: {
        values: { scrap: 1_000_000, fuel: 1_000_000, electronics: 1_000_000, food: 1_000_000 },
        lastCalcAt: Date.now(),
      },
      buildQueue: [],
      troops: options.troops ?? [],
      trainingQueue: [],
      version: 0,
    });
  }

  async function forceArrive(movementId: string): Promise<void> {
    // See `movements.integration.spec.ts`'s identical helper for why `departAt` is backdated
    // first — avoids the follow-up `movementReturn` event also landing in the past and
    // dispatching in the same `runOnce()` pass.
    await movementModel.updateOne(
      { _id: movementId },
      { $set: { departAt: Date.now() - 600_000 } },
    );
    await eventModel.updateOne(
      { type: 'movementArrive', 'payload.movementId': movementId },
      { $set: { dueAt: Date.now() - 1_000 } },
    );
    await schedulerService.runOnce();
  }

  function connectSocket(cookieHeader: string): ClientSocket {
    const socket = io(baseUrl, {
      path: '/ws',
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      extraHeaders: { Cookie: cookieHeader },
    });
    openSockets.push(socket);
    return socket;
  }

  function waitForEvent<T = unknown>(
    socket: ClientSocket,
    event: string,
    timeoutMs = 5_000,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for "${event}"`)),
        timeoutMs,
      );
      socket.once(event, (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  }

  it('WS: reportArrived reaches the attacker and the (detected) defender, never an unrelated third account, and the pushed report is already fetchable (commit-ordering guarantee)', async () => {
    const attacker = await createGuestSession();
    const defender = await createGuestSession();
    const stranger = await createGuestSession();

    const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
      troops: [{ unitType: 'falconer', count: 2 }],
    });
    await seedSettlementAt(defender.accountId, 5, 0, {
      troops: [{ unitType: 'lookout', count: 2 }],
    });

    const attackerSocket = connectSocket(attacker.cookieHeader);
    const defenderSocket = connectSocket(defender.cookieHeader);
    const strangerSocket = connectSocket(stranger.cookieHeader);
    await Promise.all([
      waitForEvent(attackerSocket, 'connect'),
      waitForEvent(defenderSocket, 'connect'),
      waitForEvent(strangerSocket, 'connect'),
    ]);

    const strangerEvents: unknown[] = [];
    strangerSocket.on('reportArrived', (payload: unknown) => strangerEvents.push(payload));

    const attackerPushPromise = waitForEvent<{ id: string; type: string; createdAt: number }>(
      attackerSocket,
      'reportArrived',
    );
    const defenderPushPromise = waitForEvent<{ id: string; type: string; createdAt: number }>(
      defenderSocket,
      'reportArrived',
    );

    const sendResponse = await request(app.getHttpServer())
      .post('/api/movements')
      .set('Cookie', attacker.cookie)
      .send({
        type: 'scout',
        fromSettlementId: String(attackerSettlement._id),
        target: { x: 5, y: 0 },
        units: [{ unitType: 'falconer', count: 2 }],
      });
    expect(sendResponse.status).toBe(201);

    await forceArrive(sendResponse.body.id as string);

    const [attackerPush, defenderPush] = await Promise.all([
      attackerPushPromise,
      defenderPushPromise,
    ]);

    expect(attackerPush.type).toBe('scout');
    expect(defenderPush.type).toBe('scoutDetected');

    // Commit-ordering guarantee: the moment the push arrives, the report it names must
    // already be readable through the normal REST path — proving `reportArrived` is only
    // ever emitted for a report whose creating transaction has already committed (see
    // `ReportsRealtimePublisher`'s own comment on why a MongoDB change stream is what
    // guarantees this by construction, rather than by any ordering code here has to get
    // right).
    const attackerFetch = await getReport(attacker.cookie, attackerPush.id);
    expect(attackerFetch.status).toBe(200);
    expect(attackerFetch.body.id).toBe(attackerPush.id);
    expect(attackerFetch.body.type).toBe('scout');

    const defenderFetch = await getReport(defender.cookie, defenderPush.id);
    expect(defenderFetch.status).toBe(200);
    expect(defenderFetch.body.id).toBe(defenderPush.id);
    expect(defenderFetch.body.type).toBe('scoutDetected');

    // Give the stranger's socket a fair chance to (wrongly) receive either push before
    // asserting it never did.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(strangerEvents).toEqual([]);
  });
});
