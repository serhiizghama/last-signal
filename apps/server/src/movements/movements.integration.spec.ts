import { randomUUID } from 'node:crypto';

import type { BuildingLevels, GameConfig, Resources, TroopCounts } from '@last-signal/game-core';
import {
  DEFAULT_CONFIG,
  HOUR_MS,
  RESOURCE_KINDS,
  calcNetRates,
  calcStorageCaps,
  resolveScoutCombat,
} from '@last-signal/game-core';
import type { INestApplication } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Connection, Model } from 'mongoose';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../app.module';
import type { AccountDocument } from '../schemas/account.schema';
import { Account } from '../schemas/account.schema';
import type { GameEventDocument } from '../schemas/event.schema';
import { GameEvent } from '../schemas/event.schema';
import type { MovementDocument } from '../schemas/movement.schema';
import { Movement } from '../schemas/movement.schema';
import type { ReportDocument } from '../schemas/report.schema';
import { Report } from '../schemas/report.schema';
import type { SettlementDocument } from '../schemas/settlement.schema';
import { Settlement } from '../schemas/settlement.schema';
import { SchedulerService } from '../scheduler/scheduler.service';
import { MovementArriveHandler } from './handlers/movement-arrive.handler';
import { MovementReturnHandler } from './handlers/movement-return.handler';

