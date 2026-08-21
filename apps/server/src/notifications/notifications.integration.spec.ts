import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import type { BuildingLevels, GameConfig } from '@last-signal/game-core';
import {
  DEFAULT_CONFIG,
  calcInfluence,
  isSettleable,
  settlementsAllowed,
  terrainAt,
} from '@last-signal/game-core';
import { Logger } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Connection, Model } from 'mongoose';
import { Types } from 'mongoose';
import { io } from 'socket.io-client';
import type { Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../app.module';
import { SESSION_COOKIE_NAME } from '../auth/auth.constants';
import { ReportsRealtimePublisher } from '../reports/reports-realtime.publisher';
import { SchedulerService } from '../scheduler/scheduler.service';
import type { AccountDocument } from '../schemas/account.schema';
import { Account } from '../schemas/account.schema';
import type { GameEventDocument } from '../schemas/event.schema';
import { GameEvent } from '../schemas/event.schema';
import type { MovementDocument } from '../schemas/movement.schema';
import { Movement } from '../schemas/movement.schema';
import type { NotificationDocument, NotificationKind } from '../schemas/notification.schema';
import { Notification } from '../schemas/notification.schema';
import type { OasisDocument } from '../schemas/oasis.schema';
import { Oasis } from '../schemas/oasis.schema';
import type { ReportDocument } from '../schemas/report.schema';
import { Report } from '../schemas/report.schema';
import type { SettlementDocument } from '../schemas/settlement.schema';
import { Settlement } from '../schemas/settlement.schema';
import { BuildCompleteHandler } from '../settlements/handlers/build-complete.handler';
import { WorldService } from '../world/world.service';
import { NOTIFICATION_DISPATCH_EVENT_TYPE } from './notifications.constants';
import { InAppNotificationProvider } from './providers/in-app-notification.provider';

// Proves M3e.1 end to end (`docs/M3_DESIGN_DECISIONS.md` §16, §19.9): the six notification
// kinds are enqueued by their REAL triggers (driven through the real HTTP API and the real
// scheduler — never by calling `NotificationsService.enqueue` directly), the enqueue rides
// its caller's own transaction, per-kind toggles gate at enqueue time, the dispatcher drains
// at-least-once/idempotently with per-row provider isolation, and the `ReportsRealtimePublisher`
// resume fix actually resumes. Follows `market.integration.spec.ts`'s conventions (whole
// `AppModule`, `MongoMemoryReplSet`, `SCHEDULER_ENABLED=false` + manual `runOnce()`,
// `app.listen(0, '127.0.0.1')` right after `app.init()` — see that spec's own comment for why
// this must not be simplified back to `app.init()` alone).
describe('Notifications (integration)', () => {
  let app: INestApplication;
  let replSet: MongoMemoryReplSet;
  let moduleRef: TestingModule;
  let connection: Connection;
  let accountModel: Model<AccountDocument>;
  let settlementModel: Model<SettlementDocument>;
  let movementModel: Model<MovementDocument>;
  let reportModel: Model<ReportDocument>;
  let eventModel: Model<GameEventDocument>;
  let oasisModel: Model<OasisDocument>;
  let notificationModel: Model<NotificationDocument>;
  let schedulerService: SchedulerService;
  let worldService: WorldService;
  let baseUrl: string;
  const openSockets: ClientSocket[] = [];

  const config: GameConfig = DEFAULT_CONFIG;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    process.env['MONGODB_URI'] = replSet.getUri('last-signal-notifications-test');
    process.env['SCHEDULER_ENABLED'] = 'false';
    process.env['WORLD_NPC_COUNT'] = '0';

    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    // Explicit IPv4-bound single listener, right after `app.init()` — see
    // `market.integration.spec.ts`'s own comment: a recent fix made the suite reliable, do
    // not simplify this back to `app.init()` alone.
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    connection = moduleRef.get(getConnectionToken());
    accountModel = moduleRef.get(getModelToken(Account.name));
    settlementModel = moduleRef.get(getModelToken(Settlement.name));
    movementModel = moduleRef.get(getModelToken(Movement.name));
    reportModel = moduleRef.get(getModelToken(Report.name));
    eventModel = moduleRef.get(getModelToken(GameEvent.name));
    oasisModel = moduleRef.get(getModelToken(Oasis.name));
    notificationModel = moduleRef.get(getModelToken(Notification.name));
    schedulerService = moduleRef.get(SchedulerService);
    worldService = moduleRef.get(WorldService);
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
    vi.restoreAllMocks();
    await Promise.all([
      accountModel.deleteMany({}),
      settlementModel.deleteMany({}),
      movementModel.deleteMany({}),
      reportModel.deleteMany({}),
      eventModel.deleteMany({}),
      notificationModel.deleteMany({}),
    ]);
    // `NotificationsModule.onModuleInit` seeds the very first `notificationDispatch`
    // heartbeat exactly once, at app boot — wiping `events` above (mirroring every other
    // integration spec's own `afterEach`) also wipes that heartbeat, and nothing else in a
    // running process ever re-seeds it (`NotificationDispatchHandler` only reschedules ITS
    // OWN successor, and there is none left to do that once this collection is empty). Every
    // test below that needs to drive the dispatcher (`driveDispatch`) needs one to exist, so
    // this restores the exact invariant the module establishes at boot — the same self-heal
    // shape `NotificationsModule.onModuleInit` itself uses.
    await eventModel.create({
      type: NOTIFICATION_DISPATCH_EVENT_TYPE,
      dueAt: Date.now(),
      payload: {},
      payloadVersion: 1,
      status: 'due',
      attempts: 0,
    });
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
    const sessionCookie = setCookie.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
    if (!sessionCookie) throw new Error('unreachable');
    return {
      accountId: new Types.ObjectId(response.body.id as string),
      cookie: setCookie,
      cookieHeader: sessionCookie.split(';')[0] as string,
    };
  }

  interface SeedSettlementOptions {
    buildings?: Array<{ type: string; level: number }>;
    troops?: Array<{ unitType: string; count: number }>;
    resources?: { scrap: number; fuel: number; electronics: number; food: number };
  }

  const ABUNDANT_RESOURCES = {
    scrap: 1_000_000,
    fuel: 1_000_000,
    electronics: 1_000_000,
    food: 1_000_000,
  };

  async function seedSettlementAt(
    accountId: Types.ObjectId,
    x: number,
    y: number,
    options: SeedSettlementOptions = {},
  ): Promise<SettlementDocument> {
    const buildingsInput = options.buildings ?? [{ type: 'commandCenter', level: 1 }];
    return settlementModel.create({
      accountId,
      name: 'Test Settlement',
      x,
      y,
      buildings: buildingsInput.map((b, i) => ({
        id: randomUUID(),
        type: b.type,
        level: b.level,
        slot: i,
      })),
      resources: { values: options.resources ?? ABUNDANT_RESOURCES, lastCalcAt: Date.now() },
      buildQueue: [],
      troops: options.troops ?? [],
      trainingQueue: [],
      version: 0,
    });
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

  // Poll-until-condition, not sleep-then-assert: this resolves the INSTANT the real socket.io
  // event fires (a live listener, not a timer that fires and then checks something), so the
  // happy path never pays for a generous timeout — only a genuine failure waits the full
  // `timeoutMs` before surfacing. The default is deliberately large (10s, matching the resume
  // test's own value below) because this whole suite runs its test files in parallel, each
  // spinning a real `MongoMemoryReplSet`; under heavy contention the actual delivery path
  // (a `driveDispatch()` call plus a real loopback WS round trip) can be slower than on an
  // idle machine without ever being WRONG, and a tight timeout would turn that slowness into a
  // false failure. See `docs/PROGRESS.md`'s M3c.x entry for the standing lesson this follows —
  // that flake was root-caused to environment/timing assumptions, not application logic.
  function waitForEvent<T = unknown>(
    socket: ClientSocket,
    event: string,
    timeoutMs = 10_000,
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

  // The negative-space counterpart to `waitForEvent`: proves an event does NOT arrive within a
  // window, used for "a scout produces no WS event, ever" (§12). Unlike `waitForEvent`, there
  // is no condition to poll for here — absence can only ever be "checked" by waiting a finite
  // time and seeing nothing happen, so the window's LENGTH is the only lever, and it is
  // deliberately generous rather than tuned tight: by the time each call site starts this
  // window, `driveDispatch()` has already run to completion (a real, awaited transaction), so
  // if a row for the excluded kind existed at all it would already have been drained and its
  // WS push already handed to socket.io — this window is only covering that push's own
  // loopback delivery, not any pending server-side work. 800ms is comfortably above that even
  // under the heavy parallel-file load `waitForEvent`'s own comment describes, while costing
  // this suite well under two seconds total (it's used twice, at most, per test).
  function neverReceives(socket: ClientSocket, event: string, windowMs = 800): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, windowMs);
      socket.once(event, () => {
        clearTimeout(timer);
        reject(new Error(`unexpectedly received "${event}"`));
      });
    });
  }

  function postSend(cookie: string[], body: Record<string, unknown>) {
    return request(app.getHttpServer()).post('/api/movements').set('Cookie', cookie).send(body);
  }

  function postBuild(settlementId: string, cookie: string[], type: string) {
    return request(app.getHttpServer())
      .post(`/api/settlements/${settlementId}/build`)
      .set('Cookie', cookie)
      .send({ type });
  }

  function postTrain(settlementId: string, cookie: string[], unitType: string, count: number) {
    return request(app.getHttpServer())
      .post(`/api/settlements/${settlementId}/train`)
      .set('Cookie', cookie)
      .send({ unitType, count });
  }

  function getSettlementState(settlementId: string, cookie: string[]) {
    return request(app.getHttpServer())
      .get(`/api/settlements/${settlementId}`)
      .set('Cookie', cookie);
  }

  // Forces the pending `movementArrive` event for `movementId` overdue and runs the
  // scheduler once — the exact convention `reports.integration.spec.ts`/
  // `movements.integration.spec.ts` both already establish.
  async function forceArrive(movementId: string): Promise<void> {
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

  async function completeQueueItem(queueItemId: string): Promise<void> {
    await eventModel.updateOne(
      { type: 'buildComplete', 'payload.queueItemId': queueItemId },
      { $set: { dueAt: Date.now() - 1_000 } },
    );
    await schedulerService.runOnce();
  }

  async function completeTrainingUnit(orderId: string): Promise<void> {
    await eventModel.updateOne(
      { type: 'trainingComplete', 'payload.orderId': orderId, status: 'due' },
      { $set: { dueAt: Date.now() - 1_000 } },
    );
    await schedulerService.runOnce();
  }

  // Forces the settlement's pending `starvationTick` event overdue and runs the scheduler —
  // mirrors `settlements.integration.spec.ts`'s own `runStarvationTick` helper.
  async function forceStarvationTick(settlementId: string): Promise<void> {
    await eventModel.updateOne(
      { type: 'starvationTick', 'payload.settlementId': settlementId, status: 'due' },
      { $set: { dueAt: Date.now() - 1_000 } },
    );
    await schedulerService.runOnce();
  }

  // Drives the notification dispatcher deterministically: forces whatever
  // `notificationDispatch` heartbeat is currently `due` overdue, then runs the scheduler once
  // — the same "force the specific event overdue, run the real handler through the real
  // scheduler" shape every other timer-driven test in this codebase already uses, applied to
  // `NotificationDispatchHandler` instead of a combat/training/build event.
  async function driveDispatch(): Promise<void> {
    await eventModel.updateMany(
      { type: NOTIFICATION_DISPATCH_EVENT_TYPE, status: 'due' },
      { $set: { dueAt: Date.now() - 1_000 } },
    );
    await schedulerService.runOnce();
  }

  async function setNotificationToggle(
    accountId: Types.ObjectId,
    kind: NotificationKind,
    enabled: boolean,
  ): Promise<void> {
    await accountModel.updateOne(
      { _id: accountId },
      { $set: { [`settings.notifications.${kind}`]: enabled } },
    );
  }

  // --- settle fixtures (mirrors `movements.integration.spec.ts`'s own conventions) ---

  const SETTLERS_REQUIRED = config.settle.settlersRequired;
  const SETTLER_TROOPS = [{ unitType: 'settler', count: SETTLERS_REQUIRED }];
  // Every building type at its own max level — the highest Influence one settlement can ever
  // reach. The settle test below needs the account to clear the Influence gate for a THIRD
  // settlement (M1 §7's hard cap), not just a second — derived from the real config, not a
  // hand-picked subset, so this fixture can never silently fall short of `maxSettlements`.
  const MAX_INFLUENCE_BUILDINGS = Object.entries(config.buildings).map(([type, def]) => ({
    type,
    level: def.maxLevel,
  }));

  function assertAllowsAnotherSettlement(existingCount: number): void {
    const influence = calcInfluence(config, [MAX_INFLUENCE_BUILDINGS as BuildingLevels]);
    expect(settlementsAllowed(config, influence)).toBeGreaterThan(existingCount);
  }

  async function findLegalSettleTile(
    baseX: number,
    baseY: number,
  ): Promise<{ x: number; y: number }> {
    const world = await worldService.getWorld();
    const [settlementDocs, oasisDocs] = await Promise.all([
      settlementModel.find({}, 'x y'),
      oasisModel.find({}, 'x y'),
    ]);
    const existingSettlements = settlementDocs.map((d) => ({ x: d.x, y: d.y }));
    const oasisTiles = new Set(oasisDocs.map((d) => `${d.x},${d.y}`));

    for (let ring = 0; ring <= 25; ring += 1) {
      for (let dx = -ring; dx <= ring; dx += 1) {
        for (let dy = -ring; dy <= ring; dy += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const tile = { x: baseX + dx, y: baseY + dy };
          if (Math.max(Math.abs(tile.x), Math.abs(tile.y)) > config.map.radius) continue;
          const legal = isSettleable(config, {
            tile,
            terrain: terrainAt(config, world.seed, tile.x, tile.y),
            isOasis: oasisTiles.has(`${tile.x},${tile.y}`),
            existingSettlements,
          });
          if (legal) return tile;
        }
      }
    }
    throw new Error('findLegalSettleTile: no legal tile found near the requested base');
  }

  // --- 1. incomingAttack (§12/§16) + the scout exclusion, together (same fixtures) ---

  describe('incomingAttack', () => {
    async function seedDefenderWithTower(
      radioTowerLevel: number,
      x: number,
      y: number,
    ): Promise<{ defender: GuestSession; defenderSettlement: SettlementDocument }> {
      const defender = await createGuestSession();
      const defenderSettlement = await seedSettlementAt(defender.accountId, x, y, {
        buildings: [
          { type: 'commandCenter', level: 1 },
          { type: 'radioTower', level: radioTowerLevel },
        ],
      });
      return { defender, defenderSettlement };
    }

    it('a scout send produces no notification and no WS event, at Radio Tower level 0 and level 5', async () => {
      const attacker = await createGuestSession();
      const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
        troops: [{ unitType: 'falconer', count: 2 }],
      });
      const { defender: defenderLow } = await seedDefenderWithTower(0, 5, 0);
      const { defender: defenderHigh } = await seedDefenderWithTower(5, -5, 0);

      const lowSocket = connectSocket(defenderLow.cookieHeader);
      const highSocket = connectSocket(defenderHigh.cookieHeader);
      await Promise.all([waitForEvent(lowSocket, 'connect'), waitForEvent(highSocket, 'connect')]);
      const neverLow = neverReceives(lowSocket, 'notification');
      const neverHigh = neverReceives(highSocket, 'notification');

      const sendLow = await postSend(attacker.cookie, {
        type: 'scout',
        fromSettlementId: String(attackerSettlement._id),
        target: { x: 5, y: 0 },
        units: [{ unitType: 'falconer', count: 1 }],
      });
      expect(sendLow.status).toBe(201);
      const sendHigh = await postSend(attacker.cookie, {
        type: 'scout',
        fromSettlementId: String(attackerSettlement._id),
        target: { x: -5, y: 0 },
        units: [{ unitType: 'falconer', count: 1 }],
      });
      expect(sendHigh.status).toBe(201);

      await driveDispatch();
      await neverLow;
      await neverHigh;

      expect(await notificationModel.countDocuments({ kind: 'incomingAttack' })).toBe(0);
    });

    it('a raid enqueues a tier-gated incomingAttack notification: no unit composition at tower 0, full composition at tower 5', async () => {
      const attacker = await createGuestSession();
      const troops = [{ unitType: 'brute', count: 5 }];
      const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, { troops });
      const { defender: defenderLow, defenderSettlement: settlementLow } =
        await seedDefenderWithTower(0, 5, 0);
      const { defender: defenderHigh, defenderSettlement: settlementHigh } =
        await seedDefenderWithTower(5, -5, 0);

      const sendLow = await postSend(attacker.cookie, {
        type: 'raid',
        fromSettlementId: String(attackerSettlement._id),
        target: { x: 5, y: 0 },
        units: [{ unitType: 'brute', count: 2 }],
      });
      expect(sendLow.status).toBe(201);
      const sendHigh = await postSend(attacker.cookie, {
        type: 'raid',
        fromSettlementId: String(attackerSettlement._id),
        target: { x: -5, y: 0 },
        units: [{ unitType: 'brute', count: 2 }],
      });
      expect(sendHigh.status).toBe(201);

      // Enqueued transactionally at send — undelivered until the dispatcher's next drain,
      // checked BEFORE driving it below.
      const lowRow = await notificationModel.findOne({
        accountId: defenderLow.accountId,
        kind: 'incomingAttack',
      });
      expect(lowRow).not.toBeNull();
      if (!lowRow) throw new Error('unreachable');
      expect(lowRow.deliveredAt).toBeUndefined();
      expect(lowRow.payload['detailTier']).toBe('existence');
      expect(lowRow.payload['toSettlementId']).toBe(String(settlementLow._id));
      expect(lowRow.payload['hostile']).toBe(true);
      // The security property itself (§12): these fields never touched the wire at all —
      // `movements.integration.spec.ts`'s own `JSON.stringify` leak-guard convention, applied
      // to a notification payload instead of an HTTP response body.
      const lowSerialized = JSON.stringify(lowRow.payload);
      for (const leaked of ['"units"', 'brute', '"type"', 'unitCount']) {
        expect(lowSerialized).not.toContain(leaked);
      }

      const highRow = await notificationModel.findOne({
        accountId: defenderHigh.accountId,
        kind: 'incomingAttack',
      });
      expect(highRow).not.toBeNull();
      if (!highRow) throw new Error('unreachable');
      expect(highRow.payload['detailTier']).toBe('full');
      expect(highRow.payload['toSettlementId']).toBe(String(settlementHigh._id));
      expect(highRow.payload['units']).toEqual([{ unitType: 'brute', count: 2 }]);

      // The dispatcher actually pushes it live, through the in-app provider.
      const highSocket = connectSocket(defenderHigh.cookieHeader);
      await waitForEvent(highSocket, 'connect');
      const pushPromise = waitForEvent<{ kind: string; payload: Record<string, unknown> }>(
        highSocket,
        'notification',
      );
      await driveDispatch();
      const push = await pushPromise;
      expect(push.kind).toBe('incomingAttack');
      expect(push.payload['detailTier']).toBe('full');
    });

    it('support to your own settlement never produces an incomingAttack notification', async () => {
      const account = await createGuestSession();
      const home = await seedSettlementAt(account.accountId, 0, 0, {
        troops: [{ unitType: 'brute', count: 3 }],
      });
      const other = await seedSettlementAt(account.accountId, 10, 0, {
        buildings: [
          { type: 'commandCenter', level: 1 },
          { type: 'radioTower', level: 5 },
        ],
      });

      const send = await postSend(account.cookie, {
        type: 'support',
        fromSettlementId: String(home._id),
        target: { x: 10, y: 0 },
        units: [{ unitType: 'brute', count: 1 }],
      });
      expect(send.status).toBe(201);

      await driveDispatch();
      expect(
        await notificationModel.countDocuments({
          accountId: other.accountId,
          kind: 'incomingAttack',
        }),
      ).toBe(0);
    });
  });

  // --- 2. buildComplete (§16) ---

  it('buildComplete: enqueued by BuildCompleteHandler at the real event, pushed live, and suppressed by a disabled toggle', async () => {
    const account = await createGuestSession();
    const settlement = await seedSettlementAt(account.accountId, 0, 0);

    const buildResponse = await postBuild(String(settlement._id), account.cookie, 'greenhouseFarm');
    expect(buildResponse.status).toBe(200);
    const queueItemId = (buildResponse.body.buildQueue as Array<{ id: string }>)[0]?.id;
    if (!queueItemId) throw new Error('unreachable');

    const socket = connectSocket(account.cookieHeader);
    await waitForEvent(socket, 'connect');
    const pushPromise = waitForEvent<{ kind: string; payload: Record<string, unknown> }>(
      socket,
      'notification',
    );

    await completeQueueItem(queueItemId);
    await driveDispatch();

    const row = await notificationModel.findOne({
      accountId: account.accountId,
      kind: 'buildComplete',
    });
    expect(row).not.toBeNull();
    if (!row) throw new Error('unreachable');
    expect(row.payload).toMatchObject({
      settlementId: String(settlement._id),
      buildingType: 'greenhouseFarm',
      level: 1,
    });
    expect(row.deliveredAt).toBeTypeOf('number');
    expect(row.provider).toEqual(expect.arrayContaining(['in-app', 'telegram']));

    const push = await pushPromise;
    expect(push.kind).toBe('buildComplete');
    expect(push.payload).toMatchObject({ buildingType: 'greenhouseFarm' });

    // Disabled toggle: the SAME trigger, for an account that has opted out — no row at all.
    await setNotificationToggle(account.accountId, 'buildComplete', false);
    const secondBuild = await postBuild(String(settlement._id), account.cookie, 'warehouse');
    expect(secondBuild.status).toBe(200);
    const secondQueueItemId = (secondBuild.body.buildQueue as Array<{ id: string }>).find(
      (i) => i.id !== queueItemId,
    )?.id;
    if (!secondQueueItemId) throw new Error('unreachable');
    await completeQueueItem(secondQueueItemId);

    const afterDisabled = await notificationModel.find({
      accountId: account.accountId,
      kind: 'buildComplete',
    });
    // Still exactly the one row from before the toggle flipped — the warehouse build produced
    // none.
    expect(afterDisabled).toHaveLength(1);
    // The building itself still completed normally — only the notification was suppressed.
    const state = await getSettlementState(String(settlement._id), account.cookie);
    expect(state.body.buildings.some((b: { type: string }) => b.type === 'warehouse')).toBe(true);
  });

  // --- 3. trainingComplete (§16) — on the order's FINAL unit, not each one ---

  it('trainingComplete: no notification after the first unit of a 2-unit order, exactly one (with totalCount, not per-unit) after the last', async () => {
    const account = await createGuestSession();
    await accountModel.updateOne({ _id: account.accountId }, { $set: { faction: 'raiders' } });
    const settlement = await seedSettlementAt(account.accountId, 0, 0, {
      buildings: [
        { type: 'commandCenter', level: 1 },
        { type: 'barracks', level: 1 },
        { type: 'greenhouseFarm', level: 1 },
      ],
    });

    const trainResponse = await postTrain(String(settlement._id), account.cookie, 'lookout', 2);
    expect(trainResponse.status).toBe(200);
    const orderId = (trainResponse.body.trainingQueue as Array<{ id: string }>)[0]?.id;
    if (!orderId) throw new Error('unreachable');

    await completeTrainingUnit(orderId);
    expect(await notificationModel.countDocuments({ kind: 'trainingComplete' })).toBe(0);

    await completeTrainingUnit(orderId);
    const rows = await notificationModel.find({
      accountId: account.accountId,
      kind: 'trainingComplete',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({
      settlementId: String(settlement._id),
      unitType: 'lookout',
      totalCount: 2,
    });
  });

  // --- 4. troopsStarving (§16) ---

  it('troopsStarving: enqueued by StarvationTickHandler at the real event, referencing the starvation report', async () => {
    const account = await createGuestSession();
    const settlement = await seedSettlementAt(account.accountId, 0, 0, {
      buildings: [{ type: 'commandCenter', level: 1 }],
      troops: [{ unitType: 'brute', count: 1 }],
      resources: { scrap: 1_000_000, fuel: 1_000_000, electronics: 1_000_000, food: 0 },
    });

    // Arms `ensureStarvationSchedule` — an ordinary, real command (`SettlementsService
    // .settleSettlementDoc`'s own lazy-scheduling choke point, not a test-only shortcut).
    const stateResponse = await getSettlementState(String(settlement._id), account.cookie);
    expect(stateResponse.status).toBe(200);

    await forceStarvationTick(String(settlement._id));

    const report = await reportModel.findOne({ accountId: account.accountId, type: 'starvation' });
    expect(report).not.toBeNull();
    if (!report) throw new Error('unreachable');

    const row = await notificationModel.findOne({
      accountId: account.accountId,
      kind: 'troopsStarving',
    });
    expect(row).not.toBeNull();
    if (!row) throw new Error('unreachable');
    expect(row.payload['reportId']).toBe(String(report._id));

    const after = await settlementModel.findById(settlement._id);
    expect(after?.troops).toHaveLength(0);
  });

  // --- 5. settlementFounded (§16) — success only, never a failed founding ---

  it('settlementFounded: enqueued only on a successful founding, never on a failed one', async () => {
    const account = await createGuestSession();
    // Twice the required Settlers: the first successful founding consumes exactly
    // `SETTLERS_REQUIRED` of them (§13), leaving enough at home for a SECOND attempt below —
    // deliberately re-sent from this SAME origin (never a freshly-seeded third settlement),
    // since the Influence hard cap is 3 total settlements (M1 §7) and a fresh third
    // settlement would trip THAT gate at send, masking the `tileOccupied` failure this test
    // actually wants to exercise.
    const origin = await seedSettlementAt(account.accountId, 0, 0, {
      buildings: MAX_INFLUENCE_BUILDINGS,
      troops: [{ unitType: 'settler', count: SETTLERS_REQUIRED * 2 }],
    });
    // Must clear the gate for the SECOND send below too, made with 2 settlements already
    // existing (origin + the first founding) — not just the first send's 1.
    assertAllowsAnotherSettlement(2);

    const legalTile = await findLegalSettleTile(20, 20);
    const send = await postSend(account.cookie, {
      type: 'settle',
      fromSettlementId: String(origin._id),
      target: legalTile,
      units: SETTLER_TROOPS,
    });
    expect(send.status).toBe(201);
    await forceArrive(send.body.id as string);

    const report = await reportModel.findOne({ accountId: account.accountId, type: 'settle' });
    expect(report).not.toBeNull();
    if (!report) throw new Error('unreachable');
    expect(report.payload['founded']).toBe(true);

    const row = await notificationModel.findOne({
      accountId: account.accountId,
      kind: 'settlementFounded',
    });
    expect(row).not.toBeNull();
    if (!row) throw new Error('unreachable');
    expect(row.payload['reportId']).toBe(String(report._id));
    expect(row.payload['newSettlementId']).toBe(report.payload['newSettlementId']);

    // A second founding, legal AT SEND time (`SettleArrivalResolver`'s send-time twin already
    // rejects an OBVIOUSLY occupied tile outright, so this can only be exercised by having the
    // tile turn occupied WHILE the convoy is in flight) but raced out from under it before
    // arrival — exactly §13's own "two convoys, one loses" case, reproduced here not through a
    // genuine concurrent race but by seeding the rival settlement directly, deterministically,
    // in the gap between send and arrival. Fails at ARRIVAL, produces a `settle` report
    // (`founded: false`, §15) and no `settlementFounded` notification for it.
    const secondTile = await findLegalSettleTile(-20, -20);
    const secondSend = await postSend(account.cookie, {
      type: 'settle',
      fromSettlementId: String(origin._id),
      target: secondTile,
      units: SETTLER_TROOPS,
    });
    expect(secondSend.status).toBe(201);

    await seedSettlementAt(new Types.ObjectId(), secondTile.x, secondTile.y);
    await forceArrive(secondSend.body.id as string);

    const failedReport = await reportModel.findOne({
      accountId: account.accountId,
      type: 'settle',
      'payload.founded': false,
    });
    expect(failedReport).not.toBeNull();
    expect(
      await notificationModel.countDocuments({
        accountId: account.accountId,
        kind: 'settlementFounded',
      }),
    ).toBe(1);
  });

  // --- 6. battleReportArrived (§16) — every combat report writer funnels through it ---

  it('battleReportArrived: both the attacker and the defender get one, referencing their own report', async () => {
    const attacker = await createGuestSession();
    const defender = await createGuestSession();
    const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
      troops: [{ unitType: 'brute', count: 5 }],
    });
    await seedSettlementAt(defender.accountId, 5, 0);

    const send = await postSend(attacker.cookie, {
      type: 'raid',
      fromSettlementId: String(attackerSettlement._id),
      target: { x: 5, y: 0 },
      units: [{ unitType: 'brute', count: 5 }],
    });
    expect(send.status).toBe(201);
    await forceArrive(send.body.id as string);

    const attackerReport = await reportModel.findOne({
      accountId: attacker.accountId,
      type: 'raid',
    });
    const defenderReport = await reportModel.findOne({
      accountId: defender.accountId,
      type: 'defense',
    });
    expect(attackerReport).not.toBeNull();
    expect(defenderReport).not.toBeNull();
    if (!attackerReport || !defenderReport) throw new Error('unreachable');

    const attackerRow = await notificationModel.findOne({
      accountId: attacker.accountId,
      kind: 'battleReportArrived',
    });
    const defenderRow = await notificationModel.findOne({
      accountId: defender.accountId,
      kind: 'battleReportArrived',
    });
    expect(attackerRow?.payload).toMatchObject({
      reportId: String(attackerReport._id),
      reportType: 'raid',
    });
    expect(defenderRow?.payload).toMatchObject({
      reportId: String(defenderReport._id),
      reportType: 'defense',
    });
  });

  // --- 7. transactional enqueue: a rolled-back effect leaves no notification row ---

  it('the enqueue is transactional: forcing the whole command to roll back leaves no notification row behind', async () => {
    const account = await createGuestSession();
    const settlement = await seedSettlementAt(account.accountId, 0, 0);
    const buildResponse = await postBuild(String(settlement._id), account.cookie, 'greenhouseFarm');
    expect(buildResponse.status).toBe(200);
    const queueItemId = (buildResponse.body.buildQueue as Array<{ id: string }>)[0]?.id;
    if (!queueItemId) throw new Error('unreachable');

    await eventModel.updateOne(
      { type: 'buildComplete', 'payload.queueItemId': queueItemId },
      { $set: { dueAt: Date.now() - 1_000 } },
    );
    const event = await eventModel.findOne({
      type: 'buildComplete',
      'payload.queueItemId': queueItemId,
    });
    if (!event) throw new Error('unreachable');

    const buildCompleteHandler = moduleRef.get(BuildCompleteHandler);
    const session = await connection.startSession();
    // Calls the REAL handler directly (the same "open a session, call `.handle()` inside
    // `withTransaction`" tool `movements.integration.spec.ts`'s own replay tests already use
    // — see e.g. its `movementReturnHandler.handle(event, session)` call), then deliberately
    // throws AFTER it completes so the whole transaction — the building level bump, the
    // starvation reschedule, AND the `buildComplete` notification `enqueue` — aborts together.
    await expect(
      session.withTransaction(async () => {
        await buildCompleteHandler.handle(event, session);
        throw new Error('forced rollback for test');
      }),
    ).rejects.toThrow('forced rollback for test');
    await session.endSession();

    const afterRollback = await settlementModel.findById(settlement._id);
    // The building never levelled up — the whole transaction rolled back, not just the
    // notification.
    expect(afterRollback?.buildings.find((b) => b.type === 'greenhouseFarm')).toBeUndefined();
    expect(
      await notificationModel.countDocuments({
        accountId: account.accountId,
        kind: 'buildComplete',
      }),
    ).toBe(0);
  });

  // --- 8. the dispatcher: idempotent, at-least-once, per-row provider isolation ---

  describe('dispatcher', () => {
    it('stamps deliveredAt/provider, never re-sends a stamped row, and a throwing provider leaves only its own row undelivered', async () => {
      const accountId = new Types.ObjectId();
      const [okRow, failRow] = await notificationModel.create([
        { accountId, kind: 'buildComplete', payload: { note: 'ok' } },
        { accountId, kind: 'buildComplete', payload: { note: 'fails once' } },
      ]);
      if (!okRow || !failRow) throw new Error('unreachable');

      const inAppProvider = moduleRef.get(InAppNotificationProvider);
      const original = inAppProvider.deliver.bind(inAppProvider);
      const spy = vi.spyOn(inAppProvider, 'deliver').mockImplementation(async (notification) => {
        if (notification.id === String(failRow._id)) {
          throw new Error('boom');
        }
        return original(notification);
      });

      await driveDispatch();

      const okAfterFirst = await notificationModel.findById(okRow._id);
      const failAfterFirst = await notificationModel.findById(failRow._id);
      expect(okAfterFirst?.deliveredAt).toBeTypeOf('number');
      expect(okAfterFirst?.provider).toEqual(expect.arrayContaining(['in-app', 'telegram']));
      // Isolated: the failing row is undelivered, but it did NOT strand the other row behind
      // it in the same batch.
      expect(failAfterFirst?.deliveredAt).toBeUndefined();

      // A stamped row is never re-sent: draining again must not call the provider for the
      // already-delivered row a second time.
      spy.mockClear();
      spy.mockImplementation(async (notification) => original(notification));
      await driveDispatch();
      expect(spy).not.toHaveBeenCalledWith(expect.objectContaining({ id: String(okRow._id) }));

      // The next pass, with the failure lifted, delivers the previously-failed row.
      const failAfterRetry = await notificationModel.findById(failRow._id);
      expect(failAfterRetry?.deliveredAt).toBeTypeOf('number');
    });

    it('the Telegram stub logs the exact payload and never throws', async () => {
      const logSpy = vi.spyOn(Logger.prototype, 'log');
      const accountId = new Types.ObjectId();
      const row = await notificationModel.create({
        accountId,
        kind: 'buildComplete',
        payload: { settlementId: 'abc', buildingType: 'warehouse', level: 3 },
      });

      await driveDispatch();

      const after = await notificationModel.findById(row._id);
      expect(after?.deliveredAt).toBeTypeOf('number');
      expect(after?.provider).toContain('telegram');
      expect(
        logSpy.mock.calls.some(
          (call) =>
            typeof call[0] === 'string' &&
            call[0].includes('[stub]') &&
            call[0].includes('warehouse'),
        ),
      ).toBe(true);
    });
  });

  // --- 9. the change-stream resume fix (§16/§19.9) ---

  it('resume: killing the report change stream and inserting a report while it is down still delivers the push once it reconnects', async () => {
    const defender = await createGuestSession();
    const socket = connectSocket(defender.cookieHeader);
    await waitForEvent(socket, 'connect');

    // Warm-up insert: gets at least one change event through, so the publisher's own
    // in-memory `cachedResumeToken` holds a real position before the kill below.
    const warmupPush = waitForEvent<{ id: string }>(socket, 'reportArrived');
    const warmup = await reportModel.create({
      accountId: defender.accountId,
      type: 'scout',
      read: false,
      payload: {},
    });
    const warmupPayload = await warmupPush;
    expect(warmupPayload.id).toBe(String(warmup._id));

    const publisher = moduleRef.get(ReportsRealtimePublisher);
    const activeStream = (publisher as unknown as { changeStream?: { close(): Promise<void> } })
      .changeStream;
    if (!activeStream) throw new Error('unreachable');
    await activeStream.close();

    // Inserted while the stream is down — no live push for THIS one until the resumed
    // stream replays it.
    const missed = await reportModel.create({
      accountId: defender.accountId,
      type: 'scout',
      read: false,
      payload: {},
    });

    // The reconnect has a real, unavoidable floor: `RECONNECT_BASE_DELAY_MS` (1s) before the
    // stream even reopens, plus whatever the resumed stream needs to replay the backlog and
    // this test's own `driveDispatch`-free WS round trip on top. `waitForEvent` still only
    // ever waits as long as it actually takes (it's event-driven, not a sleep) — the explicit
    // 10s here is just documenting that this one call's real floor is meaningfully higher than
    // most others in this file, not a magic number chosen to make a flake go away.
    const resumedPush = await waitForEvent<{ id: string }>(socket, 'reportArrived', 10_000);
    expect(resumedPush.id).toBe(String(missed._id));
  }, 15_000);
});
