import { randomUUID } from 'node:crypto';

import type { BuildingLevels, GameConfig, Resources, TroopCounts } from '@last-signal/game-core';
import {
  DEFAULT_CONFIG,
  HOUR_MS,
  RESOURCE_KINDS,
  addResources,
  battleRoll,
  calcNetFoodPerHour,
  calcNetRates,
  calcStorageCaps,
  calcTroopFoodUpkeepPerHour,
  chebyshevDistance,
  hiddenCacheProtection,
  resolveBattle,
  resolveLoot,
  resolveScoutCombat,
  resolveSiegePass,
  settleResources,
  slowestTroopSpeed,
  subtractResources,
  travelTimeMs,
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
import { stationedContingentKey } from '../settlements/settlements.util';
import { WorldService } from '../world/world.service';
import { MovementArriveHandler } from './handlers/movement-arrive.handler';
import { MovementReturnHandler } from './handlers/movement-return.handler';
import { mergeUnitCounts, subtractUnitCounts } from './movements.util';

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
  let worldService: WorldService;

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

  // Reads a settlement's own wire view (`GET /api/settlements/:id`) — the acceptance
  // criterion for this suite's M3a.4 tests is stated in terms of what the *client* sees
  // (`netFoodPerHour`, `troops`, `awayTroops`), not the raw Mongo document, so these tests
  // go through the real read path rather than `settlementModel.findById` for those fields.
  function getSettlement(cookie: string[], settlementId: string) {
    return request(app.getHttpServer())
      .get(`/api/settlements/${settlementId}`)
      .set('Cookie', cookie);
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

  // M3a.4 acceptance criterion (`docs/M3_DESIGN_DECISIONS.md` §20, §19.1): "sending an army
  // away leaves upkeep unchanged (gap #1 closed, asserted numerically)". Before this step,
  // `netFoodPerHour` was computed from `troops` alone, so marching every unit out dropped
  // upkeep to zero — a live exploit the moment armies exist. These tests go through the real
  // `GET /api/settlements/:id` read path (not the raw Mongo document) because that's the
  // number the client actually sees and the exploit actually hid behind.
  describe('M3a.4: awayTroops accounting closes the in-flight upkeep exploit', () => {
    it('sending troops away leaves netFoodPerHour exactly unchanged, and moves the counts troops -> awayTroops', async () => {
      const attacker = await createGuestSession();
      const defender = await createGuestSession();
      const troops = [{ unitType: 'falconer', count: 3 }];
      const buildings: BuildingLevels = [{ type: 'commandCenter', level: 1 }];
      const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, { troops });
      await seedSettlementAt(defender.accountId, 5, 0);

      const expectedNetFood = calcNetFoodPerHour(config, buildings, troops as TroopCounts);

      const before = await getSettlement(attacker.cookie, String(attackerSettlement._id));
      expect(before.status).toBe(200);
      expect(before.body.netFoodPerHour).toBeCloseTo(expectedNetFood, 6);
      expect(before.body.troops).toEqual(troops);
      expect(before.body.awayTroops).toEqual([]);

      const sendResponse = await postSend(attacker.cookie, {
        type: 'scout',
        fromSettlementId: String(attackerSettlement._id),
        target: { x: 5, y: 0 },
        units: troops,
      });
      expect(sendResponse.status).toBe(201);

      const after = await getSettlement(attacker.cookie, String(attackerSettlement._id));
      expect(after.status).toBe(200);
      // Exactly equal, not just close — `netFoodPerHour` is a pure function of buildings and
      // the *union* of the three troop lists (`upkeepTroopsOf`), not of elapsed time, so an
      // army moving `troops -> awayTroops` must produce the bit-identical number.
      expect(after.body.netFoodPerHour).toBe(before.body.netFoodPerHour);
      expect(after.body.troops).toEqual([]);
      expect(after.body.awayTroops).toEqual(troops);
    });

    it('round trip: after the return handler runs, awayTroops is empty again, troops match the original, and netFoodPerHour matches the original', async () => {
      const attacker = await createGuestSession();
      const defender = await createGuestSession();
      const troops = [{ unitType: 'falconer', count: 2 }];
      const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, { troops });
      // No defenders at home: the scouts pass undetected and every one of them survives
      // (mirrors the "undetected" test above) — a clean round trip with nothing to lose.
      await seedSettlementAt(defender.accountId, 5, 0, { troops: [] });

      const before = await getSettlement(attacker.cookie, String(attackerSettlement._id));

      const sendResponse = await postSend(attacker.cookie, {
        type: 'scout',
        fromSettlementId: String(attackerSettlement._id),
        target: { x: 5, y: 0 },
        units: troops,
      });
      expect(sendResponse.status).toBe(201);
      const movementId = sendResponse.body.id as string;

      await forceArrive(movementId);
      await forceReturn(movementId);

      const after = await getSettlement(attacker.cookie, String(attackerSettlement._id));
      expect(after.body.troops).toEqual(troops);
      expect(after.body.awayTroops).toEqual([]);
      expect(after.body.netFoodPerHour).toBe(before.body.netFoodPerHour);
    });

    it('losses leave awayTroops at arrival (survivors stay away until they actually land), and netFoodPerHour rises by exactly the dead units’ upkeep', async () => {
      const attacker = await createGuestSession();
      const defender = await createGuestSession();
      const troops = [{ unitType: 'falconer', count: 2 }];
      const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, { troops });
      const defenderTroops = [{ unitType: 'lookout', count: 2 }];
      await seedSettlementAt(defender.accountId, 5, 0, { troops: defenderTroops });

      const sendResponse = await postSend(attacker.cookie, {
        type: 'scout',
        fromSettlementId: String(attackerSettlement._id),
        target: { x: 5, y: 0 },
        units: troops,
      });
      expect(sendResponse.status).toBe(201);
      const movementId = sendResponse.body.id as string;

      const beforeArrive = await getSettlement(attacker.cookie, String(attackerSettlement._id));
      expect(beforeArrive.body.awayTroops).toEqual(troops);

      // Hand-computed via the real `game-core` formula, same convention as the acceptance
      // test above: pins the exact losses this test's assertions depend on.
      const expectedCombat = resolveScoutCombat(
        config,
        troops as TroopCounts,
        defenderTroops as TroopCounts,
      );
      expect(expectedCombat.losses).toEqual([{ unitType: 'falconer', count: 1 }]);

      await forceArrive(movementId);

      const afterArrive = await getSettlement(attacker.cookie, String(attackerSettlement._id));
      // 2 sent, 1 died at arrival, 1 survives and stays "away" until the return leg lands it
      // home (`MovementReturnHandler`'s job, not `MovementArriveHandler`'s).
      expect(afterArrive.body.awayTroops).toEqual([{ unitType: 'falconer', count: 1 }]);

      const deadUpkeepPerHour = calcTroopFoodUpkeepPerHour(config, [
        { unitType: 'falconer', count: 1 },
      ]);
      expect(afterArrive.body.netFoodPerHour).toBeCloseTo(
        beforeArrive.body.netFoodPerHour + deadUpkeepPerHour,
        6,
      );
    });

    it('total wipe: every attacking unit leaves awayTroops, and netFoodPerHour returns to the no-troops value', async () => {
      const attacker = await createGuestSession();
      const defender = await createGuestSession();
      const troops = [{ unitType: 'falconer', count: 1 }];
      const buildings: BuildingLevels = [{ type: 'commandCenter', level: 1 }];
      const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, { troops });
      const defenderTroops = [{ unitType: 'lookout', count: 3 }];
      await seedSettlementAt(defender.accountId, 5, 0, { troops: defenderTroops });

      const sendResponse = await postSend(attacker.cookie, {
        type: 'scout',
        fromSettlementId: String(attackerSettlement._id),
        target: { x: 5, y: 0 },
        units: troops,
      });
      expect(sendResponse.status).toBe(201);
      const movementId = sendResponse.body.id as string;

      const expectedCombat = resolveScoutCombat(
        config,
        troops as TroopCounts,
        defenderTroops as TroopCounts,
      );
      expect(expectedCombat.anySurvived).toBe(false);

      await forceArrive(movementId);

      const after = await getSettlement(attacker.cookie, String(attackerSettlement._id));
      expect(after.body.troops).toEqual([]);
      expect(after.body.awayTroops).toEqual([]);

      const noTroopsNetFood = calcNetFoodPerHour(config, buildings, []);
      expect(after.body.netFoodPerHour).toBeCloseTo(noTroopsNetFood, 6);
    });

    // Upgrade-boundary safety: every movement already in flight the instant this step
    // deploys predates `awayTroops` entirely — it was deducted from `troops` at send under
    // the pre-M3a.4 code path, which never touched `awayTroops`, so the settlement's
    // `awayTroops` is `[]` even though a `returning` movement is carrying real survivors home.
    // `subtractUnitCounts` must clamp rather than throw here (see its own comment): the
    // survivors are already a resolved fact by the time the handler runs, and a thrown error
    // would dead-letter the event after retries, permanently losing the army instead of
    // crediting it — the exact failure this test exists to rule out.
    it('upgrade-boundary safety: awayTroops: [] does not stop a returning movement crediting its survivors home', async () => {
      const attacker = await createGuestSession();
      const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
        // Already debited at send time by the (pre-M3a.4) code that deducted `troops` but
        // never wrote `awayTroops` — exactly the state a movement sent before this step
        // shipped would be in.
        troops: [],
      });

      const survivors = [{ unitType: 'falconer', count: 2 }];
      const movement = await movementModel.create({
        ownerAccountId: attacker.accountId,
        type: 'scout',
        fromSettlementId: attackerSettlement._id,
        toSettlementId: new Types.ObjectId(),
        target: { x: 5, y: 0 },
        units: survivors,
        survivors,
        departAt: Date.now() - 120_000,
        arriveAt: Date.now() - 60_000,
        returnAt: Date.now() - 1_000,
        status: 'returning',
        version: 0,
      });

      const event = await eventModel.create({
        type: 'movementReturn',
        dueAt: Date.now() - 1_000,
        payload: { movementId: String(movement._id) },
      });

      // No wrapping try/catch around the handler call itself: if `subtractUnitCounts` threw
      // (the behaviour this test rules out), this `await` would reject and the test would
      // fail right here with that error — the same implicit "does not throw" proof
      // `replayArrive`/`replayReturn` above rely on.
      const session = await connection.startSession();
      try {
        await session.withTransaction(async () => {
          await movementReturnHandler.handle(event, session);
        });
      } finally {
        await session.endSession();
      }

      const after = await settlementModel.findById(attackerSettlement._id);
      expect(plainUnitEntries(after?.troops)).toEqual(survivors);
      // Clamped at zero, not negative — the whole point of this test.
      expect(plainUnitEntries(after?.awayTroops)).toEqual([]);
      expect((await movementModel.findById(movement._id))?.status).toBe('done');
    });
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
    // M3a.4: 2 falconers sent, 1 died at arrival — `awayTroops` holds exactly the survivor
    // that's still in transit (not yet home).
    const originAfterFirst = await settlementModel.findById(attackerSettlement._id);
    expect(plainUnitEntries(originAfterFirst?.awayTroops)).toEqual([
      { unitType: 'falconer', count: 1 },
    ]);

    await replayArrive();
    const afterSecond = await movementModel.findById(movementId);
    expect(afterSecond?.status).toBe('returning');
    expect(plainUnitEntries(afterSecond?.survivors)).toEqual(
      plainUnitEntries(afterFirst?.survivors),
    );
    expect(await reportModel.countDocuments({ accountId: attacker.accountId })).toBe(1);
    expect(await reportModel.countDocuments({ accountId: defender.accountId })).toBe(1);
    // Replaying the handler again must not subtract the same loss from `awayTroops` twice.
    const originAfterSecond = await settlementModel.findById(attackerSettlement._id);
    expect(plainUnitEntries(originAfterSecond?.awayTroops)).toEqual(
      plainUnitEntries(originAfterFirst?.awayTroops),
    );
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
    // M3a.4: the 1 surviving falconer just landed home — `awayTroops` drops back to empty,
    // not double-subtracted or left stuck at the post-arrival "1 still away" figure.
    expect(plainUnitEntries(afterFirst?.awayTroops)).toEqual([]);

    await replayReturn();
    const afterSecond = await settlementModel.findById(attackerSettlement._id);
    expect(plainUnitEntries(afterSecond?.troops)).toEqual([{ unitType: 'falconer', count: 1 }]);
    // Replaying the handler again must not subtract the same survivor from `awayTroops`
    // twice (which would throw inside `subtractUnitCounts` — that it doesn't is the point).
    expect(plainUnitEntries(afterSecond?.awayTroops)).toEqual([]);
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

  // M3c.3 (`docs/M3_DESIGN_DECISIONS.md` §9, §11): widens `sendMovement` from scout-only to
  // `raid`/`assault`/`support`, plus beginner-protection enforcement (and its early lift) at
  // send. Arrival resolution for these new types is explicitly the *next* step, not this one
  // — `MovementArriveHandler`'s new guard (tested at the bottom of this block) exists
  // precisely so a `raid` that arrives before that step lands fails loudly instead of quietly
  // resolving as a scout.
  describe('M3c.3: raid/assault/support send commands, beginner protection at send', () => {
    it('a raid sends: type raid, outbound, units deducted troops -> awayTroops, arriveAt matches the slowest unit’s travelTimeMs', async () => {
      const attacker = await createGuestSession();
      const defender = await createGuestSession();
      const troops = [{ unitType: 'brute', count: 5 }];
      const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, { troops });
      await seedSettlementAt(defender.accountId, 5, 0);

      const sendResponse = await postSend(attacker.cookie, {
        type: 'raid',
        fromSettlementId: String(attackerSettlement._id),
        target: { x: 5, y: 0 },
        units: troops,
      });
      expect(sendResponse.status).toBe(201);
      expect(sendResponse.body.type).toBe('raid');
      expect(sendResponse.body.status).toBe('outbound');
      const movementId = sendResponse.body.id as string;

      const movement = await movementModel.findById(movementId);
      expect(movement?.type).toBe('raid');
      expect(movement?.status).toBe('outbound');
      const distance = chebyshevDistance({ x: 0, y: 0 }, { x: 5, y: 0 });
      const speed = slowestTroopSpeed(config, troops as TroopCounts);
      expect(movement?.arriveAt).toBe(movement!.departAt + travelTimeMs(config, distance, speed));

      const origin = await settlementModel.findById(attackerSettlement._id);
      expect(plainUnitEntries(origin?.troops)).toEqual([]);
      expect(plainUnitEntries(origin?.awayTroops)).toEqual(troops);
    });

    describe('siege target (§7)', () => {
      it('an assault with siege units and a valid siegeTarget persists it', async () => {
        const attacker = await createGuestSession();
        const defender = await createGuestSession();
        const troops = [
          { unitType: 'brute', count: 5 },
          { unitType: 'ramTruck', count: 2 },
        ];
        const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, { troops });
        await seedSettlementAt(defender.accountId, 5, 0);

        const response = await postSend(attacker.cookie, {
          type: 'assault',
          fromSettlementId: String(attackerSettlement._id),
          target: { x: 5, y: 0 },
          units: troops,
          siegeTarget: 'warehouse',
        });
        expect(response.status).toBe(201);
        const movement = await movementModel.findById(response.body.id as string);
        expect(movement?.siegeTarget).toBe('warehouse');
      });

      it('the same assault without a siegeTarget is rejected with siegeTargetRequired', async () => {
        const attacker = await createGuestSession();
        const defender = await createGuestSession();
        const troops = [
          { unitType: 'brute', count: 5 },
          { unitType: 'ramTruck', count: 2 },
        ];
        const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, { troops });
        await seedSettlementAt(defender.accountId, 5, 0);

        const response = await postSend(attacker.cookie, {
          type: 'assault',
          fromSettlementId: String(attackerSettlement._id),
          target: { x: 5, y: 0 },
          units: troops,
        });
        expect(response.status).toBe(400);
        expect(response.body.error.key).toBe('errors.movement.siegeTargetRequired');
      });

      it('a raid carrying siege units is rejected with siegeOnlyOnAssault', async () => {
        const attacker = await createGuestSession();
        const defender = await createGuestSession();
        const troops = [{ unitType: 'ramTruck', count: 1 }];
        const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, { troops });
        await seedSettlementAt(defender.accountId, 5, 0);

        const response = await postSend(attacker.cookie, {
          type: 'raid',
          fromSettlementId: String(attackerSettlement._id),
          target: { x: 5, y: 0 },
          units: troops,
        });
        expect(response.status).toBe(400);
        expect(response.body.error.key).toBe('errors.movement.siegeOnlyOnAssault');
      });

      it('an unrecognised siegeTarget is rejected with invalidSiegeTarget', async () => {
        const attacker = await createGuestSession();
        const defender = await createGuestSession();
        const troops = [
          { unitType: 'brute', count: 1 },
          { unitType: 'ramTruck', count: 1 },
        ];
        const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, { troops });
        await seedSettlementAt(defender.accountId, 5, 0);

        const response = await postSend(attacker.cookie, {
          type: 'assault',
          fromSettlementId: String(attackerSettlement._id),
          target: { x: 5, y: 0 },
          units: troops,
          siegeTarget: 'notABuilding',
        });
        expect(response.status).toBe(400);
        expect(response.body.error.key).toBe('errors.movement.invalidSiegeTarget');
      });

      it('a siegeTarget on a raid is rejected with siegeTargetNotAllowed, even one that would otherwise be valid', async () => {
        const attacker = await createGuestSession();
        const defender = await createGuestSession();
        const troops = [{ unitType: 'brute', count: 1 }];
        const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, { troops });
        await seedSettlementAt(defender.accountId, 5, 0);

        const response = await postSend(attacker.cookie, {
          type: 'raid',
          fromSettlementId: String(attackerSettlement._id),
          target: { x: 5, y: 0 },
          units: troops,
          siegeTarget: 'wall',
        });
        expect(response.status).toBe(400);
        expect(response.body.error.key).toBe('errors.movement.siegeTargetNotAllowed');
      });

      it('an assault with a valid siegeTarget but no siege units succeeds and does not persist siegeTarget', async () => {
        const attacker = await createGuestSession();
        const defender = await createGuestSession();
        const troops = [{ unitType: 'brute', count: 5 }];
        const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, { troops });
        await seedSettlementAt(defender.accountId, 5, 0);

        const response = await postSend(attacker.cookie, {
          type: 'assault',
          fromSettlementId: String(attackerSettlement._id),
          target: { x: 5, y: 0 },
          units: troops,
          siegeTarget: 'wall',
        });
        expect(response.status).toBe(201);
        const movement = await movementModel.findById(response.body.id as string);
        expect(movement?.siegeTarget).toBeUndefined();
      });
    });

    it('a raid whose army is only scouts is rejected with scoutsInArmy', async () => {
      const attacker = await createGuestSession();
      const defender = await createGuestSession();
      const troops = [{ unitType: 'lookout', count: 2 }];
      const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, { troops });
      await seedSettlementAt(defender.accountId, 5, 0);

      const response = await postSend(attacker.cookie, {
        type: 'raid',
        fromSettlementId: String(attackerSettlement._id),
        target: { x: 5, y: 0 },
        units: troops,
      });
      expect(response.status).toBe(400);
      expect(response.body.error.key).toBe('errors.movement.scoutsInArmy');
    });

    // `noAttackPower` (a raid/assault army with zero total attack) has no reachable case
    // through `DEFAULT_CONFIG`'s real catalogue: every unit type not already barred by
    // `scoutsInArmy`/`unitNotAllowed` (i.e. every offenseInfantry/defenseInfantry/fast/siege
    // unit) has `attack > 0`. The underlying `sumAttackPoints` arithmetic — including the
    // `atkPts <= 0` case, via a fabricated 0-attack config — is covered directly in
    // `movements.util.spec.ts` instead.

    describe('support (§8)', () => {
      it('support to another account’s settlement succeeds', async () => {
        const attacker = await createGuestSession();
        const defender = await createGuestSession();
        const troops = [{ unitType: 'brute', count: 2 }];
        const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, { troops });
        await seedSettlementAt(defender.accountId, 5, 0);

        const response = await postSend(attacker.cookie, {
          type: 'support',
          fromSettlementId: String(attackerSettlement._id),
          target: { x: 5, y: 0 },
          units: troops,
        });
        expect(response.status).toBe(201);
        expect(response.body.type).toBe('support');
      });

      it('support to the caller’s own settlement succeeds', async () => {
        const attacker = await createGuestSession();
        const troops = [{ unitType: 'brute', count: 2 }];
        const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, { troops });

        const response = await postSend(attacker.cookie, {
          type: 'support',
          fromSettlementId: String(attackerSettlement._id),
          target: { x: 0, y: 0 },
          units: troops,
        });
        expect(response.status).toBe(201);
      });

      it('support containing scouts succeeds', async () => {
        const attacker = await createGuestSession();
        const defender = await createGuestSession();
        const troops = [{ unitType: 'lookout', count: 2 }];
        const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, { troops });
        await seedSettlementAt(defender.accountId, 5, 0);

        const response = await postSend(attacker.cookie, {
          type: 'support',
          fromSettlementId: String(attackerSettlement._id),
          target: { x: 5, y: 0 },
          units: troops,
        });
        expect(response.status).toBe(201);
      });

      it('support containing a siege unit is rejected', async () => {
        const attacker = await createGuestSession();
        const defender = await createGuestSession();
        const troops = [{ unitType: 'ramTruck', count: 1 }];
        const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, { troops });
        await seedSettlementAt(defender.accountId, 5, 0);

        const response = await postSend(attacker.cookie, {
          type: 'support',
          fromSettlementId: String(attackerSettlement._id),
          target: { x: 5, y: 0 },
          units: troops,
        });
        expect(response.status).toBe(400);
        expect(response.body.error.key).toBe('errors.movement.siegeOnlyOnAssault');
      });
    });

    it('settle and trade are still rejected with errors.movement.unknownType', async () => {
      const attacker = await createGuestSession();
      const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
        troops: [{ unitType: 'brute', count: 1 }],
      });

      for (const type of ['settle', 'trade']) {
        const response = await postSend(attacker.cookie, {
          type,
          fromSettlementId: String(attackerSettlement._id),
          target: { x: 5, y: 0 },
          units: [{ unitType: 'brute', count: 1 }],
        });
        expect(response.status).toBe(400);
        expect(response.body.error.key).toBe('errors.movement.unknownType');
      }
      expect(await movementModel.countDocuments({})).toBe(0);
    });

    describe('beginner protection (§11)', () => {
      it('a protected target rejects scout, raid, assault and support alike with targetProtected', async () => {
        const attacker = await createGuestSession();
        const defender = await createGuestSession();
        const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
          troops: [
            { unitType: 'brute', count: 5 },
            { unitType: 'lookout', count: 5 },
          ],
        });
        await seedSettlementAt(defender.accountId, 5, 0);
        await accountModel.updateOne(
          { _id: defender.accountId },
          { $set: { protectedUntil: Date.now() + 999_999 } },
        );

        const cases: Array<{ type: string; units: Array<{ unitType: string; count: number }> }> = [
          { type: 'scout', units: [{ unitType: 'lookout', count: 1 }] },
          { type: 'raid', units: [{ unitType: 'brute', count: 1 }] },
          { type: 'assault', units: [{ unitType: 'brute', count: 1 }] },
          { type: 'support', units: [{ unitType: 'brute', count: 1 }] },
        ];
        for (const { type, units } of cases) {
          const response = await postSend(attacker.cookie, {
            type,
            fromSettlementId: String(attackerSettlement._id),
            target: { x: 5, y: 0 },
            units,
          });
          expect(response.status).toBe(400);
          expect(response.body.error.key).toBe('errors.movement.targetProtected');
        }
        // Nothing was ever sent — every command was rejected before touching troops.
        const origin = await settlementModel.findById(attackerSettlement._id);
        expect(plainUnitEntries(origin?.awayTroops)).toEqual([]);
      });

      it('a target whose protection already expired, or was never set, is attackable', async () => {
        const attacker = await createGuestSession();
        const pastProtected = await createGuestSession();
        const neverProtected = await createGuestSession();
        const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
          troops: [{ unitType: 'brute', count: 2 }],
        });
        await seedSettlementAt(pastProtected.accountId, 5, 0);
        await accountModel.updateOne(
          { _id: pastProtected.accountId },
          { $set: { protectedUntil: Date.now() - 1_000 } },
        );
        await seedSettlementAt(neverProtected.accountId, -5, 0);

        const pastResponse = await postSend(attacker.cookie, {
          type: 'raid',
          fromSettlementId: String(attackerSettlement._id),
          target: { x: 5, y: 0 },
          units: [{ unitType: 'brute', count: 1 }],
        });
        expect(pastResponse.status).toBe(201);

        const neverResponse = await postSend(attacker.cookie, {
          type: 'raid',
          fromSettlementId: String(attackerSettlement._id),
          target: { x: -5, y: 0 },
          units: [{ unitType: 'brute', count: 1 }],
        });
        expect(neverResponse.status).toBe(201);
      });
    });

    describe('beginner protection lift (§11)', () => {
      it('a protected caller’s raid at another account’s settlement lifts their own protection to the send instant', async () => {
        const attacker = await createGuestSession();
        const defender = await createGuestSession();
        const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
          troops: [{ unitType: 'brute', count: 2 }],
        });
        await seedSettlementAt(defender.accountId, 5, 0);
        const originalProtectedUntil = Date.now() + 999_999;
        await accountModel.updateOne(
          { _id: attacker.accountId },
          { $set: { protectedUntil: originalProtectedUntil } },
        );

        const before = Date.now();
        const response = await postSend(attacker.cookie, {
          type: 'raid',
          fromSettlementId: String(attackerSettlement._id),
          target: { x: 5, y: 0 },
          units: [{ unitType: 'brute', count: 1 }],
        });
        const after = Date.now();
        expect(response.status).toBe(201);

        const updatedAttacker = await accountModel.findById(attacker.accountId);
        expect(updatedAttacker?.protectedUntil).toBeGreaterThanOrEqual(before);
        expect(updatedAttacker?.protectedUntil).toBeLessThanOrEqual(after);
        expect(updatedAttacker?.protectedUntil).toBeLessThan(originalProtectedUntil);
      });

      it('scouting and support do not lift the caller’s own protection', async () => {
        const attacker = await createGuestSession();
        const defender = await createGuestSession();
        const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
          troops: [
            { unitType: 'lookout', count: 2 },
            { unitType: 'brute', count: 2 },
          ],
        });
        await seedSettlementAt(defender.accountId, 5, 0);
        const originalProtectedUntil = Date.now() + 999_999;
        await accountModel.updateOne(
          { _id: attacker.accountId },
          { $set: { protectedUntil: originalProtectedUntil } },
        );

        const scoutResponse = await postSend(attacker.cookie, {
          type: 'scout',
          fromSettlementId: String(attackerSettlement._id),
          target: { x: 5, y: 0 },
          units: [{ unitType: 'lookout', count: 1 }],
        });
        expect(scoutResponse.status).toBe(201);
        expect((await accountModel.findById(attacker.accountId))?.protectedUntil).toBe(
          originalProtectedUntil,
        );

        // Support to the caller's own settlement — also must not lift it.
        const supportResponse = await postSend(attacker.cookie, {
          type: 'support',
          fromSettlementId: String(attackerSettlement._id),
          target: { x: 0, y: 0 },
          units: [{ unitType: 'brute', count: 1 }],
        });
        expect(supportResponse.status).toBe(201);
        expect((await accountModel.findById(attacker.accountId))?.protectedUntil).toBe(
          originalProtectedUntil,
        );
      });
    });

    describe('cancel (90s window) applies to every movement type (§9)', () => {
      it('cancel works for a raid: returning, survivors equal units, arrive event gone, return event exists', async () => {
        const attacker = await createGuestSession();
        const defender = await createGuestSession();
        const troops = [{ unitType: 'brute', count: 3 }];
        const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, { troops });
        // Far enough away that the real travel time comfortably outlasts this test's own
        // runtime — cancel must land while the movement is still genuinely `outbound`.
        await seedSettlementAt(defender.accountId, 30, 30);

        const sendResponse = await postSend(attacker.cookie, {
          type: 'raid',
          fromSettlementId: String(attackerSettlement._id),
          target: { x: 30, y: 30 },
          units: troops,
        });
        expect(sendResponse.status).toBe(201);
        const movementId = sendResponse.body.id as string;

        const cancelResponse = await postCancel(attacker.cookie, movementId);
        expect(cancelResponse.status).toBe(200);
        expect(cancelResponse.body.status).toBe('returning');
        expect(cancelResponse.body.survivors).toEqual(troops);

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
      });

      it('cancel works for a support: returning, survivors equal units, arrive event gone, return event exists', async () => {
        const attacker = await createGuestSession();
        const defender = await createGuestSession();
        const troops = [{ unitType: 'brute', count: 3 }];
        const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, { troops });
        await seedSettlementAt(defender.accountId, 30, 30);

        const sendResponse = await postSend(attacker.cookie, {
          type: 'support',
          fromSettlementId: String(attackerSettlement._id),
          target: { x: 30, y: 30 },
          units: troops,
        });
        expect(sendResponse.status).toBe(201);
        const movementId = sendResponse.body.id as string;

        const cancelResponse = await postCancel(attacker.cookie, movementId);
        expect(cancelResponse.status).toBe(200);
        expect(cancelResponse.body.status).toBe('returning');
        expect(cancelResponse.body.survivors).toEqual(troops);

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
      });
    });

    // M3c.3 pinned this same guard against a `raid` arrival — M3c.4 (this step) gives
    // `raid`/`assault` their own resolver (`BattleArrivalResolver`, see the
    // "M3c.4: raid/assault battle arrival" suite below), so the guard no longer applies to
    // them. `support` still has no arrival resolver (stationing lands in a later step) and is
    // the narrowest remaining case to pin this behaviour against.
    it('arrive-handler guard: a support arrival fails loudly rather than resolving as anything else — stays outbound, no report is written', async () => {
      const attacker = await createGuestSession();
      const defender = await createGuestSession();
      const troops = [{ unitType: 'brute', count: 3 }];
      const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, { troops });
      await seedSettlementAt(defender.accountId, 5, 0);

      const sendResponse = await postSend(attacker.cookie, {
        type: 'support',
        fromSettlementId: String(attackerSettlement._id),
        target: { x: 5, y: 0 },
        units: troops,
      });
      expect(sendResponse.status).toBe(201);
      const movementId = sendResponse.body.id as string;

      // `forceArrive` drives the real `SchedulerService.runOnce()` (not the handler
      // directly), so the handler's thrown error is caught by `SchedulerService.dispatch`'s
      // own try/catch exactly as it would be in production — the movement's transaction
      // rolls back, and the event's own retry bookkeeping (outside that transaction) records
      // the failure instead.
      await forceArrive(movementId);

      const movement = await movementModel.findById(movementId);
      expect(movement?.status).toBe('outbound');
      expect(await reportModel.countDocuments({ accountId: attacker.accountId })).toBe(0);

      const arriveEvent = await eventModel.findOne({
        type: 'movementArrive',
        'payload.movementId': movementId,
      });
      // Retried, not dead-lettered yet: `recordFailure` returns a failed attempt to `due`
      // with a backoff `dueAt`, only marking `failed` once `maxAttempts` is exhausted.
      expect(arriveEvent?.status).toBe('due');
      expect(arriveEvent?.attempts).toBe(1);
    });
  });

  // M3c.4: the per-type arrival-resolver registry's `raid`/`assault` resolver
  // (`BattleArrivalResolver`) — `docs/M3_DESIGN_DECISIONS.md` §5/§6/§9/§15/§18. Every
  // numeric expectation below is derived from `resolveBattle`/`battleRoll` (the real
  // `game-core` formulas) at assertion time, using the movement's own actual
  // `(world.seed, movementId)` roll — never a hardcoded balance constant, per this repo's
  // "derive, don't hardcode" convention (see `resolveScoutCombat`'s use above for the same
  // discipline applied to scouting).
  describe('M3c.4: raid/assault battle arrival', () => {
    it('a hand-computed raid: persisted documents and both reports match resolveBattle exactly', async () => {
      const attacker = await createGuestSession();
      const defender = await createGuestSession();
      const attackerTroops = [{ unitType: 'brute', count: 10 }];
      const defenderTroops = [{ unitType: 'torcher', count: 4 }];
      const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
        troops: attackerTroops,
      });
      const defenderSettlement = await seedSettlementAt(defender.accountId, 5, 0, {
        troops: defenderTroops,
      });

      const sendResponse = await postSend(attacker.cookie, {
        type: 'raid',
        fromSettlementId: String(attackerSettlement._id),
        target: { x: 5, y: 0 },
        units: attackerTroops,
      });
      expect(sendResponse.status).toBe(201);
      const movementId = sendResponse.body.id as string;

      await forceArrive(movementId);

      const world = await worldService.getWorld();
      const roll = battleRoll(world.seed, movementId);
      const expected = resolveBattle(config, {
        attacker: attackerTroops as TroopCounts,
        defenders: [{ key: 'home', troops: defenderTroops as TroopCounts }],
        wallLevel: 0,
        kind: 'raid',
        roll,
      });
      const homeOutcome = expected.defenders.find((d) => d.key === 'home');
      if (!homeOutcome) throw new Error('unreachable');

      const movement = await movementModel.findById(movementId);
      expect(movement?.status).toBe('returning');
      expect(plainUnitEntries(movement?.survivors)).toEqual(expected.attacker.survivors);
      // M3c.5a: against an ABUNDANT_RESOURCES, no-Hidden-Cache target, a prevailing attacker
      // always has something to carry off — the exact numbers (capacity-bound proportionality,
      // Hidden Cache protection, the unsuccessful-attacker-loots-nothing case) are this file's
      // own "M3c.5a: loot" suite's job, not this pre-existing battle-persistence test's.
      if (expected.attackerPrevailed) {
        expect(movement?.loot).toBeDefined();
      } else {
        expect(movement?.loot).toBeUndefined();
      }

      const returnEvent = await eventModel.findOne({
        type: 'movementReturn',
        'payload.movementId': movementId,
      });
      expect(returnEvent).not.toBeNull();

      const defenderAfter = await settlementModel.findById(defenderSettlement._id);
      expect(plainUnitEntries(defenderAfter?.troops)).toEqual(
        homeOutcome.survivors.filter((t) => t.count > 0),
      );
      expect(defenderAfter?.stationedTroops).toEqual([]);

      const { result: expectedAwayTroops } = subtractUnitCounts(
        attackerTroops,
        expected.attacker.losses.filter((l) => l.count > 0),
      );
      const originAfter = await settlementModel.findById(attackerSettlement._id);
      expect(plainUnitEntries(originAfter?.awayTroops)).toEqual(expectedAwayTroops);

      expect(await reportModel.countDocuments({})).toBe(2);

      const attackerReport = await reportModel.findOne({ accountId: attacker.accountId });
      expect(attackerReport?.type).toBe('raid');
      const attackerPayload = attackerReport?.payload as Record<string, unknown>;
      expect(attackerPayload['movementId']).toBe(movementId);
      expect(attackerPayload['fromSettlementId']).toBe(String(attackerSettlement._id));
      expect(attackerPayload['toSettlementId']).toBe(String(defenderSettlement._id));
      expect(attackerPayload['kind']).toBe('raid');
      expect(attackerPayload['attacker']).toEqual({
        sent: attackerTroops,
        losses: expected.attacker.losses,
        survivors: expected.attacker.survivors,
      });
      expect(attackerPayload['defenderLosses']).toEqual(mergeUnitCounts(homeOutcome.losses));
      expect(attackerPayload['atkPts']).toBe(expected.atkPts);
      expect(attackerPayload['defPts']).toBe(expected.defPts);
      expect(attackerPayload['x']).toBe(expected.x);
      expect(attackerPayload['attackerLossFraction']).toBe(expected.attackerLossFraction);
      expect(attackerPayload['defenderLossFraction']).toBe(expected.defenderLossFraction);
      expect(attackerPayload['wallFactor']).toBe(expected.wallFactor);
      expect(attackerPayload['defenderWallLevel']).toBe(0);
      expect(attackerPayload['lootCapacity']).toBe(expected.lootCapacity);
      expect(attackerPayload['attackerPrevailed']).toBe(expected.attackerPrevailed);
      // M3c.5a: the attacker's own report always carries `resolveLoot`'s numbers, zero-valued
      // on an unsuccessful attack rather than omitted — unlike `movement.loot` (whose "absent
      // means never-set" convention the return leg keys off), a report is a one-time snapshot,
      // so "you got 0 loot because you were repelled" is exactly what the field means here. The
      // exact numbers (capacity-bound proportionality, Hidden Cache protection) are this file's
      // own "M3c.5a: loot" suite's job, not this pre-existing battle-persistence test's. The
      // siege step is still next, not this one.
      expect(attackerPayload['loot']).toBeDefined();
      expect(attackerPayload['lootCapacityBound']).toBeDefined();
      expect(attackerPayload['hiddenCacheProtection']).toBeDefined();
      expect(attackerPayload['buildingsDestroyed']).toBeUndefined();

      const defenseReport = await reportModel.findOne({ accountId: defender.accountId });
      expect(defenseReport?.type).toBe('defense');
      const defensePayload = defenseReport?.payload as Record<string, unknown>;
      expect(defensePayload['attackerAccountId']).toBe(String(attacker.accountId));
      expect(defensePayload['attacker']).toEqual({
        sent: attackerTroops,
        losses: expected.attacker.losses,
        survivors: expected.attacker.survivors,
      });
      expect(defensePayload['home']).toEqual({
        losses: homeOutcome.losses,
        survivors: homeOutcome.survivors,
      });
      expect(defensePayload['stationedLosses']).toEqual([]);
      expect(defensePayload['x']).toBe(expected.x);

      expect(await reportModel.countDocuments({ type: 'supportLoss' })).toBe(0);
    });

    it('a stationed contingent defends, takes its own losses, and the defender’s awayTroops never defends', async () => {
      const attacker = await createGuestSession();
      const defender = await createGuestSession();
      const supporter = await createGuestSession();

      const attackerTroops = [{ unitType: 'brute', count: 30 }];
      const homeTroops = [{ unitType: 'torcher', count: 2 }];
      const stationedTroops = [{ unitType: 'torcher', count: 10 }];
      // A large in-transit stack that must NOT defend (§5: "troops of the defender that are
      // away do not defend") — if it were counted, `defPts` would swing wildly and the
      // hand-computed `expected` below (which deliberately excludes it) would no longer match
      // the persisted report, catching a regression that accidentally unions `awayTroops` in.
      const awayTroops = [{ unitType: 'torcher', count: 500 }];

      const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
        troops: attackerTroops,
      });
      const supporterSettlement = await seedSettlementAt(supporter.accountId, -5, 0, {
        troops: [],
      });
      const defenderSettlement = await seedSettlementAt(defender.accountId, 5, 0, {
        troops: homeTroops,
      });
      await settlementModel.updateOne(
        { _id: defenderSettlement._id },
        {
          $set: {
            awayTroops,
            stationedTroops: [
              {
                ownerAccountId: supporter.accountId,
                fromSettlementId: supporterSettlement._id,
                troops: stationedTroops,
              },
            ],
          },
        },
      );

      const sendResponse = await postSend(attacker.cookie, {
        type: 'raid',
        fromSettlementId: String(attackerSettlement._id),
        target: { x: 5, y: 0 },
        units: attackerTroops,
      });
      expect(sendResponse.status).toBe(201);
      const movementId = sendResponse.body.id as string;

      await forceArrive(movementId);

      const world = await worldService.getWorld();
      const roll = battleRoll(world.seed, movementId);
      const stationedKey = stationedContingentKey(supporter.accountId, supporterSettlement._id);
      // Deliberately excludes `awayTroops` — proving (d) that the defender's own away stack
      // never defends means this hand computation must NOT include it either.
      const expectedWithStationed = resolveBattle(config, {
        attacker: attackerTroops as TroopCounts,
        defenders: [
          { key: 'home', troops: homeTroops as TroopCounts },
          { key: stationedKey, troops: stationedTroops as TroopCounts },
        ],
        wallLevel: 0,
        kind: 'raid',
        roll,
      });
      // (a) the contingent's units contributed to the defence: the same battle resolved
      // without it is measurably easier for the attacker (lower defPts).
      const expectedHomeOnly = resolveBattle(config, {
        attacker: attackerTroops as TroopCounts,
        defenders: [{ key: 'home', troops: homeTroops as TroopCounts }],
        wallLevel: 0,
        kind: 'raid',
        roll,
      });
      expect(expectedWithStationed.defPts).toBeGreaterThan(expectedHomeOnly.defPts);

      const stationedOutcome = expectedWithStationed.defenders.find((d) => d.key === stationedKey);
      if (!stationedOutcome) throw new Error('unreachable');

      // (d) proves itself against the persisted report numbers below: if `awayTroops` had
      // defended, `defPts`/`x` on the real defense report would not match
      // `expectedWithStationed` (computed excluding it).
      const defenseReport = await reportModel.findOne({ accountId: defender.accountId });
      const defensePayload = defenseReport?.payload as Record<string, unknown>;
      expect(defensePayload['defPts']).toBe(expectedWithStationed.defPts);
      expect(defensePayload['x']).toBe(expectedWithStationed.x);

      // (b) the contingent's survivors are written back on the host document.
      const defenderAfter = await settlementModel.findById(defenderSettlement._id);
      expect(defenderAfter?.stationedTroops).toHaveLength(1);
      const stationedAfter = defenderAfter?.stationedTroops?.[0];
      expect(String(stationedAfter?.ownerAccountId)).toBe(String(supporter.accountId));
      expect(String(stationedAfter?.fromSettlementId)).toBe(String(supporterSettlement._id));
      expect(plainUnitEntries(stationedAfter?.troops)).toEqual(
        stationedOutcome.survivors.filter((t) => t.count > 0),
      );
      // (d) the defender's own `awayTroops` is untouched — this resolver never writes it.
      expect(plainUnitEntries(defenderAfter?.awayTroops)).toEqual(awayTroops);

      // (c) the supporter got exactly one `supportLoss` report, and it does not carry the
      // host's own losses or the full battle internals.
      const supporterReports = await reportModel.find({
        accountId: supporter.accountId,
        type: 'supportLoss',
      });
      expect(supporterReports).toHaveLength(1);
      const supporterPayload = supporterReports[0]?.payload as Record<string, unknown>;
      expect(supporterPayload['losses']).toEqual(
        stationedOutcome.losses.filter((l) => l.count > 0),
      );
      expect(supporterPayload['home']).toBeUndefined();
      expect(supporterPayload['attacker']).toBeUndefined();
      expect(supporterPayload['x']).toBeUndefined();
      expect(supporterPayload['defPts']).toBeUndefined();
    });

    it('assault vs raid differ as §6 says: same armies and wall, assault wipes the defender, raid does not', async () => {
      const attackerTroops = [{ unitType: 'brute', count: 15 }];
      const defenderTroops = [{ unitType: 'torcher', count: 10 }];

      async function sendAndArrive(
        type: 'raid' | 'assault',
        targetX: number,
      ): Promise<{ payload: Record<string, unknown>; defenderTroopsAfter: unknown }> {
        const attacker = await createGuestSession();
        const defender = await createGuestSession();
        const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, targetX, {
          troops: attackerTroops,
        });
        const defenderSettlement = await seedSettlementAt(defender.accountId, 5, targetX, {
          troops: defenderTroops,
        });

        const sendResponse = await postSend(attacker.cookie, {
          type,
          fromSettlementId: String(attackerSettlement._id),
          target: { x: 5, y: targetX },
          units: attackerTroops,
        });
        expect(sendResponse.status).toBe(201);
        const movementId = sendResponse.body.id as string;
        await forceArrive(movementId);

        const defenseReport = await reportModel.findOne({ accountId: defender.accountId });
        const defenderAfter = await settlementModel.findById(defenderSettlement._id);
        return {
          payload: defenseReport?.payload as Record<string, unknown>,
          defenderTroopsAfter: plainUnitEntries(defenderAfter?.troops),
        };
      }

      const raidResult = await sendAndArrive('raid', 0);
      const assaultResult = await sendAndArrive('assault', 1);

      // Assault: defender loses 100 % always (§6) — home troops wiped.
      expect(assaultResult.defenderTroopsAfter).toEqual([]);
      expect(
        (assaultResult.payload['home'] as { survivors: Array<{ count: number }> }).survivors.every(
          (s) => s.count === 0,
        ),
      ).toBe(true);
      // Raid: partial — with a 10-strong home garrison and a moderately favourable fight for
      // the attacker, some defenders survive.
      expect(raidResult.defenderTroopsAfter).not.toEqual([]);
      expect(
        (raidResult.payload['home'] as { survivors: Array<{ count: number }> }).survivors.some(
          (s) => s.count > 0,
        ),
      ).toBe(true);
    });

    it('total wipe: an overwhelmed assault attacker ends done, no movementReturn, awayTroops drops the whole army', async () => {
      const attacker = await createGuestSession();
      const defender = await createGuestSession();
      const attackerTroops = [{ unitType: 'brute', count: 1 }];
      const defenderTroops = [{ unitType: 'torcher', count: 50 }];
      const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
        troops: attackerTroops,
      });
      await seedSettlementAt(defender.accountId, 5, 0, { troops: defenderTroops });

      const sendResponse = await postSend(attacker.cookie, {
        type: 'assault',
        fromSettlementId: String(attackerSettlement._id),
        target: { x: 5, y: 0 },
        units: attackerTroops,
      });
      expect(sendResponse.status).toBe(201);
      const movementId = sendResponse.body.id as string;

      await forceArrive(movementId);

      const world = await worldService.getWorld();
      const roll = battleRoll(world.seed, movementId);
      const expected = resolveBattle(config, {
        attacker: attackerTroops as TroopCounts,
        defenders: [{ key: 'home', troops: defenderTroops as TroopCounts }],
        wallLevel: 0,
        kind: 'assault',
        roll,
      });
      expect(expected.attacker.survivors.every((s) => s.count === 0)).toBe(true);

      const movement = await movementModel.findById(movementId);
      expect(movement?.status).toBe('done');
      expect(plainUnitEntries(movement?.survivors)).toEqual([]);

      const returnEvent = await eventModel.findOne({
        type: 'movementReturn',
        'payload.movementId': movementId,
      });
      expect(returnEvent).toBeNull();

      const originAfter = await settlementModel.findById(attackerSettlement._id);
      expect(plainUnitEntries(originAfter?.awayTroops)).toEqual([]);
    });

    it('idempotency: replaying movementArrive for a raid is a no-op (no second report, no double loot/loss)', async () => {
      const attacker = await createGuestSession();
      const defender = await createGuestSession();
      const attackerTroops = [{ unitType: 'brute', count: 10 }];
      const defenderTroops = [{ unitType: 'torcher', count: 4 }];
      const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
        troops: attackerTroops,
      });
      const defenderSettlement = await seedSettlementAt(defender.accountId, 5, 0, {
        troops: defenderTroops,
      });

      const sendResponse = await postSend(attacker.cookie, {
        type: 'raid',
        fromSettlementId: String(attackerSettlement._id),
        target: { x: 5, y: 0 },
        units: attackerTroops,
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
      const defenderAfterFirst = await settlementModel.findById(defenderSettlement._id);
      const originAfterFirst = await settlementModel.findById(attackerSettlement._id);
      expect(await reportModel.countDocuments({})).toBe(2);

      await replayArrive();
      const afterSecond = await movementModel.findById(movementId);
      const defenderAfterSecond = await settlementModel.findById(defenderSettlement._id);
      const originAfterSecond = await settlementModel.findById(attackerSettlement._id);

      expect(afterSecond?.status).toBe(afterFirst?.status);
      expect(plainUnitEntries(afterSecond?.survivors)).toEqual(
        plainUnitEntries(afterFirst?.survivors),
      );
      expect(plainUnitEntries(defenderAfterSecond?.troops)).toEqual(
        plainUnitEntries(defenderAfterFirst?.troops),
      );
      expect(plainUnitEntries(originAfterSecond?.awayTroops)).toEqual(
        plainUnitEntries(originAfterFirst?.awayTroops),
      );
      expect(await reportModel.countDocuments({})).toBe(2);
    });

    it('determinism: the same (world.seed, movementId) always produces the same roll and the same resolveBattle result', async () => {
      const world = await worldService.getWorld();
      const movementId = new Types.ObjectId().toString();
      const rollA = battleRoll(world.seed, movementId);
      const rollB = battleRoll(world.seed, movementId);
      expect(rollA).toBe(rollB);

      const input = {
        attacker: [{ unitType: 'brute', count: 12 }] as TroopCounts,
        defenders: [{ key: 'home', troops: [{ unitType: 'torcher', count: 6 }] as TroopCounts }],
        wallLevel: 2,
        kind: 'raid' as const,
        roll: rollA,
      };
      const resultA = resolveBattle(config, input);
      const resultB = resolveBattle(config, input);
      expect(resultA).toEqual(resultB);
    });

    it('missing target: a raid whose target was deleted mid-flight turns around unharmed with a raid report, no battle fields', async () => {
      const attacker = await createGuestSession();
      const defender = await createGuestSession();
      const attackerTroops = [{ unitType: 'brute', count: 5 }];
      const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
        troops: attackerTroops,
      });
      const defenderSettlement = await seedSettlementAt(defender.accountId, 5, 0);

      const sendResponse = await postSend(attacker.cookie, {
        type: 'raid',
        fromSettlementId: String(attackerSettlement._id),
        target: { x: 5, y: 0 },
        units: attackerTroops,
      });
      expect(sendResponse.status).toBe(201);
      const movementId = sendResponse.body.id as string;

      await settlementModel.deleteOne({ _id: defenderSettlement._id });
      await forceArrive(movementId);

      const movement = await movementModel.findById(movementId);
      expect(movement?.status).toBe('returning');
      expect(plainUnitEntries(movement?.survivors)).toEqual(attackerTroops);

      const returnEvent = await eventModel.findOne({
        type: 'movementReturn',
        'payload.movementId': movementId,
      });
      expect(returnEvent).not.toBeNull();

      const report = await reportModel.findOne({ accountId: attacker.accountId });
      expect(report?.type).toBe('raid');
      const payload = report?.payload as Record<string, unknown>;
      expect(payload['reason']).toBe('targetNotFound');
      expect(payload['fromSettlementId']).toBe(String(attackerSettlement._id));
      expect(payload['target']).toEqual({ x: 5, y: 0 });
      expect(payload['x']).toBeUndefined();
      expect(payload['atkPts']).toBeUndefined();
      expect(payload['attacker']).toBeUndefined();

      // Nothing died — every unit is still genuinely in transit (M3a.4, §3).
      const originAfter = await settlementModel.findById(attackerSettlement._id);
      expect(plainUnitEntries(originAfter?.awayTroops)).toEqual(attackerTroops);
    });
  });

  // M3c.5a: the loot pass end to end (`docs/M3_DESIGN_DECISIONS.md` §6) — what
  // `BattleArrivalResolver` (arrival: take + report the loot) and `MovementReturnHandler`
  // (return: credit, clamp, report the overflow) add on top of the M3c.4 battle step above.
  // Every numeric expectation is derived from `resolveLoot`/`calcStorageCaps`/
  // `hiddenCacheProtection`/`settleResources` (the real `game-core` formulas) at assertion
  // time, the same "derive, don't hardcode" discipline the M3c.4 suite above already follows
  // for `resolveBattle`.
  describe('M3c.5a: loot', () => {
    // Same Mongoose-subdocument hazard `plainUnitEntries` guards against (see its own
    // comment), applied to a settlement's stored resources.
    function plainStoredResources(doc: SettlementDocument): Resources {
      return {
        scrap: doc.resources.values.scrap,
        fuel: doc.resources.values.fuel,
        electronics: doc.resources.values.electronics,
        food: doc.resources.values.food,
      };
    }

    // Reconstructs a defender's *exact* settled-at-arrival resources. `BattleArrivalResolver`
    // stamps `resources.lastCalcAt` to `event.dueAt` via the arrival preamble's settle before
    // it ever touches loot (§6: "the defender's resources are settled inside the arrival
    // transaction before looting"), so re-running the same `settleResources` formula from the
    // seed snapshot up to that exact, now-persisted instant reproduces the pre-loot figure
    // bit-for-bit — no drift-tolerance window needed, unlike a still-live resource read.
    // `plainStoredResources` first — `settleResources`'s `elapsedMs <= 0` branch spreads
    // `state.values`, and spreading a raw Mongoose subdocument (rather than a plain object)
    // silently pulls in its internal bookkeeping fields instead of just `scrap`/`fuel`/etc.
    function reconstructSettledDefenderResources(
      defenderPre: SettlementDocument,
      defenderBuildings: Array<{ type: string; level: number }>,
      defenderTroops: Array<{ unitType: string; count: number }>,
      defenderPost: SettlementDocument,
    ): Resources {
      return settleResources(
        config,
        defenderBuildings as BuildingLevels,
        { values: plainStoredResources(defenderPre), lastCalcAt: defenderPre.resources.lastCalcAt },
        defenderPost.resources.lastCalcAt,
        defenderTroops as TroopCounts,
      ).values;
    }

    // Same, for a `Movement.loot` subdocument — `undefined` reads back as the zero bundle,
    // matching "absent means never-set" for every field this schema treats that way.
    function plainLoot(loot: Resources | undefined): Resources {
      return {
        scrap: loot?.scrap ?? 0,
        fuel: loot?.fuel ?? 0,
        electronics: loot?.electronics ?? 0,
        food: loot?.food ?? 0,
      };
    }

    const DEFAULT_DEFENDER_BUILDINGS = [{ type: 'commandCenter', level: 1 }];

    // Seeds an attacker/defender pair, sends `type` (`raid` by default), force-arrives it, and
    // returns the pre-arrival defender snapshot (fed to `reconstructSettledDefenderResources`
    // above) plus the hand-computed `resolveBattle` result every test below derives its own
    // loot expectation from — the exact same roll-derivation convention the M3c.4 suite uses.
    async function sendAndArriveBattle(options: {
      type?: 'raid' | 'assault';
      attackerTroops: Array<{ unitType: string; count: number }>;
      attackerResources?: Resources;
      attackerBuildings?: Array<{ type: string; level: number }>;
      defenderTroops: Array<{ unitType: string; count: number }>;
      defenderResources: Resources;
      defenderBuildings?: Array<{ type: string; level: number }>;
    }): Promise<{
      attacker: GuestSession;
      defender: GuestSession;
      attackerSettlement: SettlementDocument;
      defenderSettlementPre: SettlementDocument;
      defenderBuildings: Array<{ type: string; level: number }>;
      movementId: string;
      expected: ReturnType<typeof resolveBattle>;
    }> {
      const type = options.type ?? 'raid';
      const attacker = await createGuestSession();
      const defender = await createGuestSession();
      const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
        troops: options.attackerTroops,
        buildings: options.attackerBuildings,
        resources: options.attackerResources,
      });
      const defenderBuildings = options.defenderBuildings ?? DEFAULT_DEFENDER_BUILDINGS;
      const defenderSettlementPre = await seedSettlementAt(defender.accountId, 5, 0, {
        troops: options.defenderTroops,
        buildings: defenderBuildings,
        resources: options.defenderResources,
      });

      const sendResponse = await postSend(attacker.cookie, {
        type,
        fromSettlementId: String(attackerSettlement._id),
        target: { x: 5, y: 0 },
        units: options.attackerTroops,
      });
      expect(sendResponse.status).toBe(201);
      const movementId = sendResponse.body.id as string;

      await forceArrive(movementId);

      const world = await worldService.getWorld();
      const roll = battleRoll(world.seed, movementId);
      const expected = resolveBattle(config, {
        attacker: options.attackerTroops as TroopCounts,
        defenders: [{ key: 'home', troops: options.defenderTroops as TroopCounts }],
        wallLevel: 0,
        kind: type,
        roll,
      });

      return {
        attacker,
        defender,
        attackerSettlement,
        defenderSettlementPre,
        defenderBuildings,
        movementId,
        expected,
      };
    }

    it('a raid on a resource-rich, lightly defended target: the defender loses exactly resolveLoot(...).taken, movement.loot matches, the attacker report carries it', async () => {
      const attackerTroops = [{ unitType: 'brute', count: 100 }];
      const defenderTroops = [{ unitType: 'torcher', count: 2 }];
      const defenderResources: Resources = { scrap: 800, fuel: 500, electronics: 300, food: 600 };

      const { attacker, defenderSettlementPre, defenderBuildings, movementId, expected } =
        await sendAndArriveBattle({ attackerTroops, defenderTroops, defenderResources });
      // 100 brutes vs 2 torchers: overwhelming — asserted rather than assumed, since every
      // loot expectation below only holds when the attacker actually prevailed.
      expect(expected.attackerPrevailed).toBe(true);

      const defenderAfter = await settlementModel.findById(defenderSettlementPre._id);
      if (!defenderAfter) throw new Error('unreachable');
      const settledStored = reconstructSettledDefenderResources(
        defenderSettlementPre,
        defenderBuildings,
        defenderTroops,
        defenderAfter,
      );
      const expectedLoot = resolveLoot(config, expected, {
        stored: settledStored,
        hiddenCacheLevel: 0,
      });
      // 100 brutes' surviving carry capacity comfortably exceeds this haul — a clean "took
      // everything available" case, not the capacity-bound proportional split (its own test).
      expect(expectedLoot.capacityBound).toBe(false);
      expect(expectedLoot.totalTaken).toBeGreaterThan(0);

      expect(plainStoredResources(defenderAfter)).toEqual(
        subtractResources(settledStored, expectedLoot.taken),
      );

      const movement = await movementModel.findById(movementId);
      expect(plainLoot(movement?.loot)).toEqual(expectedLoot.taken);

      const attackerReport = await reportModel.findOne({ accountId: attacker.accountId });
      const attackerPayload = attackerReport?.payload as {
        loot: Resources;
        lootCapacityBound: boolean;
        hiddenCacheProtection: number;
      };
      expect(attackerPayload.loot).toEqual(expectedLoot.taken);
      expect(attackerPayload.lootCapacityBound).toBe(false);
      expect(attackerPayload.hiddenCacheProtection).toBe(0);

      const defenseReport = await reportModel.findOne({
        accountId: defenderSettlementPre.accountId,
      });
      const defensePayload = defenseReport?.payload as { lootTaken: Resources };
      expect(defensePayload.lootTaken).toEqual(expectedLoot.taken);
    });

    it('the Hidden Cache actually protects: a Hidden Cache leaves hiddenCacheProtection(config, level) per resource behind', async () => {
      const attackerTroops = [{ unitType: 'brute', count: 100 }];
      const defenderTroops = [{ unitType: 'torcher', count: 2 }];
      const defenderBuildings = [
        { type: 'commandCenter', level: 1 },
        { type: 'hiddenCache', level: 5 },
      ];
      // Every resource comfortably above the L5 protection line (664.30125), so the cache
      // protects part of each resource without hiding all of it — the interesting case.
      const defenderResources: Resources = {
        scrap: 2000,
        fuel: 1500,
        electronics: 1000,
        food: 1200,
      };

      const { attacker, defenderSettlementPre, movementId, expected } = await sendAndArriveBattle({
        attackerTroops,
        defenderTroops,
        defenderResources,
        defenderBuildings,
      });
      expect(expected.attackerPrevailed).toBe(true);

      const defenderAfter = await settlementModel.findById(defenderSettlementPre._id);
      if (!defenderAfter) throw new Error('unreachable');
      const settledStored = reconstructSettledDefenderResources(
        defenderSettlementPre,
        defenderBuildings,
        defenderTroops,
        defenderAfter,
      );
      const expectedLoot = resolveLoot(config, expected, {
        stored: settledStored,
        hiddenCacheLevel: 5,
      });
      // Not capacity-bound (100 brutes' carry vastly exceeds what's exposed past the cache) —
      // so what's left behind is *exactly* the protected amount, not a capacity-skewed mix.
      expect(expectedLoot.capacityBound).toBe(false);
      expect(expectedLoot.protectedPerResource).toBeCloseTo(hiddenCacheProtection(config, 5), 9);

      for (const kind of RESOURCE_KINDS) {
        expect(defenderAfter.resources.values[kind]).toBeCloseTo(
          hiddenCacheProtection(config, 5),
          6,
        );
      }
      expect(plainStoredResources(defenderAfter)).toEqual(
        subtractResources(settledStored, expectedLoot.taken),
      );

      const movement = await movementModel.findById(movementId);
      expect(plainLoot(movement?.loot)).toEqual(expectedLoot.taken);

      const attackerReport = await reportModel.findOne({ accountId: attacker.accountId });
      const attackerPayload = attackerReport?.payload as { hiddenCacheProtection: number };
      expect(attackerPayload.hiddenCacheProtection).toBeCloseTo(
        hiddenCacheProtection(config, 5),
        9,
      );
    });

    it('the Hidden Cache actually protects: a target whose every resource sits below the protection line loses nothing', async () => {
      const attackerTroops = [{ unitType: 'brute', count: 100 }];
      const defenderTroops = [{ unitType: 'torcher', count: 2 }];
      const defenderBuildings = [
        { type: 'commandCenter', level: 1 },
        { type: 'hiddenCache', level: 5 },
      ];
      // Every resource below the L5 protection line (664.30125) — the cache hides all of it.
      const defenderResources: Resources = { scrap: 100, fuel: 200, electronics: 50, food: 300 };

      const { attacker, defenderSettlementPre, movementId, expected } = await sendAndArriveBattle({
        attackerTroops,
        defenderTroops,
        defenderResources,
        defenderBuildings,
      });
      expect(expected.attackerPrevailed).toBe(true);

      const defenderAfter = await settlementModel.findById(defenderSettlementPre._id);
      if (!defenderAfter) throw new Error('unreachable');
      const settledStored = reconstructSettledDefenderResources(
        defenderSettlementPre,
        defenderBuildings,
        defenderTroops,
        defenderAfter,
      );
      const expectedLoot = resolveLoot(config, expected, {
        stored: settledStored,
        hiddenCacheLevel: 5,
      });
      expect(expectedLoot.totalTaken).toBe(0);
      expect(plainStoredResources(defenderAfter)).toEqual(settledStored);

      const movement = await movementModel.findById(movementId);
      expect(movement?.loot).toBeUndefined();

      const attackerReport = await reportModel.findOne({ accountId: attacker.accountId });
      const attackerPayload = attackerReport?.payload as {
        loot: Resources;
        lootCapacityBound: boolean;
        hiddenCacheProtection: number;
      };
      expect(attackerPayload.loot).toEqual({ scrap: 0, fuel: 0, electronics: 0, food: 0 });
      expect(attackerPayload.lootCapacityBound).toBe(false);
      expect(attackerPayload.hiddenCacheProtection).toBeCloseTo(
        hiddenCacheProtection(config, 5),
        9,
      );
    });

    it('capacity-bound proportionality: each resource’s share of taken equals its share of available', async () => {
      const attackerTroops = [{ unitType: 'brute', count: 5 }];
      const defenderTroops = [{ unitType: 'torcher', count: 1 }];
      // Abundant and equal across all four kinds, with no Hidden Cache — a tiny army's carry
      // capacity is the binding constraint here, not availability.
      const defenderResources: Resources = ABUNDANT_RESOURCES;

      const { attacker, defenderSettlementPre, defenderBuildings, movementId, expected } =
        await sendAndArriveBattle({ attackerTroops, defenderTroops, defenderResources });
      expect(expected.attackerPrevailed).toBe(true);

      const defenderAfter = await settlementModel.findById(defenderSettlementPre._id);
      if (!defenderAfter) throw new Error('unreachable');
      const settledStored = reconstructSettledDefenderResources(
        defenderSettlementPre,
        defenderBuildings,
        defenderTroops,
        defenderAfter,
      );
      const expectedLoot = resolveLoot(config, expected, {
        stored: settledStored,
        hiddenCacheLevel: 0,
      });
      expect(expectedLoot.capacityBound).toBe(true);
      expect(expectedLoot.totalTaken).toBeGreaterThan(0);

      const totalAvailable = RESOURCE_KINDS.reduce((sum, kind) => sum + settledStored[kind], 0);
      for (const kind of RESOURCE_KINDS) {
        const availabilityShare = settledStored[kind] / totalAvailable;
        const takeShare = expectedLoot.taken[kind] / expectedLoot.totalTaken;
        expect(takeShare).toBeCloseTo(availabilityShare, 6);
      }

      expect(plainStoredResources(defenderAfter)).toEqual(
        subtractResources(settledStored, expectedLoot.taken),
      );
      const movement = await movementModel.findById(movementId);
      expect(plainLoot(movement?.loot)).toEqual(expectedLoot.taken);

      const attackerReport = await reportModel.findOne({ accountId: attacker.accountId });
      const attackerPayload = attackerReport?.payload as { lootCapacityBound: boolean };
      expect(attackerPayload.lootCapacityBound).toBe(true);
    });

    it('an unsuccessful attacker loots nothing, even though it is not wiped outright', async () => {
      const attackerTroops = [{ unitType: 'brute', count: 50 }];
      const defenderTroops = [{ unitType: 'torcher', count: 5000 }];
      const defenderResources: Resources = ABUNDANT_RESOURCES;

      const { attacker, defenderSettlementPre, defenderBuildings, movementId, expected } =
        await sendAndArriveBattle({ attackerTroops, defenderTroops, defenderResources });
      // defPts vastly exceeds atkPts regardless of the ±5% roll, so x clamps to exactly 1 —
      // §6's "an unsuccessful attacker loots nothing", the `x === 1` half of that rule (not
      // the wipe half — a raid's attacker loss fraction at x=1 is 1/(1+1) = 50%, not a wipe;
      // the M3c.4 suite's own "total wipe" test already covers the wipe half with `assault`).
      expect(expected.x).toBe(1);
      expect(expected.attackerPrevailed).toBe(false);
      expect(expected.attacker.survivors.some((s) => s.count > 0)).toBe(true);

      const movement = await movementModel.findById(movementId);
      expect(movement?.status).toBe('returning');
      expect(movement?.loot).toBeUndefined();

      const defenderAfter = await settlementModel.findById(defenderSettlementPre._id);
      if (!defenderAfter) throw new Error('unreachable');
      const settledStored = reconstructSettledDefenderResources(
        defenderSettlementPre,
        defenderBuildings,
        defenderTroops,
        defenderAfter,
      );
      expect(plainStoredResources(defenderAfter)).toEqual(settledStored);

      const attackerReport = await reportModel.findOne({ accountId: attacker.accountId });
      const attackerPayload = attackerReport?.payload as {
        loot: Resources;
        lootCapacityBound: boolean;
        hiddenCacheProtection: number;
      };
      expect(attackerPayload.loot).toEqual({ scrap: 0, fuel: 0, electronics: 0, food: 0 });
      expect(attackerPayload.lootCapacityBound).toBe(false);
      expect(attackerPayload.hiddenCacheProtection).toBe(0);
    });

    it('the return leg credits it: the attacker’s stored resources rise by the loot and the report carries lootDelivered with no loss', async () => {
      const attackerTroops = [{ unitType: 'brute', count: 100 }];
      const attackerResources: Resources = { scrap: 50, fuel: 50, electronics: 50, food: 500 };
      const attackerBuildings = [{ type: 'commandCenter', level: 1 }];
      const defenderTroops = [{ unitType: 'torcher', count: 2 }];
      const defenderResources: Resources = { scrap: 800, fuel: 500, electronics: 300, food: 600 };

      const { attackerSettlement, movementId, expected } = await sendAndArriveBattle({
        attackerTroops,
        attackerResources,
        attackerBuildings,
        defenderTroops,
        defenderResources,
      });
      expect(expected.attackerPrevailed).toBe(true);

      const movementAfterArrive = await movementModel.findById(movementId);
      const movementLoot = plainLoot(movementAfterArrive?.loot);
      expect(Object.values(movementLoot).some((v) => v > 0)).toBe(true);

      await forceReturn(movementId);

      const movementAfterReturn = await movementModel.findById(movementId);
      expect(movementAfterReturn?.status).toBe('done');

      const attackerAfterReturn = await settlementModel.findById(attackerSettlement._id);
      if (!attackerAfterReturn) throw new Error('unreachable');
      expectResourcesCloseTo(
        plainStoredResources(attackerAfterReturn),
        addResources(attackerResources, movementLoot),
        attackerBuildings as BuildingLevels,
        expected.attacker.survivors,
      );

      const report = await reportModel.findOne({
        accountId: attackerSettlement.accountId,
        type: { $in: ['raid', 'assault'] },
      });
      const payload = report?.payload as { lootDelivered: Resources; lootLost: Resources };
      for (const kind of RESOURCE_KINDS) {
        expect(payload.lootDelivered[kind]).toBeCloseTo(movementLoot[kind], 6);
        expect(payload.lootLost[kind]).toBeCloseTo(0, 6);
      }
    });

    it('the overflow is lost: a nearly-full warehouse ends at exactly its cap, and lootDelivered + lootLost equals movement.loot', async () => {
      const attackerTroops = [{ unitType: 'brute', count: 100 }];
      const attackerBuildings = [{ type: 'commandCenter', level: 1 }];
      const caps = calcStorageCaps(config, attackerBuildings as BuildingLevels);
      // 50 headroom per resource — comfortably less than the haul a raid on ABUNDANT_RESOURCES
      // with no Hidden Cache will bring home.
      const attackerResources: Resources = {
        scrap: caps.scrap - 50,
        fuel: caps.fuel - 50,
        electronics: caps.electronics - 50,
        food: caps.food - 50,
      };
      const defenderTroops = [{ unitType: 'torcher', count: 2 }];
      const defenderResources: Resources = ABUNDANT_RESOURCES;

      const { movementId, attackerSettlement, expected } = await sendAndArriveBattle({
        attackerTroops,
        attackerResources,
        attackerBuildings,
        defenderTroops,
        defenderResources,
      });
      expect(expected.attackerPrevailed).toBe(true);

      const movementAfterArrive = await movementModel.findById(movementId);
      const movementLoot = plainLoot(movementAfterArrive?.loot);
      // Comfortably overflows the 50-unit headroom on every resource.
      for (const kind of RESOURCE_KINDS) {
        expect(movementLoot[kind]).toBeGreaterThan(50);
      }

      const attackerBeforeReturn = await settlementModel.findById(attackerSettlement._id);
      if (!attackerBeforeReturn) throw new Error('unreachable');

      await forceReturn(movementId);

      const attackerAfterReturn = await settlementModel.findById(attackerSettlement._id);
      if (!attackerAfterReturn) throw new Error('unreachable');
      // Ends at exactly the cap — deterministic (`Math.min(cap, grown)`), no drift tolerance
      // needed regardless of how much real wall-clock time this test took.
      for (const kind of RESOURCE_KINDS) {
        expect(attackerAfterReturn.resources.values[kind]).toBeCloseTo(caps[kind], 6);
      }

      const report = await reportModel.findOne({
        accountId: attackerAfterReturn.accountId,
        type: { $in: ['raid', 'assault'] },
      });
      const payload = report?.payload as { lootDelivered: Resources; lootLost: Resources };
      const expectedDelivered = subtractResources(caps, plainStoredResources(attackerBeforeReturn));
      const expectedLost = subtractResources(movementLoot, expectedDelivered);
      expectResourcesCloseTo(
        payload.lootDelivered,
        expectedDelivered,
        attackerBuildings as BuildingLevels,
        expected.attacker.survivors,
      );
      expectResourcesCloseTo(
        payload.lootLost,
        expectedLost,
        attackerBuildings as BuildingLevels,
        expected.attacker.survivors,
      );
      for (const kind of RESOURCE_KINDS) {
        expect(payload.lootDelivered[kind] + payload.lootLost[kind]).toBeCloseTo(
          movementLoot[kind],
          6,
        );
      }
    });

    it('replay safety: running the return event twice credits the loot once', async () => {
      const attackerTroops = [{ unitType: 'brute', count: 100 }];
      const defenderTroops = [{ unitType: 'torcher', count: 2 }];
      const defenderResources: Resources = { scrap: 800, fuel: 500, electronics: 300, food: 600 };

      const { movementId, attackerSettlement, expected } = await sendAndArriveBattle({
        attackerTroops,
        defenderTroops,
        defenderResources,
      });
      expect(expected.attackerPrevailed).toBe(true);

      const movementAfterArrive = await movementModel.findById(movementId);
      const movementLoot = plainLoot(movementAfterArrive?.loot);
      expect(Object.values(movementLoot).some((v) => v > 0)).toBe(true);

      const returnEvent = await eventModel.findOne({
        type: 'movementReturn',
        'payload.movementId': movementId,
      });
      expect(returnEvent).not.toBeNull();
      if (!returnEvent) throw new Error('unreachable');
      const confirmedReturnEvent = returnEvent;

      async function replayReturn(): Promise<void> {
        const session = await connection.startSession();
        try {
          await session.withTransaction(async () => {
            await movementReturnHandler.handle(confirmedReturnEvent, session);
          });
        } finally {
          await session.endSession();
        }
      }

      await replayReturn();
      const afterFirst = await settlementModel.findById(attackerSettlement._id);
      const movementAfterFirst = await movementModel.findById(movementId);
      const reportAfterFirst = await reportModel.findOne({
        accountId: attackerSettlement.accountId,
        type: { $in: ['raid', 'assault'] },
      });
      expect(movementAfterFirst?.status).toBe('done');
      if (!afterFirst) throw new Error('unreachable');
      const storedAfterFirst = plainStoredResources(afterFirst);

      await replayReturn();
      const afterSecond = await settlementModel.findById(attackerSettlement._id);
      const movementAfterSecond = await movementModel.findById(movementId);
      const reportAfterSecond = await reportModel.findOne({
        accountId: attackerSettlement.accountId,
        type: { $in: ['raid', 'assault'] },
      });
      if (!afterSecond) throw new Error('unreachable');

      expect(movementAfterSecond?.status).toBe('done');
      expect(movementAfterSecond?.version).toBe(movementAfterFirst?.version);
      expect(plainStoredResources(afterSecond)).toEqual(storedAfterFirst);
      expect(afterSecond.version).toBe(afterFirst.version);
      expect(reportAfterSecond?.payload).toEqual(reportAfterFirst?.payload);
    });

    it('an assault loots too (§6 gives raid and assault the same loot row)', async () => {
      const attackerTroops = [{ unitType: 'brute', count: 100 }];
      const defenderTroops = [{ unitType: 'torcher', count: 2 }];
      const defenderResources: Resources = { scrap: 800, fuel: 500, electronics: 300, food: 600 };

      const { attacker, defenderSettlementPre, defenderBuildings, movementId, expected } =
        await sendAndArriveBattle({
          type: 'assault',
          attackerTroops,
          defenderTroops,
          defenderResources,
        });
      expect(expected.attackerPrevailed).toBe(true);

      const defenderAfter = await settlementModel.findById(defenderSettlementPre._id);
      if (!defenderAfter) throw new Error('unreachable');
      const settledStored = reconstructSettledDefenderResources(
        defenderSettlementPre,
        defenderBuildings,
        defenderTroops,
        defenderAfter,
      );
      const expectedLoot = resolveLoot(config, expected, {
        stored: settledStored,
        hiddenCacheLevel: 0,
      });
      expect(expectedLoot.totalTaken).toBeGreaterThan(0);

      expect(plainStoredResources(defenderAfter)).toEqual(
        subtractResources(settledStored, expectedLoot.taken),
      );

      const movement = await movementModel.findById(movementId);
      expect(movement?.type).toBe('assault');
      expect(plainLoot(movement?.loot)).toEqual(expectedLoot.taken);

      const attackerReport = await reportModel.findOne({ accountId: attacker.accountId });
      expect(attackerReport?.type).toBe('assault');
      const attackerPayload = attackerReport?.payload as { loot: Resources };
      expect(attackerPayload.loot).toEqual(expectedLoot.taken);
    });
  });

  describe('M3c.5b: the siege pass applied', () => {
    // Same Mongoose-subdocument hazard `plainUnitEntries` guards against, applied to a
    // settlement's `buildings` array.
    function plainBuildings(doc: SettlementDocument): Array<{ type: string; level: number }> {
      return doc.buildings.map((b) => ({ type: b.type, level: b.level }));
    }

    function levelOfPlain(buildings: Array<{ type: string; level: number }>, type: string): number {
      return buildings.find((b) => b.type === type)?.level ?? 0;
    }

    // Same Mongoose-subdocument hazard `plainUnitEntries` guards against, applied to a
    // settlement's stored resources — mirrors the M3c.5a loot suite's own helper of the same
    // name (a sibling `describe`, not in scope here).
    function plainStoredResources(doc: SettlementDocument): Resources {
      return {
        scrap: doc.resources.values.scrap,
        fuel: doc.resources.values.fuel,
        electronics: doc.resources.values.electronics,
        food: doc.resources.values.food,
      };
    }

    function postBuild(settlementId: string, cookie: string[], type: string) {
      return request(app.getHttpServer())
        .post(`/api/settlements/${settlementId}/build`)
        .set('Cookie', cookie)
        .send({ type });
    }

    const DEFAULT_DEFENDER_BUILDINGS = [{ type: 'commandCenter', level: 1 }];

    // Seeds an attacker/defender pair, sends `type` (`assault` by default, carrying
    // `siegeTarget` when given), force-arrives it, and returns the hand-computed
    // `resolveBattle` result every test below feeds into `resolveSiegePass` itself, mirroring
    // the M3c.4/M3c.5a suites' own `sendAndArriveBattle` convention exactly.
    async function sendAndArriveSiege(options: {
      type?: 'raid' | 'assault';
      attackerTroops: Array<{ unitType: string; count: number }>;
      defenderTroops?: Array<{ unitType: string; count: number }>;
      defenderBuildings?: Array<{ type: string; level: number }>;
      defenderResources?: Resources;
      siegeTarget?: string;
    }): Promise<{
      attacker: GuestSession;
      defender: GuestSession;
      attackerSettlement: SettlementDocument;
      defenderSettlementPre: SettlementDocument;
      defenderBuildings: Array<{ type: string; level: number }>;
      movementId: string;
      expectedBattle: ReturnType<typeof resolveBattle>;
    }> {
      const type = options.type ?? 'assault';
      const defenderTroops = options.defenderTroops ?? [];
      const attacker = await createGuestSession();
      const defender = await createGuestSession();
      const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
        troops: options.attackerTroops,
      });
      const defenderBuildings = options.defenderBuildings ?? DEFAULT_DEFENDER_BUILDINGS;
      const defenderSettlementPre = await seedSettlementAt(defender.accountId, 5, 0, {
        troops: defenderTroops,
        buildings: defenderBuildings,
        resources: options.defenderResources ?? ABUNDANT_RESOURCES,
      });

      const sendResponse = await postSend(attacker.cookie, {
        type,
        fromSettlementId: String(attackerSettlement._id),
        target: { x: 5, y: 0 },
        units: options.attackerTroops,
        ...(options.siegeTarget !== undefined ? { siegeTarget: options.siegeTarget } : {}),
      });
      expect(sendResponse.status).toBe(201);
      const movementId = sendResponse.body.id as string;

      await forceArrive(movementId);

      const world = await worldService.getWorld();
      const roll = battleRoll(world.seed, movementId);
      const wallLevel = levelOfPlain(defenderBuildings, 'wall');
      const expectedBattle = resolveBattle(config, {
        attacker: options.attackerTroops as TroopCounts,
        defenders: [{ key: 'home', troops: defenderTroops as TroopCounts }],
        wallLevel,
        kind: type,
        roll,
      });

      return {
        attacker,
        defender,
        attackerSettlement,
        defenderSettlementPre,
        defenderBuildings,
        movementId,
        expectedBattle,
      };
    }

    it('an assault with Ram Trucks knocks the expected number of wall levels, matching resolveSiegePass exactly, and wastes every building point (siegeTarget: wall)', async () => {
      const attackerTroops = [
        { unitType: 'brute', count: 200 },
        { unitType: 'ramTruck', count: 10 },
      ];
      const defenderTroops = [{ unitType: 'torcher', count: 5 }];
      const defenderBuildings = [
        { type: 'commandCenter', level: 1 },
        { type: 'wall', level: 10 },
        { type: 'warehouse', level: 5 },
      ];

      const { defender, defenderSettlementPre, movementId, expectedBattle } =
        await sendAndArriveSiege({
          attackerTroops,
          defenderTroops,
          defenderBuildings,
          siegeTarget: 'wall',
        });
      expect(expectedBattle.attackerPrevailed).toBe(true);
      const survivingRamTrucks =
        expectedBattle.attacker.survivors.find((s) => s.unitType === 'ramTruck')?.count ?? 0;
      expect(survivingRamTrucks).toBeGreaterThan(0);

      const expectedSiege = resolveSiegePass(config, expectedBattle, {
        wallLevel: 10,
        siegeTarget: 'wall',
        targetBuildingLevel: 0,
      });

      const defenderAfter = await settlementModel.findById(defenderSettlementPre._id);
      if (!defenderAfter) throw new Error('unreachable');
      const buildingsAfter = plainBuildings(defenderAfter);
      expect(levelOfPlain(buildingsAfter, 'wall')).toBe(expectedSiege.wallLevelAfter);
      // §7: `siegeTarget: 'wall'` wastes every building point by design — the warehouse named
      // by nobody stays exactly at its pre-battle level, and the discarded count equals the
      // full building-damage pool (never partially applied to a building nobody named).
      expect(levelOfPlain(buildingsAfter, 'warehouse')).toBe(5);
      expect(expectedSiege.buildingPointsDiscarded).toBe(expectedSiege.buildingPoints);
      expect(expectedSiege.buildingPointsSpent).toBe(0);

      const movement = await movementModel.findById(movementId);
      const raiderReport = await reportModel.findOne({
        accountId: movement?.ownerAccountId,
        type: 'assault',
      });
      const payload = raiderReport?.payload as {
        wallLevelBefore: number;
        wallLevelAfter: number;
        siegeTarget: string;
        wallPointsSpent: number;
        wallPointsDiscarded: number;
        buildingPointsSpent: number;
        buildingPointsDiscarded: number;
      };
      expect(payload.wallLevelBefore).toBe(expectedSiege.wallLevelBefore);
      expect(payload.wallLevelAfter).toBe(expectedSiege.wallLevelAfter);
      expect(payload.siegeTarget).toBe('wall');
      expect(payload.wallPointsSpent).toBeCloseTo(expectedSiege.wallPointsSpent, 9);
      expect(payload.wallPointsDiscarded).toBeCloseTo(expectedSiege.wallPointsDiscarded, 9);
      expect(payload.buildingPointsDiscarded).toBeCloseTo(expectedSiege.buildingPointsDiscarded, 9);

      const defenseReport = await reportModel.findOne({
        accountId: defender.accountId,
        type: 'defense',
      });
      const defensePayload = defenseReport?.payload as { wallLevelAfter: number };
      expect(defensePayload.wallLevelAfter).toBe(expectedSiege.wallLevelAfter);
    });

    it('with the wall already at 0, building points reach the named building and knock it as expected', async () => {
      const attackerTroops = [
        { unitType: 'brute', count: 5 },
        { unitType: 'ramTruck', count: 10 },
      ];
      const defenderTroops = [{ unitType: 'torcher', count: 2 }];
      // No `wall` entry at all — `currentLevelOf`/`resolveSiegePass` both treat that exactly
      // like a wall already knocked to 0, per `settlements.util.ts`'s own convention.
      const defenderBuildings = [
        { type: 'commandCenter', level: 1 },
        { type: 'warehouse', level: 5 },
      ];

      const { defenderSettlementPre, expectedBattle } = await sendAndArriveSiege({
        attackerTroops,
        defenderTroops,
        defenderBuildings,
        siegeTarget: 'warehouse',
      });
      expect(expectedBattle.attackerPrevailed).toBe(true);

      const expectedSiege = resolveSiegePass(config, expectedBattle, {
        wallLevel: 0,
        siegeTarget: 'warehouse',
        targetBuildingLevel: 5,
      });
      expect(expectedSiege.wallBreached).toBe(true);
      expect(expectedSiege.targetLevelAfter).toBeLessThan(5);

      const defenderAfter = await settlementModel.findById(defenderSettlementPre._id);
      if (!defenderAfter) throw new Error('unreachable');
      expect(levelOfPlain(plainBuildings(defenderAfter), 'warehouse')).toBe(
        expectedSiege.targetLevelAfter,
      );
    });

    it('with the wall standing, every building point is discarded and the named building is untouched', async () => {
      const attackerTroops = [
        { unitType: 'brute', count: 300 },
        { unitType: 'ramTruck', count: 10 },
      ];
      const defenderTroops = [{ unitType: 'torcher', count: 5 }];
      // L20 is deliberately far out of a 10-Ram-Truck army's reach (80 wall points can't even
      // afford the first level's cost off a L20 wall — see `siegeResistance`'s own worked
      // draft in §7) — the wall must stand no matter how lopsided the underlying battle is.
      const defenderBuildings = [
        { type: 'commandCenter', level: 1 },
        { type: 'wall', level: 20 },
        { type: 'warehouse', level: 5 },
      ];

      const { defenderSettlementPre, expectedBattle } = await sendAndArriveSiege({
        attackerTroops,
        defenderTroops,
        defenderBuildings,
        siegeTarget: 'warehouse',
      });
      expect(expectedBattle.attackerPrevailed).toBe(true);

      const expectedSiege = resolveSiegePass(config, expectedBattle, {
        wallLevel: 20,
        siegeTarget: 'warehouse',
        targetBuildingLevel: 5,
      });
      expect(expectedSiege.wallBreached).toBe(false);
      expect(expectedSiege.wallLevelAfter).toBe(20);
      expect(expectedSiege.buildingPointsSpent).toBe(0);
      expect(expectedSiege.buildingPointsDiscarded).toBe(expectedSiege.buildingPoints);
      expect(expectedSiege.targetLevelAfter).toBe(5);

      const defenderAfter = await settlementModel.findById(defenderSettlementPre._id);
      if (!defenderAfter) throw new Error('unreachable');
      const buildingsAfter = plainBuildings(defenderAfter);
      expect(levelOfPlain(buildingsAfter, 'wall')).toBe(20);
      expect(levelOfPlain(buildingsAfter, 'warehouse')).toBe(5);

      // No level changed at all — no `buildingDestroyed` report should have been written.
      const destroyedReport = await reportModel.findOne({
        accountId: defenderSettlementPre.accountId,
        type: 'buildingDestroyed',
      });
      expect(destroyedReport).toBeNull();
    });

    it('the Command Center floors at 1 under overwhelming siege points and never reaches 0', async () => {
      const attackerTroops = [{ unitType: 'ramTruck', count: 500 }];
      const defenderTroops = [{ unitType: 'torcher', count: 5 }];
      const defenderBuildings = [{ type: 'commandCenter', level: 3 }];

      const { defenderSettlementPre, expectedBattle } = await sendAndArriveSiege({
        attackerTroops,
        defenderTroops,
        defenderBuildings,
        siegeTarget: 'commandCenter',
      });
      expect(expectedBattle.attackerPrevailed).toBe(true);

      const expectedSiege = resolveSiegePass(config, expectedBattle, {
        wallLevel: 0,
        siegeTarget: 'commandCenter',
        targetBuildingLevel: 3,
      });
      expect(expectedSiege.targetLevelAfter).toBe(config.siege.commandCenterFloor);
      expect(expectedSiege.buildingPointsDiscarded).toBeGreaterThan(0);

      const defenderAfter = await settlementModel.findById(defenderSettlementPre._id);
      if (!defenderAfter) throw new Error('unreachable');
      const ccLevel = levelOfPlain(plainBuildings(defenderAfter), 'commandCenter');
      expect(ccLevel).toBe(config.siege.commandCenterFloor);
      expect(ccLevel).toBeGreaterThanOrEqual(1);
    });

    it('a defeated attacker gets no siege pass — the defender’s levels are untouched', async () => {
      const attackerTroops = [{ unitType: 'ramTruck', count: 5 }];
      const defenderTroops = [{ unitType: 'torcher', count: 5000 }];
      const defenderBuildings = [
        { type: 'commandCenter', level: 1 },
        { type: 'wall', level: 5 },
        { type: 'warehouse', level: 5 },
      ];

      const { defenderSettlementPre, movementId, expectedBattle } = await sendAndArriveSiege({
        attackerTroops,
        defenderTroops,
        defenderBuildings,
        siegeTarget: 'warehouse',
      });
      // Overwhelmed regardless of the ±5% roll — the defeated-attacker half of §7's rule.
      expect(expectedBattle.x).toBe(1);
      expect(expectedBattle.attackerPrevailed).toBe(false);

      const movement = await movementModel.findById(movementId);
      expect(movement?.status).toBe('done');

      const defenderAfter = await settlementModel.findById(defenderSettlementPre._id);
      if (!defenderAfter) throw new Error('unreachable');
      expect(plainBuildings(defenderAfter)).toEqual(defenderBuildings);

      const destroyedReport = await reportModel.findOne({
        accountId: defenderSettlementPre.accountId,
        type: 'buildingDestroyed',
      });
      expect(destroyedReport).toBeNull();
    });

    it('the storage clamp: destroying a Warehouse below the level needed to hold the defender’s stock leaves them at exactly the new cap; loot comes off first, then the clamp', async () => {
      // Small carry capacity on purpose (only the brutes carry anything — Ram Trucks carry 0)
      // so loot alone doesn't already empty the stockpile, leaving plenty behind for the
      // clamp to actually act on.
      const attackerTroops = [
        { unitType: 'brute', count: 5 },
        { unitType: 'ramTruck', count: 500 },
      ];
      const defenderTroops = [{ unitType: 'torcher', count: 2 }];
      const warehouseLevelBefore = 10;
      const defenderBuildings = [
        { type: 'commandCenter', level: 1 },
        { type: 'warehouse', level: warehouseLevelBefore },
      ];
      // Comfortably under the level-10 cap, comfortably over the level-0 (fully destroyed)
      // cap — computed from the live config rather than a hand-picked literal, so a future
      // storage retune can't silently make this fixture stop exercising the clamp.
      const capAtStart = calcStorageCaps(config, [
        { type: 'commandCenter', level: 1 },
        { type: 'warehouse', level: warehouseLevelBefore },
      ]);
      const capAtZero = calcStorageCaps(config, [{ type: 'commandCenter', level: 1 }]);
      const stockValue = (capAtStart.scrap + capAtZero.scrap) / 2;
      expect(stockValue).toBeGreaterThan(capAtZero.scrap);
      expect(stockValue).toBeLessThan(capAtStart.scrap);
      const defenderResources: Resources = {
        scrap: stockValue,
        fuel: stockValue,
        electronics: stockValue,
        // Comfortably under the (Cold-Storage-gated, untouched by this Warehouse siege) Food
        // cap — Food's cap never changes here, so it must never end up clamped, unlike
        // scrap/fuel/electronics above.
        food: capAtZero.food / 4,
      };

      const { defender, defenderSettlementPre, movementId, expectedBattle } =
        await sendAndArriveSiege({
          attackerTroops,
          defenderTroops,
          defenderBuildings,
          defenderResources,
          siegeTarget: 'warehouse',
        });
      expect(expectedBattle.attackerPrevailed).toBe(true);

      const expectedSiege = resolveSiegePass(config, expectedBattle, {
        wallLevel: 0,
        siegeTarget: 'warehouse',
        targetBuildingLevel: warehouseLevelBefore,
      });
      // The whole point of this fixture: 500 Ram Trucks' building points fully clear a L10
      // Warehouse (§7's own worked draft shows a far smaller force clearing most of a L10
      // wall), so the new cap is the fully-destroyed floor.
      expect(expectedSiege.targetLevelAfter).toBe(0);

      const defenderAfter = await settlementModel.findById(defenderSettlementPre._id);
      if (!defenderAfter) throw new Error('unreachable');
      // Reconstructs the defender's *exact* settled-at-arrival resources — same convention as
      // the M3c.5a loot suite's own `reconstructSettledDefenderResources` (this resolver
      // settles `targetDoc` to `event.dueAt` before ever touching loot or the siege pass, so
      // re-running `settleResources` from the seed snapshot up to that now-persisted instant
      // reproduces the pre-loot figure bit-for-bit — no real-clock drift tolerance needed).
      // Both resources here (`scrap`/`fuel`/`electronics`) have zero production in this
      // fixture's bare `[commandCenter, warehouse]` buildings, so this would hold even
      // without the reconstruction, but doing it properly keeps the fixture correct if it's
      // ever extended with a real producer.
      const settledStored = settleResources(
        config,
        defenderBuildings as BuildingLevels,
        { values: defenderResources, lastCalcAt: defenderSettlementPre.resources.lastCalcAt },
        defenderAfter.resources.lastCalcAt,
        defenderTroops as TroopCounts,
      ).values;

      const expectedLoot = resolveLoot(config, expectedBattle, {
        stored: settledStored,
        hiddenCacheLevel: 0,
      });
      const newCaps = calcStorageCaps(config, [
        { type: 'commandCenter', level: 1 },
        { type: 'warehouse', level: expectedSiege.targetLevelAfter },
      ]);
      const postLoot = subtractResources(settledStored, expectedLoot.taken);
      const expectedFinal: Resources = { scrap: 0, fuel: 0, electronics: 0, food: 0 };
      const expectedClamped: Resources = { scrap: 0, fuel: 0, electronics: 0, food: 0 };
      for (const kind of RESOURCE_KINDS) {
        expectedFinal[kind] = Math.min(postLoot[kind], newCaps[kind]);
        expectedClamped[kind] = Math.max(0, postLoot[kind] - newCaps[kind]);
      }
      // Food's cap depends on Cold Storage (untouched here), so it is never clamped —
      // isolates "the clamp only ever touches the resources the destroyed building gated".
      expect(expectedClamped.food).toBe(0);
      expect(expectedClamped.scrap).toBeGreaterThan(0);

      expect(plainStoredResources(defenderAfter)).toEqual(expectedFinal);
      expect(levelOfPlain(plainBuildings(defenderAfter), 'warehouse')).toBe(0);

      const movement = await movementModel.findById(movementId);
      expect(movement?.status).toBe('returning');

      const destroyedReport = await reportModel.findOne({
        accountId: defender.accountId,
        type: 'buildingDestroyed',
      });
      expect(destroyedReport).not.toBeNull();
      const destroyedPayload = destroyedReport?.payload as {
        siegeTarget: string;
        targetLevelBefore: number;
        targetLevelAfter: number;
        storageClamped: Resources;
      };
      expect(destroyedPayload.siegeTarget).toBe('warehouse');
      expect(destroyedPayload.targetLevelBefore).toBe(warehouseLevelBefore);
      expect(destroyedPayload.targetLevelAfter).toBe(0);
      for (const kind of RESOURCE_KINDS) {
        expect(destroyedPayload.storageClamped[kind]).toBeCloseTo(expectedClamped[kind], 6);
      }
    });

    it('a raid carrying no siege units changes no level — the assault-only gate holds', async () => {
      const attackerTroops = [{ unitType: 'brute', count: 100 }];
      const defenderTroops = [{ unitType: 'torcher', count: 2 }];
      const defenderBuildings = [
        { type: 'commandCenter', level: 1 },
        { type: 'wall', level: 10 },
        { type: 'warehouse', level: 5 },
      ];

      const { defenderSettlementPre, movementId, expectedBattle } = await sendAndArriveSiege({
        type: 'raid',
        attackerTroops,
        defenderTroops,
        defenderBuildings,
      });
      expect(expectedBattle.attackerPrevailed).toBe(true);

      const defenderAfter = await settlementModel.findById(defenderSettlementPre._id);
      if (!defenderAfter) throw new Error('unreachable');
      expect(plainBuildings(defenderAfter)).toEqual(defenderBuildings);

      const movement = await movementModel.findById(movementId);
      const raiderReport = await reportModel.findOne({
        accountId: movement?.ownerAccountId,
        type: 'raid',
      });
      const payload = raiderReport?.payload as Record<string, unknown>;
      expect(payload['wallLevelBefore']).toBeUndefined();
      expect(payload['siegeTarget']).toBeUndefined();

      const destroyedReport = await reportModel.findOne({ type: 'buildingDestroyed' });
      expect(destroyedReport).toBeNull();
    });

    it('replay safety: the same arrive event run twice knocks the levels once', async () => {
      const attackerTroops = [
        { unitType: 'brute', count: 200 },
        { unitType: 'ramTruck', count: 10 },
      ];
      const defenderTroops = [{ unitType: 'torcher', count: 5 }];
      const defenderBuildings = [
        { type: 'commandCenter', level: 1 },
        { type: 'wall', level: 10 },
      ];

      const { defenderSettlementPre, movementId, expectedBattle } = await sendAndArriveSiege({
        attackerTroops,
        defenderTroops,
        defenderBuildings,
        siegeTarget: 'wall',
      });
      expect(expectedBattle.attackerPrevailed).toBe(true);

      const defenderOnce = await settlementModel.findById(defenderSettlementPre._id);
      if (!defenderOnce) throw new Error('unreachable');
      const wallAfterOnce = levelOfPlain(plainBuildings(defenderOnce), 'wall');
      expect(wallAfterOnce).toBeLessThan(10);

      // Same replay convention as the M3c.4/M3c.5a suites' own idempotency tests: the
      // movement already advanced past `outbound` (to `returning`, since the attacker
      // survived), so `MovementArriveHandler`'s own status guard is what makes a second call
      // a no-op — re-running the scheduler again must not knock the wall a second time.
      const movement = await movementModel.findById(movementId);
      if (!movement) throw new Error('unreachable');
      expect(movement.status).toBe('returning');
      const arriveEvent = await eventModel.findOne({
        type: 'movementArrive',
        'payload.movementId': movementId,
      });
      if (!arriveEvent) throw new Error('unreachable');

      const session = await connection.startSession();
      try {
        await session.withTransaction(async () => {
          await movementArriveHandler.handle(arriveEvent, session);
        });
      } finally {
        await session.endSession();
      }

      const defenderTwice = await settlementModel.findById(defenderSettlementPre._id);
      if (!defenderTwice) throw new Error('unreachable');
      expect(levelOfPlain(plainBuildings(defenderTwice), 'wall')).toBe(wallAfterOnce);
      expect(defenderTwice.version).toBe(defenderOnce.version);
    });

    it('a building knocked to 0 can then be rebuilt through the real POST build API', async () => {
      const attackerTroops = [{ unitType: 'ramTruck', count: 200 }];
      const defenderTroops = [{ unitType: 'torcher', count: 2 }];
      // A maxed Greenhouse Farm, not just a bare Command Center: `startBuild`'s own Food gate
      // (M1 §4) applies here exactly as it would to any other build, and this test's point is
      // only to prove the rebuild path itself accepts a level-0 existing entry — the ample
      // headroom keeps that gate out of the way.
      const defenderBuildings = [
        { type: 'commandCenter', level: 1 },
        { type: 'greenhouseFarm', level: config.buildings.greenhouseFarm.maxLevel },
        { type: 'warehouse', level: 1 },
      ];

      const { defender, defenderSettlementPre, expectedBattle } = await sendAndArriveSiege({
        attackerTroops,
        defenderTroops,
        defenderBuildings,
        siegeTarget: 'warehouse',
      });
      expect(expectedBattle.attackerPrevailed).toBe(true);

      const defenderAfter = await settlementModel.findById(defenderSettlementPre._id);
      if (!defenderAfter) throw new Error('unreachable');
      expect(levelOfPlain(plainBuildings(defenderAfter), 'warehouse')).toBe(0);

      const buildResponse = await postBuild(
        String(defenderSettlementPre._id),
        defender.cookie,
        'warehouse',
      );
      expect(buildResponse.status).toBe(200);
      expect(buildResponse.body.buildQueue).toHaveLength(1);
      expect(buildResponse.body.buildQueue[0].type).toBe('warehouse');
      // §7: the ruin's slot is an ordinary 0 -> 1 upgrade, not a free jump — the same rule
      // `startBuild` already applies to a settlement's very first Warehouse.
      expect(buildResponse.body.buildQueue[0].targetLevel).toBe(1);
    });
  });
});