// Proves the M2b.3 acceptance path end to end: a scout movement is sent, resolved at
// arrival, and its survivors return home, through the real REST API against a real MongoDB
// replica set. Follows the exact convention `settlements.integration.spec.ts` established
// (boot the whole `AppModule` against a `MongoMemoryReplSet`, `SCHEDULER_ENABLED=false` +
// manual `runOnce()` to force scheduled events deterministically) rather than inventing a
// new one.
describe('Movements (integration)', () => {
  let app: INestApplication;
  let replSet: MongoMemoryReplSet;
  let moduleRef: TestingModule;
  let connection: Connection;
  let accountModel: Model<AccountDocument>;
  let settlementModel: Model<SettlementDocument>;
  let movementModel: Model<MovementDocument>;
  let reportModel: Model<ReportDocument>;
  let eventModel: Model<GameEventDocument>;
  let schedulerService: SchedulerService;
  let movementArriveHandler: MovementArriveHandler;
  let movementReturnHandler: MovementReturnHandler;

  const config: GameConfig = DEFAULT_CONFIG;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    process.env['MONGODB_URI'] = replSet.getUri('last-signal-movements-test');
    // The real 1s timer would race this suite's manual `runOnce()` calls.
    process.env['SCHEDULER_ENABLED'] = 'false';
    // NPC seeding is covered by its own suite — off here so it never contends with this
    // file's own settlement fixtures (coordinates, troop counts).
    process.env['WORLD_NPC_COUNT'] = '0';

    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();

    connection = moduleRef.get(getConnectionToken());
    accountModel = moduleRef.get(getModelToken(Account.name));
    settlementModel = moduleRef.get(getModelToken(Settlement.name));
    movementModel = moduleRef.get(getModelToken(Movement.name));
    reportModel = moduleRef.get(getModelToken(Report.name));
    eventModel = moduleRef.get(getModelToken(GameEvent.name));
    schedulerService = moduleRef.get(SchedulerService);
    movementArriveHandler = moduleRef.get(MovementArriveHandler);
    movementReturnHandler = moduleRef.get(MovementReturnHandler);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await replSet.stop();
    delete process.env['MONGODB_URI'];
    delete process.env['SCHEDULER_ENABLED'];
    delete process.env['WORLD_NPC_COUNT'];
  }, 60_000);

  afterEach(async () => {
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
  }

  // A fresh guest account + session, via the real `POST /api/auth/guest` endpoint —
  // `sendScouts`/`cancelMovement` are ownership-checked, so exercising them needs a real
  // authenticated caller. `sendScouts` never inspects `account.faction` (unlike
  // `trainScouts`) — a settlement's `troops` already only ever holds units that were validly
  // trained, so a bare guest account is enough here.
  async function createGuestSession(): Promise<GuestSession> {
    const response = await request(app.getHttpServer()).post('/api/auth/guest').send({});
    expect(response.status).toBe(201);
    const setCookie = response.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    return {
      accountId: new Types.ObjectId(response.body.id as string),
      cookie: setCookie as unknown as string[],
    };
  }

  const ABUNDANT_RESOURCES: Resources = {
    scrap: 1_000_000,
    fuel: 1_000_000,
    electronics: 1_000_000,
    food: 1_000_000,
  };

  interface SeedSettlementOptions {
    buildings?: Array<{ type: string; level: number }>;
    troops?: Array<{ unitType: string; count: number }>;
    resources?: Resources;
  }

  // Seeds a settlement directly via Mongoose at a fixed, caller-chosen coordinate (bypassing
  // the real placement/creation/train flows — deliberately, so these fixtures can set
  // arbitrary troops/buildings/coordinates without going through `PlacementService`'s
  // randomized draw or `trainScouts`' full command flow). Coordinates are caller-controlled
  // (not random, unlike `settlements.integration.spec.ts`'s own `seedSettlement`) because
  // this suite needs known, distinct origin/target pairs.
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

  function postSend(cookie: string[], body: Record<string, unknown>) {
    return request(app.getHttpServer()).post('/api/movements').set('Cookie', cookie).send(body);
  }

  function postCancel(cookie: string[], movementId: string) {
    return request(app.getHttpServer())
      .post(`/api/movements/${movementId}/cancel`)
      .set('Cookie', cookie);
  }

  function getMine(cookie: string[]) {
    return request(app.getHttpServer()).get('/api/movements/mine').set('Cookie', cookie);
  }

  // Forces the pending `movementArrive`/`movementReturn` event for a movement overdue and
  // runs the scheduler once — the same determinism trick `settlements.integration.spec.ts`'s
  // `completeQueueItem`/`completeTrainingUnit` use, so resolution doesn't depend on real
  // travel-time durations.
  async function forceArrive(movementId: string): Promise<void> {
    // Also backdates `departAt` comfortably into the past first: `MovementArriveHandler`
    // computes the follow-up `movementReturn`'s `dueAt` as `computeReturnAt(departAt,
    // event.dueAt)` = `event.dueAt + (event.dueAt - departAt)`. If `departAt` is real "just
    // now" (as it is right after `sendScouts`) and only the arrive event's own `dueAt` is
    // forced slightly into the past, that formula can land the *return* event's `dueAt` in
    // the past too — and `runOnce()`'s claim loop would then dispatch it in the very same
    // pass, jumping straight past the `returning` state this helper exists to let a test
    // observe. Backdating `departAt` first guarantees a wide, safe gap regardless of how
    // close together `departAt` and "now" happen to be.
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

  async function forceReturn(movementId: string): Promise<void> {
    await eventModel.updateOne(
      { type: 'movementReturn', 'payload.movementId': movementId },
      { $set: { dueAt: Date.now() - 1_000 } },
    );
    await schedulerService.runOnce();
  }

  // Generous ceiling for wall-clock time that can elapse between two settle points inside one
  // test — mirrors `settlements.integration.spec.ts`'s identical constant/rationale.
  const MAX_TEST_ELAPSED_MS = 5_000;

  // Bounds a resource snapshot against the natural production/upkeep drift of `buildings`/
  // `troops` over at most `MAX_TEST_ELAPSED_MS` — mirrors
  // `settlements.integration.spec.ts`'s `expectResourcesCloseTo` exactly (same rationale:
  // resources settle continuously, so two snapshots taken moments apart are never bit-exact).
  function expectResourcesCloseTo(
    actual: Resources,
    expected: Resources,
    buildings: BuildingLevels,
    troops: TroopCounts = [],
  ): void {
    const rates = calcNetRates(config, buildings, troops);
    for (const kind of RESOURCE_KINDS) {
      const maxDrift = (Math.abs(rates[kind]) * MAX_TEST_ELAPSED_MS) / HOUR_MS + 1e-6;
      expect(
        Math.abs(actual[kind] - expected[kind]),
        `${kind}: expected ${actual[kind]} to be within ${maxDrift} of ${expected[kind]}`,
      ).toBeLessThanOrEqual(maxDrift);
    }
  }

  // Mongoose subdocument arrays (`Settlement.troops`, `Movement.units`/`.survivors`) are not
  // plain objects — `toEqual`-ing one directly against a literal fails even when the data
  // matches (see `toPlainQueueItem`'s comment in `settlements/build-queue.util.ts` for the
  // general hazard). Reshape to plain `{unitType, count}` objects first.
  function plainUnitEntries(
    list: ReadonlyArray<{ unitType: string; count: number }> | undefined,
  ): Array<{ unitType: string; count: number }> {
    return (list ?? []).map((u) => ({ unitType: u.unitType, count: u.count }));
  }

  it('acceptance criterion: send -> arrive -> return, losses match the hand-computed formula, base-tier intel, defender detected', async () => {
    const attacker = await createGuestSession();
    const defender = await createGuestSession();

    const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
      troops: [{ unitType: 'falconer', count: 2 }],
    });
    const defenderBuildings = [{ type: 'commandCenter', level: 1 }];
    const defenderTroops = [{ unitType: 'lookout', count: 2 }];
    await seedSettlementAt(defender.accountId, 5, 0, {
      buildings: defenderBuildings,
      troops: defenderTroops,
    });

    const sendResponse = await postSend(attacker.cookie, {
      type: 'scout',
      fromSettlementId: String(attackerSettlement._id),
      target: { x: 5, y: 0 },
      units: [{ unitType: 'falconer', count: 2 }],
    });
    expect(sendResponse.status).toBe(201);
    expect(sendResponse.body.status).toBe('outbound');
    expect(sendResponse.body.units).toEqual([{ unitType: 'falconer', count: 2 }]);
    expect(sendResponse.body.arriveAt).toBeGreaterThan(sendResponse.body.departAt);
    const movementId = sendResponse.body.id as string;

    // Deducted from home troops immediately (departure is immediate, no rally point).
    const originAfterSend = await settlementModel.findById(attackerSettlement._id);
    expect(originAfterSend?.troops.find((t) => t.unitType === 'falconer')).toBeUndefined();

    const arriveEvent = await eventModel.findOne({
      type: 'movementArrive',
      'payload.movementId': movementId,
    });
    expect(arriveEvent).not.toBeNull();
    expect(arriveEvent?.status).toBe('due');

    await forceArrive(movementId);

    // Hand-computed via the real `game-core` formula, both to prove the exact fixed-case
    // numbers below aren't stale AND to catch a future formula regression the fixed numbers
    // alone couldn't (per the brief: derive the expectation, and also pin concrete numbers).
    const expectedCombat = resolveScoutCombat(
      config,
      [{ unitType: 'falconer', count: 2 }],
      [{ unitType: 'lookout', count: 2 }],
    );
    expect(expectedCombat.losses).toEqual([{ unitType: 'falconer', count: 1 }]);
    expect(expectedCombat.survivors).toEqual([{ unitType: 'falconer', count: 1 }]);

    const movementAfterArrive = await movementModel.findById(movementId);
    expect(movementAfterArrive?.status).toBe('returning');
    expect(plainUnitEntries(movementAfterArrive?.survivors)).toEqual([
      { unitType: 'falconer', count: 1 },
    ]);

    const attackerReport = await reportModel.findOne({ accountId: attacker.accountId });
    expect(attackerReport).not.toBeNull();
    expect(attackerReport?.type).toBe('scout');
    const attackerPayload = attackerReport?.payload as {
      losses: Array<{ unitType: string; count: number }>;
      survivors: Array<{ unitType: string; count: number }>;
      intel: {
        tier: string;
        resources: Resources;
        storageCaps: Resources;
        troops: Array<{ unitType: string; count: number }>;
        buildings?: unknown;
      };
    };
    expect(attackerPayload.losses).toEqual([{ unitType: 'falconer', count: 1 }]);
    expect(attackerPayload.survivors).toEqual([{ unitType: 'falconer', count: 1 }]);
    expect(attackerPayload.intel.tier).toBe('base');
    expect(attackerPayload.intel.buildings).toBeUndefined();
    expect(attackerPayload.intel.troops).toEqual(defenderTroops);
    expect(attackerPayload.intel.storageCaps).toEqual(
      calcStorageCaps(config, defenderBuildings as BuildingLevels),
    );
    expectResourcesCloseTo(
      attackerPayload.intel.resources,
      ABUNDANT_RESOURCES,
      defenderBuildings as BuildingLevels,
      defenderTroops as TroopCounts,
    );

    const defenderReport = await reportModel.findOne({ accountId: defender.accountId });
    expect(defenderReport).not.toBeNull();
    expect(defenderReport?.type).toBe('scoutDetected');
    expect(defenderReport?.payload).toMatchObject({
      attackerSettlementId: String(attackerSettlement._id),
      attackerAccountId: String(attacker.accountId),
    });

    const returnEvent = await eventModel.findOne({
      type: 'movementReturn',
      'payload.movementId': movementId,
    });
    expect(returnEvent).not.toBeNull();

    await forceReturn(movementId);

    const movementAfterReturn = await movementModel.findById(movementId);
    expect(movementAfterReturn?.status).toBe('done');

    const originAfterReturn = await settlementModel.findById(attackerSettlement._id);
    expect(plainUnitEntries(originAfterReturn?.troops)).toEqual([
      { unitType: 'falconer', count: 1 },
    ]);
  });

  it('buildings tier: a Radio Tower differential >= 1 adds the full building list to the intel', async () => {
    const attacker = await createGuestSession();
    const defender = await createGuestSession();

    const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
      buildings: [
        { type: 'commandCenter', level: 1 },
        { type: 'radioTower', level: 1 },
      ],
      troops: [{ unitType: 'falconer', count: 2 }],
    });
    const defenderBuildings = [{ type: 'commandCenter', level: 1 }];
    const defenderSettlement = await seedSettlementAt(defender.accountId, 5, 0, {
      buildings: defenderBuildings,
      troops: [{ unitType: 'lookout', count: 2 }],
    });

    const sendResponse = await postSend(attacker.cookie, {
      type: 'scout',
      fromSettlementId: String(attackerSettlement._id),
      target: { x: 5, y: 0 },
      units: [{ unitType: 'falconer', count: 2 }],
    });
    expect(sendResponse.status).toBe(201);
    await forceArrive(sendResponse.body.id as string);

    const report = await reportModel.findOne({ accountId: attacker.accountId });
    const payload = report?.payload as { intel: { tier: string; buildings?: BuildingLevels } };
    expect(payload.intel.tier).toBe('buildings');
    expect(payload.intel.buildings).toEqual(
      defenderSettlement.buildings.map((b) => ({ type: b.type, level: b.level })),
    );
  });

  it('undetected: a defender with no scouts home gets no report; the attacker still gets full base intel and loses nothing', async () => {
    const attacker = await createGuestSession();
    const defender = await createGuestSession();

    const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
      troops: [{ unitType: 'falconer', count: 1 }],
    });
    await seedSettlementAt(defender.accountId, 5, 0, {
      troops: [], // no scouts home — the scout passes undetected
    });

    const sendResponse = await postSend(attacker.cookie, {
      type: 'scout',
      fromSettlementId: String(attackerSettlement._id),
      target: { x: 5, y: 0 },
      units: [{ unitType: 'falconer', count: 1 }],
    });
    expect(sendResponse.status).toBe(201);
    await forceArrive(sendResponse.body.id as string);

    const defenderReport = await reportModel.findOne({ accountId: defender.accountId });
    expect(defenderReport).toBeNull();

    const attackerReport = await reportModel.findOne({ accountId: attacker.accountId });
    expect(attackerReport?.type).toBe('scout');
    const payload = attackerReport?.payload as {
      losses: Array<{ unitType: string; count: number }>;
      intel: { tier: string; troops: unknown[] };
    };
    expect(payload.losses).toEqual([{ unitType: 'falconer', count: 0 }]);
    expect(payload.intel.tier).toBe('base');
    expect(payload.intel.troops).toEqual([]);

    const movement = await movementModel.findById(sendResponse.body.id as string);
    expect(plainUnitEntries(movement?.survivors)).toEqual([{ unitType: 'falconer', count: 1 }]);
  });

  it('total wipe: attacker gets scoutFailed with no intel, no return event, movement ends done, defender troops untouched', async () => {
    const attacker = await createGuestSession();
    const defender = await createGuestSession();

    const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
      troops: [{ unitType: 'falconer', count: 1 }],
    });
    const defenderTroops = [{ unitType: 'lookout', count: 3 }];
    const defenderSettlement = await seedSettlementAt(defender.accountId, 5, 0, {
      troops: defenderTroops,
    });

    const sendResponse = await postSend(attacker.cookie, {
      type: 'scout',
      fromSettlementId: String(attackerSettlement._id),
      target: { x: 5, y: 0 },
      units: [{ unitType: 'falconer', count: 1 }],
    });
    expect(sendResponse.status).toBe(201);
    const movementId = sendResponse.body.id as string;
    await forceArrive(movementId);

    const expectedCombat = resolveScoutCombat(
      config,
      [{ unitType: 'falconer', count: 1 }],
      defenderTroops as TroopCounts,
    );
    expect(expectedCombat.anySurvived).toBe(false);

    const movement = await movementModel.findById(movementId);
    expect(movement?.status).toBe('done');
    expect(plainUnitEntries(movement?.survivors)).toEqual([]);

    const returnEvent = await eventModel.findOne({
      type: 'movementReturn',
      'payload.movementId': movementId,
    });
    expect(returnEvent).toBeNull();

    const attackerReport = await reportModel.findOne({ accountId: attacker.accountId });
    expect(attackerReport?.type).toBe('scoutFailed');
    expect(attackerReport?.payload).toMatchObject({ reason: 'allScoutsDead' });
    expect((attackerReport?.payload as { intel?: unknown }).intel).toEqual({ tier: 'none' });

    // Detection depends only on the defender's home troops, not on whether the attacker
    // survived (§8) — a defender with scouts home is still detected even on a total wipe.
    const defenderReport = await reportModel.findOne({ accountId: defender.accountId });
    expect(defenderReport?.type).toBe('scoutDetected');

    const defenderAfter = await settlementModel.findById(defenderSettlement._id);
    expect(plainUnitEntries(defenderAfter?.troops)).toEqual(defenderTroops);
  });

  it('cancel: within the window flips to returning at departAt + 2*elapsed and deletes the arrive event', async () => {
    const attacker = await createGuestSession();
    const defender = await createGuestSession();

    const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
      troops: [{ unitType: 'falconer', count: 2 }],
    });
    // Far enough away that the real travel time comfortably outlasts this test's own runtime
    // — cancel must land while the movement is still genuinely `outbound`.
    await seedSettlementAt(defender.accountId, 30, 30, {
      troops: [{ unitType: 'lookout', count: 1 }],
    });

    const sendResponse = await postSend(attacker.cookie, {
      type: 'scout',
      fromSettlementId: String(attackerSettlement._id),
      target: { x: 30, y: 30 },
      units: [{ unitType: 'falconer', count: 2 }],
    });
    expect(sendResponse.status).toBe(201);
    const movementId = sendResponse.body.id as string;

    const before = Date.now();
    const cancelResponse = await postCancel(attacker.cookie, movementId);
    const after = Date.now();

    expect(cancelResponse.status).toBe(200);
    expect(cancelResponse.body.status).toBe('returning');
    expect(cancelResponse.body.survivors).toEqual([{ unitType: 'falconer', count: 2 }]);

    // `returnAt = turnAroundAt + (turnAroundAt - departAt)` (`computeReturnAt`) <=>
    // `turnAroundAt = (returnAt + departAt) / 2` — asserting the implied cancel-time falls in
    // `[before, after]` pins the exact rule rather than a loose inequality.
    const { departAt, returnAt } = cancelResponse.body as { departAt: number; returnAt: number };
    const impliedNow = (returnAt + departAt) / 2;
    expect(impliedNow).toBeGreaterThanOrEqual(before);
    expect(impliedNow).toBeLessThanOrEqual(after);

    const arriveEvent = await eventModel.findOne({
      type: 'movementArrive',
      'payload.movementId': movementId,
    });
    expect(arriveEvent).toBeNull();

    const returnEvent = await eventModel.findOne({
      type: 'movementReturn',
      'payload.movementId': movementId,
    });
    expect(returnEvent).not.toBeNull();
    expect(returnEvent?.dueAt).toBe(returnAt);

    await forceReturn(movementId);
    const originAfter = await settlementModel.findById(attackerSettlement._id);
    expect(plainUnitEntries(originAfter?.troops)).toEqual([{ unitType: 'falconer', count: 2 }]);
  });

  it('cancel: outside the window is rejected with its key and changes nothing', async () => {
    const attacker = await createGuestSession();
    const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
      troops: [{ unitType: 'falconer', count: 2 }],
    });

    const departAt = Date.now() - (config.movement.cancelWindowMs + 1_000);
    const movement = await movementModel.create({
      ownerAccountId: attacker.accountId,
      type: 'scout',
      fromSettlementId: attackerSettlement._id,
      toSettlementId: new Types.ObjectId(),
      target: { x: 10, y: 10 },
      units: [{ unitType: 'falconer', count: 2 }],
      survivors: [],
      departAt,
      arriveAt: departAt + 60_000,
      returnAt: null,
      status: 'outbound',
      version: 0,
    });

    const response = await postCancel(attacker.cookie, String(movement._id));
    expect(response.status).toBe(400);
    expect(response.body.error.key).toBe('errors.movement.cancelWindowExpired');

    const after = await movementModel.findById(movement._id);
    expect(after?.status).toBe('outbound');
  });

  it('cancel: another account cannot cancel it, and a wrong-status movement is not cancellable', async () => {
    const attacker = await createGuestSession();
    const stranger = await createGuestSession();
    const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
      troops: [{ unitType: 'falconer', count: 1 }],
    });
    await seedSettlementAt(stranger.accountId, 20, 20);

    const sendResponse = await postSend(attacker.cookie, {
      type: 'scout',
      fromSettlementId: String(attackerSettlement._id),
      target: { x: 20, y: 20 },
      units: [{ unitType: 'falconer', count: 1 }],
    });
    expect(sendResponse.status).toBe(201);
    const movementId = sendResponse.body.id as string;

    const strangerAttempt = await postCancel(stranger.cookie, movementId);
    expect(strangerAttempt.status).toBe(404);
    expect(strangerAttempt.body.error.key).toBe('errors.movement.notFound');

    const stillOutbound = await movementModel.findById(movementId);
    expect(stillOutbound?.status).toBe('outbound');

    const ownerCancel = await postCancel(attacker.cookie, movementId);
    expect(ownerCancel.status).toBe(200);

    const secondCancel = await postCancel(attacker.cookie, movementId);
    expect(secondCancel.status).toBe(400);
    expect(secondCancel.body.error.key).toBe('errors.movement.notCancellable');
  });

  it('idempotency: replaying movementArrive is a no-op (no second report, no second flip)', async () => {
    const attacker = await createGuestSession();
    const defender = await createGuestSession();
    const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
      troops: [{ unitType: 'falconer', count: 2 }],
    });
    await seedSettlementAt(defender.accountId, 5, 0, {
      troops: [{ unitType: 'lookout', count: 2 }],
    });

    const sendResponse = await postSend(attacker.cookie, {
      type: 'scout',
      fromSettlementId: String(attackerSettlement._id),
      target: { x: 5, y: 0 },
      units: [{ unitType: 'falconer', count: 2 }],
    });
    const movementId = sendResponse.body.id as string;
    const event = await eventModel.findOne({
      type: 'movementArrive',
      'payload.movementId': movementId,
    });
    expect(event).not.toBeNull();
    if (!event) throw new Error('unreachable');
    const confirmedEvent = event;

    async function replayArrive(): Promise<void> {
      const session = await connection.startSession();
      try {
        await session.withTransaction(async () => {
          await movementArriveHandler.handle(confirmedEvent, session);
        });
      } finally {
        await session.endSession();
      }
    }

    await replayArrive();
    const afterFirst = await movementModel.findById(movementId);
    expect(afterFirst?.status).toBe('returning');
    expect(await reportModel.countDocuments({ accountId: attacker.accountId })).toBe(1);
    expect(await reportModel.countDocuments({ accountId: defender.accountId })).toBe(1);

    await replayArrive();
    const afterSecond = await movementModel.findById(movementId);
    expect(afterSecond?.status).toBe('returning');
    expect(plainUnitEntries(afterSecond?.survivors)).toEqual(
      plainUnitEntries(afterFirst?.survivors),
    );
    expect(await reportModel.countDocuments({ accountId: attacker.accountId })).toBe(1);
    expect(await reportModel.countDocuments({ accountId: defender.accountId })).toBe(1);
  });

  it('idempotency: replaying movementReturn is a no-op (no double credit)', async () => {
    const attacker = await createGuestSession();
    const defender = await createGuestSession();
    const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
      troops: [{ unitType: 'falconer', count: 2 }],
    });
    await seedSettlementAt(defender.accountId, 5, 0, {
      troops: [{ unitType: 'lookout', count: 2 }],
    });

    const sendResponse = await postSend(attacker.cookie, {
      type: 'scout',
      fromSettlementId: String(attackerSettlement._id),
      target: { x: 5, y: 0 },
      units: [{ unitType: 'falconer', count: 2 }],
    });
    const movementId = sendResponse.body.id as string;
    await forceArrive(movementId);

    const event = await eventModel.findOne({
      type: 'movementReturn',
      'payload.movementId': movementId,
    });
    expect(event).not.toBeNull();
    if (!event) throw new Error('unreachable');
    const confirmedEvent = event;

    async function replayReturn(): Promise<void> {
      const session = await connection.startSession();
      try {
        await session.withTransaction(async () => {
          await movementReturnHandler.handle(confirmedEvent, session);
        });
      } finally {
        await session.endSession();
      }
    }

    await replayReturn();
    const afterFirst = await settlementModel.findById(attackerSettlement._id);
    expect(plainUnitEntries(afterFirst?.troops)).toEqual([{ unitType: 'falconer', count: 1 }]);
    expect((await movementModel.findById(movementId))?.status).toBe('done');

    await replayReturn();
    const afterSecond = await settlementModel.findById(attackerSettlement._id);
    expect(plainUnitEntries(afterSecond?.troops)).toEqual([{ unitType: 'falconer', count: 1 }]);
  });

  it('the playbook race: two concurrent sends of the same last scout — exactly one succeeds, troops never go negative, exactly one movement exists', async () => {
    const attacker = await createGuestSession();
    const targetOne = await createGuestSession();
    const targetTwo = await createGuestSession();

    const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
      troops: [{ unitType: 'falconer', count: 1 }],
    });
    await seedSettlementAt(targetOne.accountId, 5, 0);
    await seedSettlementAt(targetTwo.accountId, -5, 0);

    const [responseA, responseB] = await Promise.all([
      postSend(attacker.cookie, {
        type: 'scout',
        fromSettlementId: String(attackerSettlement._id),
        target: { x: 5, y: 0 },
        units: [{ unitType: 'falconer', count: 1 }],
      }),
      postSend(attacker.cookie, {
        type: 'scout',
        fromSettlementId: String(attackerSettlement._id),
        target: { x: -5, y: 0 },
        units: [{ unitType: 'falconer', count: 1 }],
      }),
    ]);

    const statuses = [responseA.status, responseB.status].sort();
    expect(statuses).toEqual([201, 400]);
    const failure = responseA.status === 400 ? responseA : responseB;
    expect(failure.body.error.key).toBe('errors.movement.insufficientTroops');

    // Never negative, and — since the loser's `findOneAndUpdate` never lands — exactly the
    // one winning send's deduction, no more.
    const state = await settlementModel.findById(attackerSettlement._id);
    const falconerEntry = state?.troops.find((t) => t.unitType === 'falconer');
    expect(falconerEntry?.count ?? 0).toBe(0);

    const movements = await movementModel.find({ ownerAccountId: attacker.accountId });
    expect(movements).toHaveLength(1);
  });

  it('validation: unknown movement type is rejected and changes nothing', async () => {
    const attacker = await createGuestSession();
    const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
      troops: [{ unitType: 'falconer', count: 1 }],
    });
    const response = await postSend(attacker.cookie, {
      type: 'settle',
      fromSettlementId: String(attackerSettlement._id),
      target: { x: 5, y: 0 },
      units: [{ unitType: 'falconer', count: 1 }],
    });
    expect(response.status).toBe(400);
    expect(response.body.error.key).toBe('errors.movement.unknownType');
    expect(await movementModel.countDocuments({})).toBe(0);
  });

  it('validation: an empty unit list is rejected', async () => {
    const attacker = await createGuestSession();
    const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0);
    const response = await postSend(attacker.cookie, {
      type: 'scout',
      fromSettlementId: String(attackerSettlement._id),
      target: { x: 5, y: 0 },
      units: [],
    });
    expect(response.status).toBe(400);
    expect(response.body.error.key).toBe('errors.movement.emptyUnits');
  });

  it('validation: an all-zero unit list is rejected as empty (zero counts stripped before game-core)', async () => {
    const attacker = await createGuestSession();
    const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
      troops: [{ unitType: 'falconer', count: 1 }],
    });
    const response = await postSend(attacker.cookie, {
      type: 'scout',
      fromSettlementId: String(attackerSettlement._id),
      target: { x: 5, y: 0 },
      units: [{ unitType: 'falconer', count: 0 }],
    });
    expect(response.status).toBe(400);
    expect(response.body.error.key).toBe('errors.movement.emptyUnits');
  });

  it('validation: a negative or non-integer count is rejected', async () => {
    const attacker = await createGuestSession();
    const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
      troops: [{ unitType: 'falconer', count: 5 }],
    });

    const negative = await postSend(attacker.cookie, {
      type: 'scout',
      fromSettlementId: String(attackerSettlement._id),
      target: { x: 5, y: 0 },
      units: [{ unitType: 'falconer', count: -1 }],
    });
    expect(negative.status).toBe(400);
    expect(negative.body.error.key).toBe('errors.movement.invalidCount');

    const fractional = await postSend(attacker.cookie, {
      type: 'scout',
      fromSettlementId: String(attackerSettlement._id),
      target: { x: 5, y: 0 },
      units: [{ unitType: 'falconer', count: 1.5 }],
    });
    expect(fractional.status).toBe(400);
    expect(fractional.body.error.key).toBe('errors.movement.invalidCount');

    expect(await movementModel.countDocuments({})).toBe(0);
  });

  it('validation: a non-scout unit type is rejected', async () => {
    const attacker = await createGuestSession();
    const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
      troops: [{ unitType: 'falconer', count: 1 }],
    });
    const response = await postSend(attacker.cookie, {
      type: 'scout',
      fromSettlementId: String(attackerSettlement._id),
      target: { x: 5, y: 0 },
      units: [{ unitType: 'not-a-real-unit', count: 1 }],
    });
    expect(response.status).toBe(400);
    expect(response.body.error.key).toBe('errors.movement.notScout');
  });

  it('validation: more units than are home is rejected', async () => {
    const attacker = await createGuestSession();
    const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
      troops: [{ unitType: 'falconer', count: 1 }],
    });
    const response = await postSend(attacker.cookie, {
      type: 'scout',
      fromSettlementId: String(attackerSettlement._id),
      target: { x: 5, y: 0 },
      units: [{ unitType: 'falconer', count: 2 }],
    });
    expect(response.status).toBe(400);
    expect(response.body.error.key).toBe('errors.movement.insufficientTroops');
    const state = await settlementModel.findById(attackerSettlement._id);
    expect(plainUnitEntries(state?.troops)).toEqual([{ unitType: 'falconer', count: 1 }]);
  });

  it('validation: a target with no settlement is rejected', async () => {
    const attacker = await createGuestSession();
    const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
      troops: [{ unitType: 'falconer', count: 1 }],
    });
    const response = await postSend(attacker.cookie, {
      type: 'scout',
      fromSettlementId: String(attackerSettlement._id),
      target: { x: 29, y: 29 },
      units: [{ unitType: 'falconer', count: 1 }],
    });
    expect(response.status).toBe(400);
    expect(response.body.error.key).toBe('errors.movement.targetNotSettlement');
  });

  it('validation: targeting your own settlement is rejected', async () => {
    const attacker = await createGuestSession();
    const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
      troops: [{ unitType: 'falconer', count: 1 }],
    });
    const response = await postSend(attacker.cookie, {
      type: 'scout',
      fromSettlementId: String(attackerSettlement._id),
      target: { x: 0, y: 0 },
      units: [{ unitType: 'falconer', count: 1 }],
    });
    expect(response.status).toBe(400);
    expect(response.body.error.key).toBe('errors.movement.targetIsOwnSettlement');
  });

  it('validation: an unknown or foreign origin settlement 404s', async () => {
    const attacker = await createGuestSession();
    const stranger = await createGuestSession();
    const strangerSettlement = await seedSettlementAt(stranger.accountId, 0, 0, {
      troops: [{ unitType: 'falconer', count: 1 }],
    });

    const malformed = await postSend(attacker.cookie, {
      type: 'scout',
      fromSettlementId: 'not-an-id',
      target: { x: 5, y: 0 },
      units: [{ unitType: 'falconer', count: 1 }],
    });
    expect(malformed.status).toBe(404);
    expect(malformed.body.error.key).toBe('errors.settlement.notFound');

    const foreign = await postSend(attacker.cookie, {
      type: 'scout',
      fromSettlementId: String(strangerSettlement._id),
      target: { x: 5, y: 0 },
      units: [{ unitType: 'falconer', count: 1 }],
    });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.key).toBe('errors.settlement.notFound');
  });

  it('ownership/visibility: GET /api/movements/mine returns only the caller’s own movements', async () => {
    const accountA = await createGuestSession();
    const accountB = await createGuestSession();
    const settlementA = await seedSettlementAt(accountA.accountId, 0, 0, {
      troops: [{ unitType: 'falconer', count: 1 }],
    });
    await seedSettlementAt(accountB.accountId, 5, 0);

    const sendResponse = await postSend(accountA.cookie, {
      type: 'scout',
      fromSettlementId: String(settlementA._id),
      target: { x: 5, y: 0 },
      units: [{ unitType: 'falconer', count: 1 }],
    });
    expect(sendResponse.status).toBe(201);

    const mineA = await getMine(accountA.cookie);
    expect(mineA.status).toBe(200);
    expect(mineA.body).toHaveLength(1);
    expect(mineA.body[0].id).toBe(sendResponse.body.id);

    const mineB = await getMine(accountB.cookie);
    expect(mineB.status).toBe(200);
    expect(mineB.body).toHaveLength(0);
  });
});
