import { randomUUID } from 'node:crypto';

import type {
  BuildingLevels,
  GameConfig,
  OasisLiveState,
  Resources,
  TroopCounts,
} from '@last-signal/game-core';
import {
  DEFAULT_CONFIG,
  HOUR_MS,
  RESOURCE_KINDS,
  addResources,
  battleRoll,
  calcInfluence,
  calcNetFoodPerHour,
  calcNetRates,
  calcStorageCaps,
  calcTroopFoodUpkeepPerHour,
  chebyshevDistance,
  hiddenCacheProtection,
  isSettleable,
  oasisTargetDefenders,
  resolveBattle,
  resolveLoot,
  resolveScoutCombat,
  resolveSiegePass,
  settleOasis,
  settleResources,
  settlementsAllowed,
  slowestTroopSpeed,
  subtractResources,
  terrainAt,
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
import type { OasisDocument } from '../schemas/oasis.schema';
import { Oasis } from '../schemas/oasis.schema';
import type { ReportDocument } from '../schemas/report.schema';
import { Report } from '../schemas/report.schema';
import type { SettlementDocument } from '../schemas/settlement.schema';
import { Settlement } from '../schemas/settlement.schema';
import { OasisService } from '../oasis/oasis.service';
import { SchedulerService } from '../scheduler/scheduler.service';
import { STARTING_RESOURCES } from '../settlements/settlements.constants';
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
  let oasisModel: Model<OasisDocument>;
  let schedulerService: SchedulerService;
  let movementArriveHandler: MovementArriveHandler;
  let movementReturnHandler: MovementReturnHandler;
  let worldService: WorldService;
  let oasisService: OasisService;

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
    // Explicit IPv4-bound single listener — avoids ephemeral-port collisions with other
    // local processes; see `accounts.integration.spec.ts`'s beforeAll for why this matters.
    await app.listen(0, '127.0.0.1');

    connection = moduleRef.get(getConnectionToken());
    accountModel = moduleRef.get(getModelToken(Account.name));
    settlementModel = moduleRef.get(getModelToken(Settlement.name));
    movementModel = moduleRef.get(getModelToken(Movement.name));
    reportModel = moduleRef.get(getModelToken(Report.name));
    eventModel = moduleRef.get(getModelToken(GameEvent.name));
    oasisModel = moduleRef.get(getModelToken(Oasis.name));
    schedulerService = moduleRef.get(SchedulerService);
    movementArriveHandler = moduleRef.get(MovementArriveHandler);
    movementReturnHandler = moduleRef.get(MovementReturnHandler);
    worldService = moduleRef.get(WorldService);
    oasisService = moduleRef.get(OasisService);
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

  interface SeedOasisOptions {
    defenders?: ReadonlyArray<{ unitType: string; count: number }>;
    food?: number;
    lastRegenAt?: number | null;
    lastDefenderRegenAt?: number | null;
  }

  // Seeds a farm oasis directly via Mongoose at a fixed, caller-chosen coordinate — the M2b.3
  // convention `seedSettlementAt` establishes, applied to `Oasis` (M3c.7a). Defaults to the
  // exact shape `generateOases` (M2 §2) itself writes: coordinates + type only, every live-
  // state field at its schema default (`lastRegenAt`/`lastDefenderRegenAt` both `null` — never
  // settled since world generation). `x`/`y` MUST land outside `config.map.oases.edgeMargin`
  // of the grid edge (`|x|` or `|y|` > `config.map.radius - config.map.oases.edgeMargin`,
  // i.e. > 28 at the default config) — `generateOases` itself never places a real oasis there
  // (`packages/game-core/src/map/oases.ts`'s own doc comment), which is what makes this
  // helper's `oasisModel.create` collision-free against the 24 real oases
  // `WorldService.bootstrap` already placed for this suite's shared world, without needing a
  // per-test oasis cleanup pass (every existing describe block in this file already relies on
  // the identical property one level up: a hand-picked settlement coordinate near the grid
  // edge, e.g. `(30, 30)` in the cancel-window tests below, never collides with a real NPC
  // settlement either).
  async function seedOasisAt(
    x: number,
    y: number,
    options: SeedOasisOptions = {},
  ): Promise<OasisDocument> {
    return oasisModel.create({
      x,
      y,
      type: 'farm',
      // Mongoose's own `create` typings want a mutable array — `.map` produces a fresh one
      // regardless of whether `options.defenders` came in as a `TroopCounts` (`readonly`).
      defenders: (options.defenders ?? []).map((d) => ({ unitType: d.unitType, count: d.count })),
      loot: { food: options.food ?? 0 },
      lastRegenAt: options.lastRegenAt ?? null,
      lastDefenderRegenAt: options.lastDefenderRegenAt ?? null,
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

  // M3c.8: `GET /api/movements/incoming` — the movements currently inbound to the caller's
  // own settlements.
  function getIncoming(cookie: string[]) {
    return request(app.getHttpServer()).get('/api/movements/incoming').set('Cookie', cookie);
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
    // `settle` became sendable in M3d.1 (its own suite below covers it) — `trade` is the one
    // schema-widened type still genuinely unsendable (the Market is a later M3d step), so it's
    // what stands in for "an unrecognised/unsendable type" here now.
    const response = await postSend(attacker.cookie, {
      type: 'trade',
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

      // M3c.6 (Deliverable 3): support to the settlement it was sent FROM is rejected — a
      // zero-distance no-op that would make the arrival resolver write the same settlement
      // document twice. This test used to assert the opposite ("support to the caller's own
      // settlement succeeds") back when M3c.3 only had one settlement per account to test
      // against; see the sibling test below for proof that support to the caller's OTHER
      // settlement (the case §8's "your own or anyone else's" is actually about) still works.
      it('support to the settlement it was sent from is rejected with targetIsOrigin', async () => {
        const attacker = await createGuestSession();
        const troops = [{ unitType: 'brute', count: 2 }];
        const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, { troops });

        const response = await postSend(attacker.cookie, {
          type: 'support',
          fromSettlementId: String(attackerSettlement._id),
          target: { x: 0, y: 0 },
          units: troops,
        });
        expect(response.status).toBe(400);
        expect(response.body.error.key).toBe('errors.movement.targetIsOrigin');
        expect(await movementModel.countDocuments({})).toBe(0);
      });

      it('support to the caller’s OTHER settlement succeeds (§8: “your own or anyone else’s”)', async () => {
        const attacker = await createGuestSession();
        const troops = [{ unitType: 'brute', count: 2 }];
        const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, { troops });
        await seedSettlementAt(attacker.accountId, 9, 9);

        const response = await postSend(attacker.cookie, {
          type: 'support',
          fromSettlementId: String(attackerSettlement._id),
          target: { x: 9, y: 9 },
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

    it('trade is still rejected with errors.movement.unknownType (settle became sendable in M3d.1, its own suite below covers it)', async () => {
      const attacker = await createGuestSession();
      const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
        troops: [{ unitType: 'brute', count: 1 }],
      });

      const response = await postSend(attacker.cookie, {
        type: 'trade',
        fromSettlementId: String(attackerSettlement._id),
        target: { x: 5, y: 0 },
        units: [{ unitType: 'brute', count: 1 }],
      });
      expect(response.status).toBe(400);
      expect(response.body.error.key).toBe('errors.movement.unknownType');
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
        // M3c.6 (Deliverable 3) forbids support to the very settlement it departs from, so
        // this test's support call needs a genuinely different target — the caller's OTHER
        // settlement, still covered by §8's "your own or anyone else's".
        await seedSettlementAt(attacker.accountId, 9, 9);
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

        // Support to the caller's own (other) settlement — also must not lift it.
        const supportResponse = await postSend(attacker.cookie, {
          type: 'support',
          fromSettlementId: String(attackerSettlement._id),
          target: { x: 9, y: 9 },
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

    // M3c.3 pinned this same guard against a `raid` arrival, then against a `support`
    // arrival once `raid`/`assault` got their own resolver in M3c.4 — see that revision's
    // history for the test this replaced. M3c.6 gives `support` its own resolver too
    // (`SupportArrivalResolver`, see the "M3c.6: support arrival..." suite below), so the
    // guard no longer applies to any of the four sendable movement types; `settle`/`trade`
    // are the only types left behind it, and neither is reachable through the send API
    // (`errors.movement.unknownType`, asserted above), so there is no remaining API-level
    // way to exercise the guard directly. It is still exercised at the unit level by
    // `MovementArriveHandler`'s own constructor throwing on a duplicate registration, and the
    // guard's code path itself is simple enough (a `Map.get` miss) that this is an acceptable
    // coverage gap rather than one worth reaching into Mongo directly to close.
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

  // M3c.6: `SupportArrivalResolver` (§3/§8/§9/§15/§18) plus the recall/evict command pair
  // (§8). Every numeric expectation is derived from `game-core` at assertion time — never a
  // hardcoded upkeep/travel-time constant — per this file's own "derive, don't hardcode"
  // convention (see the M3c.4/M3c.5a suites' identical discipline for battle/loot numbers).
  describe('M3c.6: support arrival, stationed-scout defence, and the recall/evict pair', () => {
    function postRecall(cookie: string[], body: Record<string, unknown>) {
      return request(app.getHttpServer())
        .post('/api/movements/recall')
        .set('Cookie', cookie)
        .send(body);
    }

    function postEvict(cookie: string[], body: Record<string, unknown>) {
      return request(app.getHttpServer())
        .post('/api/movements/evict')
        .set('Cookie', cookie)
        .send(body);
    }

    // Sends a `support` movement and force-arrives it in one step — every test below cares
    // about the *arrived* state, never the outbound leg (already covered by the M3c.3 send
    // suite), so this collapses the two calls the way `sendAndArriveSiege` does for M3c.5b.
    async function sendAndArriveSupport(
      cookie: string[],
      fromSettlementId: string,
      target: { x: number; y: number },
      troops: Array<{ unitType: string; count: number }>,
    ): Promise<string> {
      const response = await postSend(cookie, {
        type: 'support',
        fromSettlementId,
        target,
        units: troops,
      });
      expect(response.status).toBe(201);
      const movementId = response.body.id as string;
      await forceArrive(movementId);
      return movementId;
    }

    // The lowest Greenhouse Farm level whose hourly production alone (bare Command Center
    // plus that farm, no troops) covers at least `minFood` of headroom — mirrors
    // `settlements.integration.spec.ts`'s own `farmLevelCovering` exactly (same rationale:
    // deriving a "barely positive net Food" fixture from the real formula rather than a
    // guessed building level, which would silently drift the moment the economy is retuned).
    function farmLevelCovering(minFood: number): number {
      const def = config.buildings.greenhouseFarm;
      for (let level = 1; level <= def.maxLevel; level += 1) {
        const buildings: BuildingLevels = [
          { type: 'commandCenter', level: 1 },
          { type: 'greenhouseFarm', level },
        ];
        const headroom = calcNetFoodPerHour(config, buildings, []);
        if (headroom >= minFood) {
          return level;
        }
      }
      throw new Error('farmLevelCovering: no level of Greenhouse Farm covers the requested amount');
    }

    describe('support arrival', () => {
      it('a support movement arrives: host gains a tagged contingent, origin’s awayTroops empties, the movement is done, and netFoodPerHour moves by exactly the contingent’s upkeep on both sides', async () => {
        const supporter = await createGuestSession();
        const host = await createGuestSession();
        const troops = [{ unitType: 'brute', count: 10 }];
        const supporterSettlement = await seedSettlementAt(supporter.accountId, 0, 0, { troops });
        const hostSettlement = await seedSettlementAt(host.accountId, 5, 0);

        const hostBefore = await getSettlement(host.cookie, String(hostSettlement._id));

        const sendResponse = await postSend(supporter.cookie, {
          type: 'support',
          fromSettlementId: String(supporterSettlement._id),
          target: { x: 5, y: 0 },
          units: troops,
        });
        expect(sendResponse.status).toBe(201);
        const movementId = sendResponse.body.id as string;

        // Sending leaves upkeep unchanged (M3a.4) — captured here, before arrival, as the
        // origin's own "before" baseline for the rise this test proves below.
        const supporterBeforeArrive = await getSettlement(
          supporter.cookie,
          String(supporterSettlement._id),
        );

        await forceArrive(movementId);

        const movement = await movementModel.findById(movementId);
        expect(movement?.status).toBe('done');
        expect(plainUnitEntries(movement?.survivors)).toEqual(troops);
        // §3/§8: no return leg for a support arrival.
        expect(
          await eventModel.countDocuments({
            type: 'movementReturn',
            'payload.movementId': movementId,
          }),
        ).toBe(0);

        const hostDoc = await settlementModel.findById(hostSettlement._id);
        expect(hostDoc?.stationedTroops).toHaveLength(1);
        const contingent = hostDoc?.stationedTroops?.[0];
        expect(String(contingent?.ownerAccountId)).toBe(String(supporter.accountId));
        expect(String(contingent?.fromSettlementId)).toBe(String(supporterSettlement._id));
        expect(plainUnitEntries(contingent?.troops)).toEqual(troops);

        const originDoc = await settlementModel.findById(supporterSettlement._id);
        expect(plainUnitEntries(originDoc?.awayTroops)).toEqual([]);

        const expectedUpkeep = calcTroopFoodUpkeepPerHour(config, troops as TroopCounts);

        const hostAfter = await getSettlement(host.cookie, String(hostSettlement._id));
        expect(hostAfter.body.netFoodPerHour).toBeCloseTo(
          hostBefore.body.netFoodPerHour - expectedUpkeep,
          6,
        );

        const supporterAfter = await getSettlement(
          supporter.cookie,
          String(supporterSettlement._id),
        );
        expect(supporterAfter.body.netFoodPerHour).toBeCloseTo(
          supporterBeforeArrive.body.netFoodPerHour + expectedUpkeep,
          6,
        );
      });

      it('two support movements from the SAME origin merge into one contingent', async () => {
        const supporter = await createGuestSession();
        const host = await createGuestSession();
        const supporterSettlement = await seedSettlementAt(supporter.accountId, 0, 0, {
          troops: [{ unitType: 'brute', count: 10 }],
        });
        const hostSettlement = await seedSettlementAt(host.accountId, 5, 0);

        await sendAndArriveSupport(
          supporter.cookie,
          String(supporterSettlement._id),
          { x: 5, y: 0 },
          [{ unitType: 'brute', count: 4 }],
        );
        await sendAndArriveSupport(
          supporter.cookie,
          String(supporterSettlement._id),
          { x: 5, y: 0 },
          [{ unitType: 'brute', count: 3 }],
        );

        const hostDoc = await settlementModel.findById(hostSettlement._id);
        expect(hostDoc?.stationedTroops).toHaveLength(1);
        expect(plainUnitEntries(hostDoc?.stationedTroops?.[0]?.troops)).toEqual([
          { unitType: 'brute', count: 7 },
        ]);
      });

      it('two support movements from DIFFERENT origins stay as two contingents', async () => {
        const supporterA = await createGuestSession();
        const supporterB = await createGuestSession();
        const host = await createGuestSession();
        const settlementA = await seedSettlementAt(supporterA.accountId, 0, 0, {
          troops: [{ unitType: 'brute', count: 5 }],
        });
        const settlementB = await seedSettlementAt(supporterB.accountId, -5, 0, {
          troops: [{ unitType: 'brute', count: 5 }],
        });
        const hostSettlement = await seedSettlementAt(host.accountId, 5, 0);

        await sendAndArriveSupport(supporterA.cookie, String(settlementA._id), { x: 5, y: 0 }, [
          { unitType: 'brute', count: 2 },
        ]);
        await sendAndArriveSupport(supporterB.cookie, String(settlementB._id), { x: 5, y: 0 }, [
          { unitType: 'brute', count: 3 },
        ]);

        const hostDoc = await settlementModel.findById(hostSettlement._id);
        expect(hostDoc?.stationedTroops).toHaveLength(2);
        const owners = (hostDoc?.stationedTroops ?? []).map((c) => String(c.ownerAccountId)).sort();
        expect(owners).toEqual([String(supporterA.accountId), String(supporterB.accountId)].sort());
      });

      it('replay safety: running the same movementArrive event twice adds the contingent ONCE', async () => {
        const supporter = await createGuestSession();
        const host = await createGuestSession();
        const troops = [{ unitType: 'brute', count: 5 }];
        const supporterSettlement = await seedSettlementAt(supporter.accountId, 0, 0, { troops });
        const hostSettlement = await seedSettlementAt(host.accountId, 5, 0);

        const sendResponse = await postSend(supporter.cookie, {
          type: 'support',
          fromSettlementId: String(supporterSettlement._id),
          target: { x: 5, y: 0 },
          units: troops,
        });
        expect(sendResponse.status).toBe(201);
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
        const hostAfterFirst = await settlementModel.findById(hostSettlement._id);
        expect(hostAfterFirst?.stationedTroops).toHaveLength(1);
        expect(plainUnitEntries(hostAfterFirst?.stationedTroops?.[0]?.troops)).toEqual(troops);

        await replayArrive();
        const hostAfterSecond = await settlementModel.findById(hostSettlement._id);
        expect(hostAfterSecond?.stationedTroops).toHaveLength(1);
        expect(plainUnitEntries(hostAfterSecond?.stationedTroops?.[0]?.troops)).toEqual(troops);

        const movementAfter = await movementModel.findById(movementId);
        expect(movementAfter?.status).toBe('done');
      });

      it('support sent from a settlement to itself is rejected with errors.movement.targetIsOrigin', async () => {
        const account = await createGuestSession();
        const settlement = await seedSettlementAt(account.accountId, 0, 0, {
          troops: [{ unitType: 'brute', count: 1 }],
        });

        const response = await postSend(account.cookie, {
          type: 'support',
          fromSettlementId: String(settlement._id),
          target: { x: 0, y: 0 },
          units: [{ unitType: 'brute', count: 1 }],
        });
        expect(response.status).toBe(400);
        expect(response.body.error.key).toBe('errors.movement.targetIsOrigin');
        expect(await movementModel.countDocuments({})).toBe(0);
      });
    });

    describe('§8: stationed contingents count for the host’s battle defence and scout detection', () => {
      it('a contingent that arrived through the real support flow defends the host’s next battle, and its owner gets a supportLoss report', async () => {
        const attacker = await createGuestSession();
        const host = await createGuestSession();
        const supporter = await createGuestSession();

        // Same numbers as the M3c.4 suite's own hand-verified "a stationed contingent
        // defends" test (seeded directly there) — reused here because that combination is
        // already proven to produce real casualties on the stationed side, which is exactly
        // what this test needs to prove a `supportLoss` report gets written.
        const attackerTroops = [{ unitType: 'brute', count: 30 }];
        const homeTroops = [{ unitType: 'torcher', count: 2 }];
        const contingentTroops = [{ unitType: 'torcher', count: 10 }];

        const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
          troops: attackerTroops,
        });
        const supporterSettlement = await seedSettlementAt(supporter.accountId, -5, 0, {
          troops: contingentTroops,
        });
        const hostSettlement = await seedSettlementAt(host.accountId, 5, 0, {
          troops: homeTroops,
        });

        await sendAndArriveSupport(
          supporter.cookie,
          String(supporterSettlement._id),
          { x: 5, y: 0 },
          contingentTroops,
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
        const expectedWithStationed = resolveBattle(config, {
          attacker: attackerTroops as TroopCounts,
          defenders: [
            { key: 'home', troops: homeTroops as TroopCounts },
            { key: stationedKey, troops: contingentTroops as TroopCounts },
          ],
          wallLevel: 0,
          kind: 'raid',
          roll,
        });
        const expectedHomeOnly = resolveBattle(config, {
          attacker: attackerTroops as TroopCounts,
          defenders: [{ key: 'home', troops: homeTroops as TroopCounts }],
          wallLevel: 0,
          kind: 'raid',
          roll,
        });
        // The contingent that arrived through the real send -> arrive flow genuinely
        // contributed to the defence — the same battle resolved without it is measurably
        // easier for the attacker.
        expect(expectedWithStationed.defPts).toBeGreaterThan(expectedHomeOnly.defPts);

        const stationedOutcome = expectedWithStationed.defenders.find(
          (d) => d.key === stationedKey,
        );
        if (!stationedOutcome) throw new Error('unreachable');
        const expectedLosses = stationedOutcome.losses.filter((l) => l.count > 0);
        expect(expectedLosses.length).toBeGreaterThan(0);

        const supporterReports = await reportModel.find({
          accountId: supporter.accountId,
          type: 'supportLoss',
        });
        expect(supporterReports).toHaveLength(1);
        const payload = supporterReports[0]?.payload as Record<string, unknown>;
        expect(payload['hostSettlementId']).toBe(String(hostSettlement._id));
        expect(payload['losses']).toEqual(expectedLosses);
      });

      it('stationed scouts defend: a host with ZERO home scouts but a stationed scout contingent still detects an incoming scout, and the report goes to the host owner only', async () => {
        const attacker = await createGuestSession();
        const host = await createGuestSession();
        const supporter = await createGuestSession();

        const attackerTroops = [{ unitType: 'falconer', count: 2 }];
        const stationedScouts = [{ unitType: 'lookout', count: 2 }];
        const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
          troops: attackerTroops,
        });
        const supporterSettlement = await seedSettlementAt(supporter.accountId, -5, 0, {
          troops: stationedScouts,
        });
        // Zero home scouts — without §8's widening, this settlement would be undetectable.
        await seedSettlementAt(host.accountId, 5, 0, { troops: [] });

        await sendAndArriveSupport(
          supporter.cookie,
          String(supporterSettlement._id),
          { x: 5, y: 0 },
          stationedScouts,
        );

        const sendResponse = await postSend(attacker.cookie, {
          type: 'scout',
          fromSettlementId: String(attackerSettlement._id),
          target: { x: 5, y: 0 },
          units: attackerTroops,
        });
        expect(sendResponse.status).toBe(201);
        await forceArrive(sendResponse.body.id as string);

        const hostReport = await reportModel.findOne({
          accountId: host.accountId,
          type: 'scoutDetected',
        });
        expect(hostReport).not.toBeNull();
        expect(hostReport?.payload).toMatchObject({
          attackerAccountId: String(attacker.accountId),
        });

        // §8: "the counter-report still goes to the settlement owner only — supporters are
        // not intelligence subscribers."
        const supporterReport = await reportModel.findOne({
          accountId: supporter.accountId,
          type: 'scoutDetected',
        });
        expect(supporterReport).toBeNull();
      });
    });

    describe('recall and evict', () => {
      it('recall: leaves the host, credits the origin’s awayTroops, creates a returning movement owned by the contingent’s owner, and lands home once movementReturn runs', async () => {
        const supporter = await createGuestSession();
        const host = await createGuestSession();
        const troops = [{ unitType: 'brute', count: 6 }];
        const supporterSettlement = await seedSettlementAt(supporter.accountId, 0, 0, { troops });
        const hostSettlement = await seedSettlementAt(host.accountId, 5, 0);

        await sendAndArriveSupport(
          supporter.cookie,
          String(supporterSettlement._id),
          { x: 5, y: 0 },
          troops,
        );

        const recallResponse = await postRecall(supporter.cookie, {
          hostSettlementId: String(hostSettlement._id),
          fromSettlementId: String(supporterSettlement._id),
        });
        expect(recallResponse.status).toBe(200);
        expect(recallResponse.body.type).toBe('support');
        expect(recallResponse.body.status).toBe('returning');
        expect(recallResponse.body.units).toEqual(troops);
        expect(recallResponse.body.survivors).toEqual(troops);

        const hostAfter = await settlementModel.findById(hostSettlement._id);
        expect(hostAfter?.stationedTroops).toEqual([]);

        const originAfter = await settlementModel.findById(supporterSettlement._id);
        expect(plainUnitEntries(originAfter?.awayTroops)).toEqual(troops);
        expect(plainUnitEntries(originAfter?.troops)).toEqual([]);

        const recallMovementId = recallResponse.body.id as string;
        const recallMovement = await movementModel.findById(recallMovementId);
        expect(String(recallMovement?.ownerAccountId)).toBe(String(supporter.accountId));
        expect(recallMovement?.status).toBe('returning');

        await forceReturn(recallMovementId);

        const originFinal = await settlementModel.findById(supporterSettlement._id);
        expect(plainUnitEntries(originFinal?.troops)).toEqual(troops);
        expect(plainUnitEntries(originFinal?.awayTroops)).toEqual([]);

        const recallMovementFinal = await movementModel.findById(recallMovementId);
        expect(recallMovementFinal?.status).toBe('done');
      });

      it('evict: the host sends a foreign contingent home; the created movement is owned by the contingent’s owner, not the host', async () => {
        const supporter = await createGuestSession();
        const host = await createGuestSession();
        const troops = [{ unitType: 'brute', count: 6 }];
        const supporterSettlement = await seedSettlementAt(supporter.accountId, 0, 0, { troops });
        const hostSettlement = await seedSettlementAt(host.accountId, 5, 0);

        await sendAndArriveSupport(
          supporter.cookie,
          String(supporterSettlement._id),
          { x: 5, y: 0 },
          troops,
        );

        const evictResponse = await postEvict(host.cookie, {
          hostSettlementId: String(hostSettlement._id),
          ownerAccountId: String(supporter.accountId),
          fromSettlementId: String(supporterSettlement._id),
        });
        expect(evictResponse.status).toBe(200);
        expect(evictResponse.body.status).toBe('returning');

        const evictMovementId = evictResponse.body.id as string;
        const evictMovement = await movementModel.findById(evictMovementId);
        expect(String(evictMovement?.ownerAccountId)).toBe(String(supporter.accountId));
        expect(String(evictMovement?.ownerAccountId)).not.toBe(String(host.accountId));

        const hostAfter = await settlementModel.findById(hostSettlement._id);
        expect(hostAfter?.stationedTroops).toEqual([]);

        const originAfter = await settlementModel.findById(supporterSettlement._id);
        expect(plainUnitEntries(originAfter?.awayTroops)).toEqual(troops);

        await forceReturn(evictMovementId);
        const originFinal = await settlementModel.findById(supporterSettlement._id);
        expect(plainUnitEntries(originFinal?.troops)).toEqual(troops);
      });

      it('recall by a non-owner of the origin is rejected; evict by a non-owner of the host is rejected; recalling a nonexistent contingent returns contingentNotFound', async () => {
        const supporter = await createGuestSession();
        const host = await createGuestSession();
        const stranger = await createGuestSession();
        const troops = [{ unitType: 'brute', count: 4 }];
        const supporterSettlement = await seedSettlementAt(supporter.accountId, 0, 0, { troops });
        const hostSettlement = await seedSettlementAt(host.accountId, 5, 0);
        const strangerSettlement = await seedSettlementAt(stranger.accountId, -5, 0);

        await sendAndArriveSupport(
          supporter.cookie,
          String(supporterSettlement._id),
          { x: 5, y: 0 },
          troops,
        );

        const strangerRecall = await postRecall(stranger.cookie, {
          hostSettlementId: String(hostSettlement._id),
          fromSettlementId: String(supporterSettlement._id),
        });
        expect(strangerRecall.status).toBe(404);
        expect(strangerRecall.body.error.key).toBe('errors.settlement.notFound');

        const strangerEvict = await postEvict(stranger.cookie, {
          hostSettlementId: String(hostSettlement._id),
          ownerAccountId: String(supporter.accountId),
          fromSettlementId: String(supporterSettlement._id),
        });
        expect(strangerEvict.status).toBe(404);
        expect(strangerEvict.body.error.key).toBe('errors.settlement.notFound');

        // The stranger owns a real settlement that never sent any support at all — a
        // well-formed, ownership-valid recall naming a contingent that simply isn't there.
        const neverSentRecall = await postRecall(stranger.cookie, {
          hostSettlementId: String(hostSettlement._id),
          fromSettlementId: String(strangerSettlement._id),
        });
        expect(neverSentRecall.status).toBe(404);
        expect(neverSentRecall.body.error.key).toBe('errors.movement.contingentNotFound');

        // Nothing about the real contingent moved as a side effect of any rejection above.
        const hostAfter = await settlementModel.findById(hostSettlement._id);
        expect(hostAfter?.stationedTroops).toHaveLength(1);
      });

      it('the playbook race: two concurrent recalls of the same contingent — exactly one succeeds, the contingent is removed once, no troop count goes negative', async () => {
        const supporter = await createGuestSession();
        const host = await createGuestSession();
        const troops = [{ unitType: 'brute', count: 5 }];
        const supporterSettlement = await seedSettlementAt(supporter.accountId, 0, 0, { troops });
        const hostSettlement = await seedSettlementAt(host.accountId, 5, 0);

        await sendAndArriveSupport(
          supporter.cookie,
          String(supporterSettlement._id),
          { x: 5, y: 0 },
          troops,
        );

        const recallBody = {
          hostSettlementId: String(hostSettlement._id),
          fromSettlementId: String(supporterSettlement._id),
        };
        const [responseA, responseB] = await Promise.all([
          postRecall(supporter.cookie, recallBody),
          postRecall(supporter.cookie, recallBody),
        ]);

        const statuses = [responseA.status, responseB.status].sort();
        expect(statuses).toEqual([200, 404]);
        const failure = responseA.status === 404 ? responseA : responseB;
        expect(failure.body.error.key).toBe('errors.movement.contingentNotFound');

        const hostAfter = await settlementModel.findById(hostSettlement._id);
        expect(hostAfter?.stationedTroops).toEqual([]);

        const originAfter = await settlementModel.findById(supporterSettlement._id);
        expect(plainUnitEntries(originAfter?.awayTroops)).toEqual(troops);

        const returningMovements = await movementModel.find({
          ownerAccountId: supporter.accountId,
          type: 'support',
          status: 'returning',
        });
        expect(returningMovements).toHaveLength(1);
      });

      // §18.3: `recallSupport` and `evictSupport` are mirror images acting on the very same
      // host/origin pair — recall settles origin-then-host, evict settles host-then-origin —
      // so a concurrent recall (by the contingent's owner) and evict (by the host) of the
      // SAME contingent is exactly the scenario the ascending-`_id` acquisition order in
      // `MovementsService.settleHostAndOrigin` exists to make safe. Before that fix this pair
      // could acquire the two documents in opposite orders; now both acquire them in the same
      // order, so the two commands simply race on the same version-guarded writes like any
      // other concurrent pair (`MovementsService.runCommand`'s bounded retry), never deadlock.
      it('the playbook race: a concurrent recall (by the owner) and evict (by the host) of the same contingent — exactly one succeeds, the other fails cleanly, the contingent is removed once, and the origin gains it back exactly once', async () => {
        const supporter = await createGuestSession();
        const host = await createGuestSession();
        const troops = [{ unitType: 'brute', count: 5 }];
        const supporterSettlement = await seedSettlementAt(supporter.accountId, 0, 0, { troops });
        const hostSettlement = await seedSettlementAt(host.accountId, 5, 0);

        await sendAndArriveSupport(
          supporter.cookie,
          String(supporterSettlement._id),
          { x: 5, y: 0 },
          troops,
        );

        const [recallOutcome, evictOutcome] = await Promise.allSettled([
          postRecall(supporter.cookie, {
            hostSettlementId: String(hostSettlement._id),
            fromSettlementId: String(supporterSettlement._id),
          }),
          postEvict(host.cookie, {
            hostSettlementId: String(hostSettlement._id),
            ownerAccountId: String(supporter.accountId),
            fromSettlementId: String(supporterSettlement._id),
          }),
        ]);

        // Real HTTP calls via supertest fulfil even on a 4xx/5xx response — a rejection here
        // would mean the request itself blew up, not a clean command-level failure.
        expect(recallOutcome.status).toBe('fulfilled');
        expect(evictOutcome.status).toBe('fulfilled');
        if (recallOutcome.status !== 'fulfilled' || evictOutcome.status !== 'fulfilled') {
          throw new Error('unreachable: both promises asserted fulfilled above');
        }
        const [recallResponse, evictResponse] = [recallOutcome.value, evictOutcome.value];

        const statuses = [recallResponse.status, evictResponse.status].sort();
        expect(statuses).toEqual([200, 404]);
        const failure = recallResponse.status === 404 ? recallResponse : evictResponse;
        expect(failure.body.error.key).toBe('errors.movement.contingentNotFound');

        // Removed from the host exactly once — not left behind, not double-removed into some
        // negative/duplicate state.
        const hostAfter = await settlementModel.findById(hostSettlement._id);
        expect(hostAfter?.stationedTroops).toEqual([]);

        // Credited back to the origin exactly once — no doubling from the loser's retry, no
        // partial/negative count from the two commands stepping on each other.
        const originAfter = await settlementModel.findById(supporterSettlement._id);
        expect(plainUnitEntries(originAfter?.awayTroops)).toEqual(troops);
        expect(plainUnitEntries(originAfter?.troops)).toEqual([]);

        // Exactly one returning movement — the winner's — ever got created.
        const returningMovements = await movementModel.find({
          ownerAccountId: supporter.accountId,
          type: 'support',
          status: 'returning',
        });
        expect(returningMovements).toHaveLength(1);
      });
    });

    describe('starvation interaction', () => {
      it('a host whose net Food is barely positive gets a support contingent and ends up with a pending starvation tick', async () => {
        const supporter = await createGuestSession();
        const host = await createGuestSession();

        const hostBuildings = [
          { type: 'commandCenter', level: 1 },
          { type: 'greenhouseFarm', level: farmLevelCovering(0.01) },
        ];
        const headroom = calcNetFoodPerHour(config, hostBuildings as BuildingLevels, []);
        expect(headroom).toBeGreaterThanOrEqual(0);

        const perUnitUpkeep = calcTroopFoodUpkeepPerHour(config, [{ unitType: 'brute', count: 1 }]);
        // Enough brutes that their upkeep alone certainly exceeds the host's positive
        // headroom — derived from the headroom itself, never a hardcoded troop count.
        const contingentCount = Math.ceil(headroom / perUnitUpkeep) + 1;
        const contingentTroops = [{ unitType: 'brute', count: contingentCount }];

        const supporterSettlement = await seedSettlementAt(supporter.accountId, 0, 0, {
          troops: contingentTroops,
        });
        const hostSettlement = await seedSettlementAt(host.accountId, 5, 0, {
          buildings: hostBuildings,
        });

        const hostBefore = await settlementModel.findById(hostSettlement._id);
        expect(hostBefore?.pendingStarvationEventId).toBeNull();

        await sendAndArriveSupport(
          supporter.cookie,
          String(supporterSettlement._id),
          { x: 5, y: 0 },
          contingentTroops,
        );

        const hostAfter = await settlementModel.findById(hostSettlement._id);
        expect(hostAfter?.pendingStarvationEventId).not.toBeNull();
        expect(hostAfter?.pendingStarvationDueAt).not.toBeNull();

        const starvationEvent = await eventModel.findOne({
          type: 'starvationTick',
          'payload.settlementId': String(hostSettlement._id),
        });
        expect(starvationEvent).not.toBeNull();
        expect(hostAfter?.pendingStarvationEventId?.equals(starvationEvent?._id ?? '')).toBe(true);
      });

      it('symmetric case: recalling a contingent can tip the origin’s net Food negative and arms a pending tick there', async () => {
        const supporter = await createGuestSession();
        const host = await createGuestSession();

        const originBuildings = [
          { type: 'commandCenter', level: 1 },
          { type: 'greenhouseFarm', level: farmLevelCovering(0.01) },
        ];
        const headroom = calcNetFoodPerHour(config, originBuildings as BuildingLevels, []);
        expect(headroom).toBeGreaterThanOrEqual(0);

        const perUnitUpkeep = calcTroopFoodUpkeepPerHour(config, [{ unitType: 'brute', count: 1 }]);
        const contingentCount = Math.ceil(headroom / perUnitUpkeep) + 1;
        const contingentTroops = [{ unitType: 'brute', count: contingentCount }];

        const supporterSettlement = await seedSettlementAt(supporter.accountId, 0, 0, {
          buildings: originBuildings,
          troops: contingentTroops,
        });
        const hostSettlement = await seedSettlementAt(host.accountId, 5, 0);

        await sendAndArriveSupport(
          supporter.cookie,
          String(supporterSettlement._id),
          { x: 5, y: 0 },
          contingentTroops,
        );

        // `SupportArrivalResolver` deliberately does NOT call `ensureStarvationSchedule` on
        // the origin (its own comment: upkeep there only ever falls, so a stale tick armed
        // while the army was still home/away can only become unnecessary, never miss a
        // deficit) — so a tick armed by the earlier `sendMovement` settle (when the whole
        // army still counted against this settlement) can still be sitting here, unreconciled
        // by a raw read. A real settle — any ordinary account command, `GET
        // /api/settlements/:id` here — is what actually reconciles it, exactly as a player
        // checking their base after their support landed would trigger.
        const reconcile = await getSettlement(supporter.cookie, String(supporterSettlement._id));
        expect(reconcile.status).toBe(200);

        // Support arriving emptied the origin's `awayTroops` back to nothing, so the origin
        // is back at its own bare-headroom baseline — no pending tick once reconciled.
        const originBeforeRecall = await settlementModel.findById(supporterSettlement._id);
        expect(originBeforeRecall?.pendingStarvationEventId).toBeNull();

        const recallResponse = await postRecall(supporter.cookie, {
          hostSettlementId: String(hostSettlement._id),
          fromSettlementId: String(supporterSettlement._id),
        });
        expect(recallResponse.status).toBe(200);

        const originAfterRecall = await settlementModel.findById(supporterSettlement._id);
        expect(originAfterRecall?.pendingStarvationEventId).not.toBeNull();

        const starvationEvent = await eventModel.findOne({
          type: 'starvationTick',
          'payload.settlementId': String(supporterSettlement._id),
        });
        expect(starvationEvent).not.toBeNull();
      });
    });
  });

  // M3c.7a: oases become targetable, and scouting one works end to end
  // (`docs/M3_DESIGN_DECISIONS.md` §9/§10). Oasis raid/assault (§10's "a normal battle with
  // wallLevel = 0 and no siege pass") is M3c.7b's own step — this suite only proves the
  // plumbing (target resolution, the settle seam, arrival dispatch) and the one movement type
  // that fully resolves this step: `scout`.
  //
  // Every oasis this describe block seeds (`seedOasisAt`, above) sits at `x = 29`, safely
  // outside `config.map.oases.edgeMargin` of the grid edge (`|x| > config.map.radius -
  // config.map.oases.edgeMargin`, i.e. > 28 at the default config) — `generateOases` never
  // places a real oasis there (see `seedOasisAt`'s own comment), so these hand-picked
  // coordinates can never collide with one of the 24 real oases `WorldService.bootstrap`
  // already placed for this suite's shared world. A fixed arbitrary epoch (`FIXED_NOW`, not
  // `Date.now()`) drives every direct `OasisService` call below so those assertions never
  // depend on when the test happens to run.
  describe('M3c.7a: oases become targetable, scouting one works end to end', () => {
    const FIXED_NOW = 1_700_000_000_000;

    // Runs one `OasisService.settleOasisDocUnchecked` call inside its own transaction —
    // mirrors this file's existing convention for exercising a handler/service method
    // directly rather than through the HTTP API (see `movementArriveHandler.handle(...)`
    // above, `docs/CONCURRENCY_PLAYBOOK.md` §6's "call the handler directly" pattern).
    // Returns `true` iff the call threw (used by the version-guard race test below).
    async function settleOasisDirectly(oasisId: string, now: number): Promise<boolean> {
      const session = await connection.startSession();
      try {
        await session.withTransaction(async () => {
          await oasisService.settleOasisDocUnchecked(oasisId, now, session);
        });
        return false;
      } catch {
        return true;
      } finally {
        await session.endSession();
      }
    }

    it('sending a scout at an oasis tile succeeds and persists toOasisId with toSettlementId unset', async () => {
      const attacker = await createGuestSession();
      const attackerSettlement = await seedSettlementAt(attacker.accountId, 29, 0, {
        troops: [{ unitType: 'lookout', count: 2 }],
      });
      const oasis = await seedOasisAt(29, 1);

      const response = await postSend(attacker.cookie, {
        type: 'scout',
        fromSettlementId: String(attackerSettlement._id),
        target: { x: 29, y: 1 },
        units: [{ unitType: 'lookout', count: 2 }],
      });
      expect(response.status).toBe(201);
      expect(response.body.toOasisId).toBe(String(oasis._id));
      expect(response.body.toSettlementId).toBeUndefined();

      const movement = await movementModel.findById(response.body.id as string);
      expect(String(movement?.toOasisId)).toBe(String(oasis._id));
      expect(movement?.toSettlementId).toBeUndefined();
    });

    it('the scout arrives at an oasis: one scout report with the settled defenders/food, army returns home intact', async () => {
      const attacker = await createGuestSession();
      const troops = [{ unitType: 'lookout', count: 3 }];
      const attackerSettlement = await seedSettlementAt(attacker.accountId, 29, 2, { troops });
      const oasis = await seedOasisAt(29, 3);

      const sendResponse = await postSend(attacker.cookie, {
        type: 'scout',
        fromSettlementId: String(attackerSettlement._id),
        target: { x: 29, y: 3 },
        units: troops,
      });
      expect(sendResponse.status).toBe(201);
      const movementId = sendResponse.body.id as string;

      await forceArrive(movementId);

      const arriveEvent = await eventModel.findOne({
        type: 'movementArrive',
        'payload.movementId': movementId,
      });
      expect(arriveEvent?.status).toBe('done');

      // Hand-computed via the real `game-core` formula (never a hardcoded number, per this
      // repo's "derive, don't hardcode" convention — see `resolveScoutCombat`'s use above for
      // the same discipline applied to settlement scouting): a freshly seeded oasis has never
      // been settled (`lastRegenAt: null`), so this is exactly the first-contact
      // materialisation §10 documents.
      const world = await worldService.getWorld();
      const neverSettled: OasisLiveState = {
        defenders: [],
        food: 0,
        lastRegenAt: null,
        lastDefenderRegenAt: null,
      };
      const expected = settleOasis(config, world.seed, 29, 3, neverSettled, arriveEvent!.dueAt);

      const reports = await reportModel.find({ accountId: attacker.accountId });
      expect(reports).toHaveLength(1);
      expect(reports[0]?.type).toBe('scout');
      const payload = reports[0]?.payload as {
        movementId: string;
        fromSettlementId: string;
        toOasisId: string;
        target: { x: number; y: number };
        defenders: Array<{ unitType: string; count: number }>;
        food: number;
        targetKind: string;
      };
      expect(payload.movementId).toBe(movementId);
      expect(payload.fromSettlementId).toBe(String(attackerSettlement._id));
      expect(payload.toOasisId).toBe(String(oasis._id));
      expect(payload.target).toEqual({ x: 29, y: 3 });
      expect(payload.defenders).toEqual(expected.defenders);
      expect(payload.food).toBe(expected.food);
      expect(payload.targetKind).toBe('oasis');

      // No scout-vs-scout combat, no detection, no counter-report (§10) — the whole force
      // always survives and the movement always turns around.
      const movementAfterArrive = await movementModel.findById(movementId);
      expect(movementAfterArrive?.status).toBe('returning');
      expect(plainUnitEntries(movementAfterArrive?.survivors)).toEqual(troops);

      const oasisAfter = await oasisModel.findById(oasis._id);
      expect(plainUnitEntries(oasisAfter?.defenders)).toEqual(expected.defenders);
      expect(oasisAfter?.loot.food).toBe(expected.food);
      expect(oasisAfter?.version).toBe(1);

      await forceReturn(movementId);

      const movementAfterReturn = await movementModel.findById(movementId);
      expect(movementAfterReturn?.status).toBe('done');

      const originAfterReturn = await settlementModel.findById(attackerSettlement._id);
      expect(plainUnitEntries(originAfterReturn?.troops)).toEqual(troops);
      expect(plainUnitEntries(originAfterReturn?.awayTroops)).toEqual([]);
    });

    it('OasisService.settleOasisDocUnchecked materialises an oasis on first contact: exactly oasisTargetDefenders(seed, x, y), food 0, both timestamps stamped to now', async () => {
      const oasis = await seedOasisAt(29, 4);
      const world = await worldService.getWorld();

      const threw = await settleOasisDirectly(String(oasis._id), FIXED_NOW);
      expect(threw).toBe(false);

      const after = await oasisModel.findById(oasis._id);
      const expectedDefenders = oasisTargetDefenders(config, world.seed, 29, 4);
      expect(plainUnitEntries(after?.defenders)).toEqual(expectedDefenders);
      expect(after?.loot.food).toBe(0);
      expect(after?.lastRegenAt).toBe(FIXED_NOW);
      expect(after?.lastDefenderRegenAt).toBe(FIXED_NOW);
      expect(after?.version).toBe(1);
    });

    it('regeneration accrues between two settles: whole defender intervals credited, remainder preserved, matching settleOasis (game-core) directly', async () => {
      const startingDefenders: TroopCounts = [{ unitType: 'feralDog', count: 1 }];
      const oasis = await seedOasisAt(29, 5, {
        defenders: startingDefenders,
        food: 500,
        lastRegenAt: FIXED_NOW,
        lastDefenderRegenAt: FIXED_NOW,
      });
      const world = await worldService.getWorld();
      const interval = config.oasis.regen.defenderIntervalMs;
      // Two settles, 1.5 then a further 0.7 intervals apart (2.2 total from `FIXED_NOW`) —
      // deliberately not whole numbers, so the second settle's remainder-preserving math
      // (`lastDefenderRegenAt` banking the sub-interval leftover from the first settle) is
      // actually exercised, not just the trivial single-settle case.
      const t1 = FIXED_NOW + interval * 1.5;
      const t2 = t1 + interval * 0.7;

      expect(await settleOasisDirectly(String(oasis._id), t1)).toBe(false);
      expect(await settleOasisDirectly(String(oasis._id), t2)).toBe(false);

      const twoStep = await oasisModel.findById(oasis._id);

      // The identity `settleOasis`'s own comment documents:
      // `settleOasis(settleOasis(s, t1), t2)` equals `settleOasis(s, t2)` on the defender
      // count — computed here in one shot, directly from `game-core`, and compared against
      // what `OasisService` produced via two separate settles through the real seam.
      const expected = settleOasis(
        config,
        world.seed,
        29,
        5,
        {
          defenders: startingDefenders,
          food: 500,
          lastRegenAt: FIXED_NOW,
          lastDefenderRegenAt: FIXED_NOW,
        },
        t2,
      );

      expect(plainUnitEntries(twoStep?.defenders)).toEqual(expected.defenders);
      expect(twoStep?.loot.food).toBeCloseTo(expected.food, 6);
      expect(twoStep?.lastRegenAt).toBe(t2);
      expect(twoStep?.lastDefenderRegenAt).toBe(expected.lastDefenderRegenAt);

      // The "whole intervals only" half, spelled out explicitly rather than only via the
      // identity above: floor(2.2) = 2 whole intervals credited on top of a starting count of
      // 1, clamped at this oasis's own deterministic target either way.
      const dogTarget =
        oasisTargetDefenders(config, world.seed, 29, 5).find((d) => d.unitType === 'feralDog')
          ?.count ?? 0;
      const expectedDogCount = Math.min(dogTarget, 1 + 2);
      expect(twoStep?.defenders.find((d) => d.unitType === 'feralDog')?.count).toBe(
        expectedDogCount,
      );
    });

    it('OasisService.settleOasisDocUnchecked is a no-op (no version bump) when now does not advance past lastRegenAt', async () => {
      const oasis = await seedOasisAt(29, 15);

      expect(await settleOasisDirectly(String(oasis._id), FIXED_NOW)).toBe(false);
      const afterFirst = await oasisModel.findById(oasis._id);
      expect(afterFirst?.version).toBe(1);

      // Same instant again: `elapsedMs <= 0` at `OasisService`'s own gate — must skip the
      // write entirely, exactly like `SettlementsService.settleDoc`'s identical short-circuit.
      expect(await settleOasisDirectly(String(oasis._id), FIXED_NOW)).toBe(false);
      const afterSecond = await oasisModel.findById(oasis._id);
      expect(afterSecond?.version).toBe(1);
    });

    // Proves the version guard holds under real, concurrent contention rather than just in
    // sequence. This does NOT assert "one call throws `VersionConflictError`" — under a real
    // MongoDB transaction, a genuine write collision between the two surfaces to the driver
    // as a `TransientTransactionError`, which `session.withTransaction` retries
    // *transparently*, re-running the loser's whole callback against fresh state (this is
    // `docs/CONCURRENCY_PLAYBOOK.md` §1's own documented distinction between that
    // storage-engine-level retry and this service's own logical version guard). By the time
    // the retried call re-reads the oasis, the first call has already committed the
    // materialisation (`version` 0 -> 1, `lastRegenAt: FIXED_NOW`) — so the retry lands
    // exactly on `OasisService`'s own no-op skip (`now <= lastRegenAt`) and returns without
    // writing anything at all. Net effect: both calls complete without either one ever
    // throwing, and the version guard's real job — preventing a *double* materialisation —
    // is proven by the final version staying at exactly 1, not 2.
    it('OasisService.settleOasisDocUnchecked: two concurrent settles at the same instant never double-write (version stays 1, neither call throws)', async () => {
      const oasis = await seedOasisAt(29, 16);
      const world = await worldService.getWorld();

      const [threwA, threwB] = await Promise.all([
        settleOasisDirectly(String(oasis._id), FIXED_NOW),
        settleOasisDirectly(String(oasis._id), FIXED_NOW),
      ]);
      expect(threwA).toBe(false);
      expect(threwB).toBe(false);

      const after = await oasisModel.findById(oasis._id);
      expect(after?.version).toBe(1);
      expect(plainUnitEntries(after?.defenders)).toEqual(
        oasisTargetDefenders(config, world.seed, 29, 16),
      );
      expect(after?.loot.food).toBe(0);
      expect(after?.lastRegenAt).toBe(FIXED_NOW);
      expect(after?.lastDefenderRegenAt).toBe(FIXED_NOW);
    });

    it('a support sent at an oasis is rejected with errors.movement.supportNotToOasis', async () => {
      const attacker = await createGuestSession();
      const troops = [{ unitType: 'brute', count: 2 }];
      const attackerSettlement = await seedSettlementAt(attacker.accountId, 29, 6, { troops });
      await seedOasisAt(29, 7);

      const response = await postSend(attacker.cookie, {
        type: 'support',
        fromSettlementId: String(attackerSettlement._id),
        target: { x: 29, y: 7 },
        units: troops,
      });
      expect(response.status).toBe(400);
      expect(response.body.error.key).toBe('errors.movement.supportNotToOasis');
      expect(await movementModel.countDocuments({})).toBe(0);
    });

    it('§11 asymmetry: raiding an oasis keeps a protected account’s own protection; raiding a real settlement lifts it', async () => {
      const attacker = await createGuestSession();
      const defender = await createGuestSession();
      const attackerSettlement = await seedSettlementAt(attacker.accountId, 29, 8, {
        troops: [{ unitType: 'brute', count: 5 }],
      });
      await seedSettlementAt(defender.accountId, 29, 9);
      await seedOasisAt(29, 10);
      const originalProtectedUntil = Date.now() + 999_999;
      await accountModel.updateOne(
        { _id: attacker.accountId },
        { $set: { protectedUntil: originalProtectedUntil } },
      );

      // The oasis raid: send-time succeeds, and — the asymmetry §11 is explicit about —
      // leaves the caller's own protection completely untouched. Arrival is NOT forced here:
      // an oasis raid has no arrival resolver until M3c.7b (see the dedicated dead-letter
      // test below), so this test asserts purely on the send-time effect, per the brief.
      const oasisRaid = await postSend(attacker.cookie, {
        type: 'raid',
        fromSettlementId: String(attackerSettlement._id),
        target: { x: 29, y: 10 },
        units: [{ unitType: 'brute', count: 1 }],
      });
      expect(oasisRaid.status).toBe(201);
      expect((await accountModel.findById(attacker.accountId))?.protectedUntil).toBe(
        originalProtectedUntil,
      );

      // The same account raiding a REAL settlement still lifts it exactly as M3c.3 already
      // proved — re-asserted here as the other half of the asymmetry, on the same account,
      // in the same test.
      const settlementRaid = await postSend(attacker.cookie, {
        type: 'raid',
        fromSettlementId: String(attackerSettlement._id),
        target: { x: 29, y: 9 },
        units: [{ unitType: 'brute', count: 1 }],
      });
      expect(settlementRaid.status).toBe(201);
      const updatedAttacker = await accountModel.findById(attacker.accountId);
      expect(updatedAttacker?.protectedUntil).toBeLessThan(originalProtectedUntil);
    });

    // M3c.7a shipped a test here — 'an oasis raid arrival fails loudly and stays recoverable
    // (no oasis arrival resolver until M3c.7b)' — asserting that an oasis raid's arrival
    // dead-lettered behind the temporary guard in `MovementArriveHandler.handleOasisTarget`.
    // M3c.7b removes that guard's reachability for `raid`/`assault` by shipping
    // `OasisBattleArrivalResolver`, which is exactly the fix that test existed to demand —
    // asserting "this still fails" would now assert the opposite of this step's own acceptance
    // criterion, so it is removed rather than kept red or hand-edited to assert success (its
    // replacement, an oasis raid actually resolving, is this file's own "M3c.7b" suite below).

    it('a movement targeting a tile with neither settlement nor oasis is still rejected with errors.movement.targetNotSettlement', async () => {
      const attacker = await createGuestSession();
      const attackerSettlement = await seedSettlementAt(attacker.accountId, 29, 13, {
        troops: [{ unitType: 'lookout', count: 1 }],
      });

      const response = await postSend(attacker.cookie, {
        type: 'scout',
        fromSettlementId: String(attackerSettlement._id),
        target: { x: 29, y: 14 },
        units: [{ unitType: 'lookout', count: 1 }],
      });
      expect(response.status).toBe(400);
      expect(response.body.error.key).toBe('errors.movement.targetNotSettlement');
    });
  });

  // M3c.7b: raiding and assaulting an oasis, end to end (`docs/M3_DESIGN_DECISIONS.md` §10) —
  // what `OasisBattleArrivalResolver` adds on top of M3c.7a's plumbing (oases became
  // targetable, scouting one already worked) and M3c.4/M3c.5a's settlement battle/loot step
  // (whose `sendAndArriveBattle` convention this suite's own `sendAndArriveOasisBattle`
  // mirrors). Every numeric expectation is derived from `resolveBattle`/`resolveLoot`/
  // `settleOasis`/`oasisTargetDefenders` (the real `game-core` formulas) at assertion time,
  // never hardcoded — the same discipline every other suite in this file follows.
  //
  // Oasis coordinates in this describe block continue the file-wide `seedOasisAt` convention:
  // `x = 29` (edge-safe, `generateOases` never places a real oasis there) with a `y` never
  // reused by an earlier `seedOasisAt` call in this file (the M3c.7a suite above used
  // 1/3/4/5/7/10/15/16) — `oasisModel` is deliberately never cleared in `afterEach` (only
  // `Settlement`/`Movement`/`Report`/`GameEvent` are), so a repeated `(x, y)` pair would trip
  // the schema's own unique index instead of silently reusing a fixture.
  describe('M3c.7b: raiding and assaulting an oasis', () => {
    // Same Mongoose-subdocument hazard `plainUnitEntries` guards against, applied to a
    // settlement's stored resources — mirrors the M3c.5a/M3c.5b suites' own identically-named
    // local copy (a sibling `describe`, not in scope here).
    function plainStoredResources(doc: SettlementDocument): Resources {
      return {
        scrap: doc.resources.values.scrap,
        fuel: doc.resources.values.fuel,
        electronics: doc.resources.values.electronics,
        food: doc.resources.values.food,
      };
    }

    // Seeds an attacker settlement (always at `(0, 0)` — `Settlement` fixtures are cleared
    // every test, so unlike oasis coordinates this one is freely reusable, exactly as the
    // M3c.4/M3c.5a/M3c.5b suites above already do) and a target oasis, sends `type` (`raid` by
    // default) at it, force-arrives it, and returns the *exact* pre-battle settled oasis state
    // (`preBattle`) plus the hand-computed `resolveBattle` result every test below derives its
    // own expectation from.
    //
    // `oasisDefenders === undefined` seeds nothing but coordinates (`seedOasisAt`'s own
    // default), i.e. "never settled since world generation" — the resolver's shared preamble
    // then materialises the oasis at its full target composition on first contact (§10, M3c.7a),
    // exactly like a real player's first raid on a virgin oasis. Passing `oasisDefenders`
    // instead seeds a fixed, caller-chosen garrison (and `lastRegenAt`/`lastDefenderRegenAt`
    // stamped to the seeding instant), for tests that need a *known* pre-battle roster rather
    // than whatever `oasisTargetDefenders(seed, x, y)` happens to roll.
    //
    // Either way, `preBattle` is reconstructed by calling `settleOasis` (game-core) directly
    // against the exact state this helper seeded and the *real* `movementArrive` event's
    // `dueAt` — never assumed to equal the raw seeded input — because real wall-clock time
    // elapses between seeding and `forceArrive`'s settle, and while that gap is always far too
    // short to cross a whole `defenderIntervalMs` (so defender growth is always provably zero),
    // asserting via the same formula the resolver itself calls is exact rather than "close
    // enough", matching the M3c.5a loot suite's own `reconstructSettledDefenderResources`
    // convention for the settlement side.
    async function sendAndArriveOasisBattle(options: {
      type?: 'raid' | 'assault';
      attackerTroops: Array<{ unitType: string; count: number }>;
      attackerResources?: Resources;
      attackerBuildings?: Array<{ type: string; level: number }>;
      oasisX: number;
      oasisY: number;
      oasisDefenders?: Array<{ unitType: string; count: number }>;
      oasisFood?: number;
      siegeTarget?: string;
    }): Promise<{
      attacker: GuestSession;
      attackerSettlement: SettlementDocument;
      oasis: OasisDocument;
      movementId: string;
      preBattle: OasisLiveState;
      expected: ReturnType<typeof resolveBattle>;
    }> {
      const type = options.type ?? 'raid';
      const attacker = await createGuestSession();
      const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
        troops: options.attackerTroops,
        buildings: options.attackerBuildings,
        resources: options.attackerResources,
      });

      const neverSettled = options.oasisDefenders === undefined;
      const seedTime = Date.now();
      const oasis = await seedOasisAt(
        options.oasisX,
        options.oasisY,
        neverSettled
          ? {}
          : {
              defenders: options.oasisDefenders,
              food: options.oasisFood ?? 0,
              lastRegenAt: seedTime,
              lastDefenderRegenAt: seedTime,
            },
      );

      const sendResponse = await postSend(attacker.cookie, {
        type,
        fromSettlementId: String(attackerSettlement._id),
        target: { x: options.oasisX, y: options.oasisY },
        units: options.attackerTroops,
        ...(options.siegeTarget !== undefined ? { siegeTarget: options.siegeTarget } : {}),
      });
      expect(sendResponse.status).toBe(201);
      const movementId = sendResponse.body.id as string;

      await forceArrive(movementId);

      const arriveEvent = await eventModel.findOne({
        type: 'movementArrive',
        'payload.movementId': movementId,
      });
      expect(arriveEvent?.status).toBe('done');
      if (!arriveEvent) throw new Error('unreachable');

      const world = await worldService.getWorld();
      const seededState: OasisLiveState = neverSettled
        ? { defenders: [], food: 0, lastRegenAt: null, lastDefenderRegenAt: null }
        : {
            defenders: (options.oasisDefenders ?? []) as TroopCounts,
            food: options.oasisFood ?? 0,
            lastRegenAt: seedTime,
            lastDefenderRegenAt: seedTime,
          };
      const preBattle = settleOasis(
        config,
        world.seed,
        options.oasisX,
        options.oasisY,
        seededState,
        arriveEvent.dueAt,
      );

      const expected = resolveBattle(config, {
        attacker: options.attackerTroops as TroopCounts,
        defenders: [{ key: 'oasis', troops: preBattle.defenders }],
        wallLevel: 0,
        kind: type,
        roll: battleRoll(world.seed, movementId),
      });

      return { attacker, attackerSettlement, oasis, movementId, preBattle, expected };
    }

    it('a hand-checked oasis raid: persisted oasis defenders, the attacker’s awayTroops, and the oasisRaid report all match resolveBattle/resolveLoot computed independently', async () => {
      const attackerTroops = [{ unitType: 'brute', count: 10 }];
      const oasisDefenders = [{ unitType: 'feralDog', count: 4 }];

      const { attacker, attackerSettlement, oasis, movementId, preBattle, expected } =
        await sendAndArriveOasisBattle({
          attackerTroops,
          oasisX: 29,
          oasisY: 17,
          oasisDefenders,
          oasisFood: 0,
        });

      const oasisOutcome = expected.defenders.find((d) => d.key === 'oasis');
      if (!oasisOutcome) throw new Error('unreachable');

      const oasisAfter = await oasisModel.findById(oasis._id);
      expect(plainUnitEntries(oasisAfter?.defenders)).toEqual(
        oasisOutcome.survivors.filter((t) => t.count > 0),
      );

      const { result: expectedAwayTroops } = subtractUnitCounts(
        attackerTroops,
        expected.attacker.losses.filter((l) => l.count > 0),
      );
      const originAfter = await settlementModel.findById(attackerSettlement._id);
      expect(plainUnitEntries(originAfter?.awayTroops)).toEqual(expectedAwayTroops);

      const movement = await movementModel.findById(movementId);
      expect(plainUnitEntries(movement?.survivors)).toEqual(expected.attacker.survivors);

      expect(await reportModel.countDocuments({})).toBe(1);
      const report = await reportModel.findOne({ accountId: attacker.accountId });
      expect(report?.type).toBe('oasisRaid');
      const payload = report?.payload as Record<string, unknown>;
      expect(payload['movementId']).toBe(movementId);
      expect(payload['fromSettlementId']).toBe(String(attackerSettlement._id));
      expect(payload['toOasisId']).toBe(String(oasis._id));
      expect(payload['target']).toEqual({ x: 29, y: 17 });
      expect(payload['kind']).toBe('raid');
      expect(payload['attacker']).toEqual({
        sent: attackerTroops,
        losses: expected.attacker.losses,
        survivors: expected.attacker.survivors,
      });
      expect(payload['defendersMet']).toEqual(preBattle.defenders);
      expect(payload['defenderLosses']).toEqual(oasisOutcome.losses);
      expect(payload['atkPts']).toBe(expected.atkPts);
      expect(payload['defPts']).toBe(expected.defPts);
      expect(payload['x']).toBe(expected.x);
      expect(payload['attackerLossFraction']).toBe(expected.attackerLossFraction);
      expect(payload['defenderLossFraction']).toBe(expected.defenderLossFraction);
      expect(payload['defenderWallLevel']).toBe(0);
      expect(payload['attackerPrevailed']).toBe(expected.attackerPrevailed);
      expect(payload['foodTaken']).toBe(0);
    });

    it('the loot round trip: Food taken comes off the oasis pool at arrival, rides on movement.loot, and is credited to the raider’s settlement on return with lootDelivered', async () => {
      const attackerTroops = [{ unitType: 'brute', count: 100 }];
      const attackerResources: Resources = { scrap: 500, fuel: 500, electronics: 500, food: 500 };
      const attackerBuildings = [{ type: 'commandCenter', level: 1 }];
      const oasisDefenders = [{ unitType: 'feralDog', count: 2 }];
      const oasisFood = 2000;

      const { attacker, attackerSettlement, oasis, movementId, preBattle, expected } =
        await sendAndArriveOasisBattle({
          attackerTroops,
          attackerResources,
          attackerBuildings,
          oasisX: 29,
          oasisY: 18,
          oasisDefenders,
          oasisFood,
        });
      expect(expected.attackerPrevailed).toBe(true);

      const lootStored: Resources = { scrap: 0, fuel: 0, electronics: 0, food: preBattle.food };
      const expectedLoot = resolveLoot(config, expected, {
        stored: lootStored,
        hiddenCacheLevel: 0,
      });
      expect(expectedLoot.capacityBound).toBe(false);
      expect(expectedLoot.totalTaken).toBeGreaterThan(0);

      const oasisAfterArrive = await oasisModel.findById(oasis._id);
      expect(oasisAfterArrive?.loot.food).toBeCloseTo(
        subtractResources(lootStored, expectedLoot.taken).food,
        9,
      );

      const movementAfterArrive = await movementModel.findById(movementId);
      expect(movementAfterArrive?.loot).toBeDefined();
      const movementLoot: Resources = {
        scrap: movementAfterArrive?.loot?.scrap ?? 0,
        fuel: movementAfterArrive?.loot?.fuel ?? 0,
        electronics: movementAfterArrive?.loot?.electronics ?? 0,
        food: movementAfterArrive?.loot?.food ?? 0,
      };
      expect(movementLoot).toEqual(expectedLoot.taken);

      await forceReturn(movementId);

      const attackerAfterReturn = await settlementModel.findById(attackerSettlement._id);
      if (!attackerAfterReturn) throw new Error('unreachable');
      expectResourcesCloseTo(
        plainStoredResources(attackerAfterReturn),
        addResources(attackerResources, movementLoot),
        attackerBuildings as BuildingLevels,
        expected.attacker.survivors,
      );

      const report = await reportModel.findOne({
        accountId: attacker.accountId,
        type: 'oasisRaid',
      });
      const payload = report?.payload as { lootDelivered: Resources; lootLost: Resources };
      for (const kind of RESOURCE_KINDS) {
        expect(payload.lootDelivered[kind]).toBeCloseTo(movementLoot[kind], 6);
        expect(payload.lootLost[kind]).toBeCloseTo(0, 6);
      }
    });

    it('loot is Food only: the raider’s scrap/fuel/electronics are unaffected by the raid, and the oasis pool never goes negative even when capacity-bound', async () => {
      const attackerTroops = [{ unitType: 'brute', count: 1 }]; // carry 60 — tiny next to the pool below
      const attackerResources: Resources = {
        scrap: 1000,
        fuel: 1000,
        electronics: 1000,
        food: 1000,
      };
      const attackerBuildings = [{ type: 'commandCenter', level: 1 }];
      const oasisDefenders: Array<{ unitType: string; count: number }> = []; // undefended: isolates the loot assertion from any combat-loss noise
      const oasisFood = 50_000; // far beyond one Brute's carry capacity -> capacity-bound

      const { attacker, attackerSettlement, oasis, movementId, preBattle, expected } =
        await sendAndArriveOasisBattle({
          attackerTroops,
          attackerResources,
          attackerBuildings,
          oasisX: 29,
          oasisY: 19,
          oasisDefenders,
          oasisFood,
        });
      expect(expected.attackerPrevailed).toBe(true);
      expect(expected.attacker.survivors).toEqual(attackerTroops); // undefended: no losses at all

      const lootStored: Resources = { scrap: 0, fuel: 0, electronics: 0, food: preBattle.food };
      const expectedLoot = resolveLoot(config, expected, {
        stored: lootStored,
        hiddenCacheLevel: 0,
      });
      expect(expectedLoot.capacityBound).toBe(true);
      expect(expectedLoot.taken.scrap).toBe(0);
      expect(expectedLoot.taken.fuel).toBe(0);
      expect(expectedLoot.taken.electronics).toBe(0);
      expect(expectedLoot.taken.food).toBeGreaterThan(0);

      const oasisAfterArrive = await oasisModel.findById(oasis._id);
      // Never negative — the whole point of this assertion — and matches the exact
      // `subtractResources` composition the resolver itself uses, not "close to zero".
      expect(oasisAfterArrive?.loot.food).toBeGreaterThanOrEqual(0);
      expect(oasisAfterArrive?.loot.food).toBeCloseTo(preBattle.food - expectedLoot.taken.food, 6);

      const movementAfterArrive = await movementModel.findById(movementId);
      expect(movementAfterArrive?.loot?.scrap).toBe(0);
      expect(movementAfterArrive?.loot?.fuel).toBe(0);
      expect(movementAfterArrive?.loot?.electronics).toBe(0);
      expect(movementAfterArrive?.loot?.food).toBeCloseTo(expectedLoot.taken.food, 9);

      await forceReturn(movementId);

      const attackerAfterReturn = await settlementModel.findById(attackerSettlement._id);
      if (!attackerAfterReturn) throw new Error('unreachable');
      // Nothing but production/upkeep drift touches scrap/fuel/electronics — a bare
      // commandCenter-only settlement produces/consumes none of the three, so these are exact.
      expect(attackerAfterReturn.resources.values.scrap).toBeCloseTo(attackerResources.scrap, 6);
      expect(attackerAfterReturn.resources.values.fuel).toBeCloseTo(attackerResources.fuel, 6);
      expect(attackerAfterReturn.resources.values.electronics).toBeCloseTo(
        attackerResources.electronics,
        6,
      );
      expect(attackerAfterReturn.resources.values.food).toBeGreaterThan(attackerResources.food);

      const report = await reportModel.findOne({ accountId: attacker.accountId });
      const payload = report?.payload as { lootDelivered: Resources };
      expect(payload.lootDelivered.scrap).toBe(0);
      expect(payload.lootDelivered.fuel).toBe(0);
      expect(payload.lootDelivered.electronics).toBe(0);
      expect(payload.lootDelivered.food).toBeCloseTo(expectedLoot.taken.food, 6);
    });

    it('carry capacity binds: a small army against a full pool takes exactly its lootCapacity, not the whole pool', async () => {
      const attackerTroops = [{ unitType: 'brute', count: 5 }]; // carry 60 x 5 = 300
      const oasisDefenders: Array<{ unitType: string; count: number }> = []; // undefended
      const oasisFood = 100_000;

      const { oasis, movementId, preBattle, expected } = await sendAndArriveOasisBattle({
        attackerTroops,
        oasisX: 29,
        oasisY: 20,
        oasisDefenders,
        oasisFood,
      });
      expect(expected.attackerPrevailed).toBe(true);

      const lootStored: Resources = { scrap: 0, fuel: 0, electronics: 0, food: preBattle.food };
      const expectedLoot = resolveLoot(config, expected, {
        stored: lootStored,
        hiddenCacheLevel: 0,
      });
      expect(expectedLoot.capacityBound).toBe(true);
      expect(expectedLoot.taken.food).toBeCloseTo(expected.lootCapacity, 9);
      // Exactly capacity, nowhere near the whole pool.
      expect(expectedLoot.taken.food).toBeLessThan(oasisFood / 100);

      const movementAfterArrive = await movementModel.findById(movementId);
      expect(movementAfterArrive?.loot?.food).toBeCloseTo(expected.lootCapacity, 9);

      const oasisAfterArrive = await oasisModel.findById(oasis._id);
      expect(oasisAfterArrive?.loot.food).toBeCloseTo(oasisFood - expected.lootCapacity, 6);
    });

    it('an assault wipes the defenders, and a later settle regrows them from empty toward oasisTargetDefenders (the respawn, not just the wipe)', async () => {
      const attackerTroops = [{ unitType: 'brute', count: 1000 }];

      const { oasis, expected, preBattle } = await sendAndArriveOasisBattle({
        type: 'assault',
        attackerTroops,
        oasisX: 29,
        oasisY: 21,
      });
      expect(expected.attackerPrevailed).toBe(true);
      // There was a real garrison to wipe — a virgin oasis's first-contact materialisation
      // (§10) always yields a non-empty target roster.
      expect(preBattle.defenders.length).toBeGreaterThan(0);

      const oasisAfterArrive = await oasisModel.findById(oasis._id);
      // §6: an assault always costs the defender 100 %, regardless of x — the wipe.
      expect(oasisAfterArrive?.defenders).toEqual([]);

      // The respawn, not just the wipe (§10: "assault simply wipes the defenders — they
      // respawn"): settle again, several whole defender intervals later, through the exact
      // same `OasisService.settleOasisDocUnchecked` seam the arrival preamble itself uses.
      const world = await worldService.getWorld();
      const interval = config.oasis.regen.defenderIntervalMs;
      const laterNow = (oasisAfterArrive?.lastDefenderRegenAt as number) + 3 * interval;
      const session = await connection.startSession();
      try {
        await session.withTransaction(async () => {
          await oasisService.settleOasisDocUnchecked(String(oasis._id), laterNow, session);
        });
      } finally {
        await session.endSession();
      }

      const oasisAfterRegrow = await oasisModel.findById(oasis._id);
      const target = oasisTargetDefenders(config, world.seed, 29, 21);
      const expectedRegrown = target
        .map((t) => ({ unitType: t.unitType, count: Math.min(t.count, 3) }))
        .filter((t) => t.count > 0);
      expect(plainUnitEntries(oasisAfterRegrow?.defenders)).toEqual(expectedRegrown);
      expect(oasisAfterRegrow?.defenders.length).toBeGreaterThan(0);
    });

    it('no siege pass at an oasis: an assault carrying siege units and a valid siegeTarget changes nothing structural and resolves the battle normally', async () => {
      const attackerTroops = [
        { unitType: 'brute', count: 300 },
        { unitType: 'ramTruck', count: 10 },
      ];

      const { attacker, oasis, movementId, expected } = await sendAndArriveOasisBattle({
        type: 'assault',
        attackerTroops,
        oasisX: 29,
        oasisY: 22,
        siegeTarget: 'wall',
      });
      expect(expected.attackerPrevailed).toBe(true);
      const survivingRamTrucks =
        expected.attacker.survivors.find((s) => s.unitType === 'ramTruck')?.count ?? 0;
      expect(survivingRamTrucks).toBeGreaterThan(0);

      // The send command still stores `siegeTarget` for this assault (M3c.7a: that validation
      // is a rule about the movement type, not the target) — proving it was actually
      // persisted is what makes the report assertions below a real test of "never read", not
      // a vacuous one.
      const movementDoc = await movementModel.findById(movementId);
      expect(movementDoc?.siegeTarget).toBe('wall');

      const oasisOutcome = expected.defenders.find((d) => d.key === 'oasis');
      if (!oasisOutcome) throw new Error('unreachable');
      const oasisAfter = await oasisModel.findById(oasis._id);
      expect(plainUnitEntries(oasisAfter?.defenders)).toEqual(
        oasisOutcome.survivors.filter((t) => t.count > 0),
      );

      // §10: no siege pass, ever — the report carries none of `BattleArrivalResolver`'s siege
      // fields, proving nothing beyond the ordinary battle above ran.
      const report = await reportModel.findOne({ accountId: attacker.accountId });
      const payload = report?.payload as Record<string, unknown>;
      expect(payload['wallLevelBefore']).toBeUndefined();
      expect(payload['wallLevelAfter']).toBeUndefined();
      expect(payload['siegeTarget']).toBeUndefined();
      expect(payload['targetLevelBefore']).toBeUndefined();
      expect(payload['targetLevelAfter']).toBeUndefined();
      expect(payload['wallPointsSpent']).toBeUndefined();
      expect(payload['buildingPointsSpent']).toBeUndefined();
      expect(payload['defenderWallLevel']).toBe(0);
    });

    it('a defeated attacker loots nothing and the pool is untouched', async () => {
      const attackerTroops = [{ unitType: 'brute', count: 50 }];
      const oasisDefenders = [{ unitType: 'scavengerGang', count: 3000 }];
      const oasisFood = 5000;

      const { attacker, oasis, movementId, expected, preBattle } = await sendAndArriveOasisBattle({
        attackerTroops,
        oasisX: 29,
        oasisY: 23,
        oasisDefenders,
        oasisFood,
      });
      // defPts vastly exceeds atkPts regardless of the ±5 % roll, so x clamps to exactly 1 —
      // the `x === 1` half of §6's "an unsuccessful attacker loots nothing" (not the wipe half
      // — a raid's attacker loss fraction at x=1 is 1/(1+1) = 50 %, not a wipe).
      expect(expected.x).toBe(1);
      expect(expected.attackerPrevailed).toBe(false);
      expect(expected.attacker.survivors.some((s) => s.count > 0)).toBe(true);

      const movement = await movementModel.findById(movementId);
      expect(movement?.status).toBe('returning');
      expect(movement?.loot).toBeUndefined();

      const oasisAfter = await oasisModel.findById(oasis._id);
      expect(oasisAfter?.loot.food).toBeCloseTo(preBattle.food, 9);

      const report = await reportModel.findOne({ accountId: attacker.accountId });
      const payload = report?.payload as { foodTaken: number };
      expect(payload.foodTaken).toBe(0);
    });

    it('replay safety: running the same movementArrive event twice applies the battle and the loot exactly once', async () => {
      const attacker = await createGuestSession();
      const attackerTroops = [{ unitType: 'brute', count: 100 }];
      const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
        troops: attackerTroops,
      });
      const seedTime = Date.now();
      const oasisDefenders = [{ unitType: 'feralDog', count: 3 }];
      const oasisFood = 1500;
      const oasis = await seedOasisAt(29, 24, {
        defenders: oasisDefenders,
        food: oasisFood,
        lastRegenAt: seedTime,
        lastDefenderRegenAt: seedTime,
      });

      const sendResponse = await postSend(attacker.cookie, {
        type: 'raid',
        fromSettlementId: String(attackerSettlement._id),
        target: { x: 29, y: 24 },
        units: attackerTroops,
      });
      expect(sendResponse.status).toBe(201);
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
      const oasisAfterFirst = await oasisModel.findById(oasis._id);
      const movementAfterFirst = await movementModel.findById(movementId);
      expect(movementAfterFirst?.status).toBe('returning');
      expect(await reportModel.countDocuments({ accountId: attacker.accountId })).toBe(1);

      await replayArrive();
      const oasisAfterSecond = await oasisModel.findById(oasis._id);
      const movementAfterSecond = await movementModel.findById(movementId);

      expect(movementAfterSecond?.status).toBe(movementAfterFirst?.status);
      expect(plainUnitEntries(movementAfterSecond?.survivors)).toEqual(
        plainUnitEntries(movementAfterFirst?.survivors),
      );
      expect(oasisAfterSecond?.version).toBe(oasisAfterFirst?.version);
      expect(oasisAfterSecond?.loot.food).toBe(oasisAfterFirst?.loot.food);
      expect(plainUnitEntries(oasisAfterSecond?.defenders)).toEqual(
        plainUnitEntries(oasisAfterFirst?.defenders),
      );
      expect(await reportModel.countDocuments({ accountId: attacker.accountId })).toBe(1);
    });

    it('determinism: the same (world.seed, movementId) always produces the same roll and the same resolveBattle result for an oasis battle', async () => {
      const world = await worldService.getWorld();
      const movementId = new Types.ObjectId().toString();
      const rollA = battleRoll(world.seed, movementId);
      const rollB = battleRoll(world.seed, movementId);
      expect(rollA).toBe(rollB);

      const input = {
        attacker: [{ unitType: 'brute', count: 20 }] as TroopCounts,
        defenders: [{ key: 'oasis', troops: [{ unitType: 'feralDog', count: 8 }] as TroopCounts }],
        wallLevel: 0,
        kind: 'raid' as const,
        roll: rollA,
      };
      const resultA = resolveBattle(config, input);
      const resultB = resolveBattle(config, input);
      expect(resultA).toEqual(resultB);
    });

    it('a total wipe ends the movement done with no return event and clears the whole army out of awayTroops', async () => {
      const attackerTroops = [{ unitType: 'brute', count: 1 }];
      const oasisDefenders = [{ unitType: 'scavengerGang', count: 50 }];

      const { attackerSettlement, oasis, movementId, expected } = await sendAndArriveOasisBattle({
        type: 'assault',
        attackerTroops,
        oasisX: 29,
        oasisY: 25,
        oasisDefenders,
        oasisFood: 0,
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

      // §6's "100 % defender loss on assault, always" applies at an oasis too — the defender's
      // own wipe is not a special case this resolver has to handle (see the resolver's own
      // class comment), it just falls out of the ordinary battle result.
      const oasisAfter = await oasisModel.findById(oasis._id);
      const oasisOutcome = expected.defenders.find((d) => d.key === 'oasis');
      if (!oasisOutcome) throw new Error('unreachable');
      expect(plainUnitEntries(oasisAfter?.defenders)).toEqual(
        oasisOutcome.survivors.filter((t) => t.count > 0),
      );
    });
  });

  describe('M3c.8: GET /api/movements/incoming, tiered by the target settlement’s Radio Tower', () => {
    // Seeds a settlement whose only building beyond the mandatory Command Center is a Radio
    // Tower at `radioTowerLevel` — a direct Mongoose write (bypassing the real
    // prerequisite/cost chain the tower actually needs, CC 5 + Electronics Workshop 3, §12),
    // the same "known, arbitrary building level" convention `sendAndArriveSiege`'s
    // `defenderBuildings` option already establishes for `wall`/`commandCenter` in the
    // M3c.5b suite above.
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

    it('Radio Tower tiers gate incoming detail on the same movement as the tower is upgraded: existence -> kind -> full, thresholds read from config.radioTower.incomingTiers (never hardcoded)', async () => {
      const attacker = await createGuestSession();
      const troops = [
        { unitType: 'brute', count: 5 },
        { unitType: 'ramTruck', count: 2 },
      ];
      const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, { troops });
      const { defender, defenderSettlement } = await seedDefenderWithTower(0, 5, 0);

      const sendResponse = await postSend(attacker.cookie, {
        type: 'assault',
        fromSettlementId: String(attackerSettlement._id),
        target: { x: 5, y: 0 },
        units: troops,
        siegeTarget: 'warehouse',
      });
      expect(sendResponse.status).toBe(201);

      // --- Radio Tower level 0: `existence` only (§12's table, top row — granted at every
      // level, including 0, per `incomingDetailTier`'s own doc comment in game-core).
      const atZero = await getIncoming(defender.cookie);
      expect(atZero.status).toBe(200);
      expect(atZero.body.movements).toHaveLength(1);
      const existenceEntry = atZero.body.movements[0];
      expect(existenceEntry.id).toBe(sendResponse.body.id);
      expect(existenceEntry.toSettlementId).toBe(String(defenderSettlement._id));
      expect(existenceEntry.arriveAt).toBe(sendResponse.body.arriveAt);
      expect(existenceEntry.origin).toEqual({ x: 0, y: 0 });
      expect(existenceEntry.originSettlementId).toBe(String(attackerSettlement._id));
      expect(existenceEntry.ownerAccountId).toBe(String(attacker.accountId));
      expect(typeof existenceEntry.ownerName).toBe('string');
      expect(existenceEntry.detailTier).toBe('existence');
      expect(existenceEntry.hostile).toBe(true);
      expect(existenceEntry.type).toBeUndefined();
      expect(existenceEntry.unitCount).toBeUndefined();
      expect(existenceEntry.units).toBeUndefined();
      expect(existenceEntry.siegeTarget).toBeUndefined();

      // The security property itself (§12's whole point): these fields are not merely absent
      // from the typed view, they never touched the wire — `map.integration.spec.ts`'s own
      // `JSON.stringify(response.body)` convention, applied here.
      const zeroSerialized = JSON.stringify(atZero.body);
      for (const leaked of [
        '"units"',
        'ramTruck',
        'siegeTarget',
        'warehouse',
        '"type"',
        'unitCount',
      ]) {
        expect(zeroSerialized).not.toContain(leaked);
      }

      // --- Radio Tower at the `kind` threshold: type + total unit count, still no
      // composition and no siege target. Bumped via a direct `$set` on the already-persisted
      // building (not a fresh settlement) so this is provably the SAME movement being read
      // twice under two different tower levels, not two coincidentally-similar ones.
      await settlementModel.updateOne(
        { _id: defenderSettlement._id, 'buildings.type': 'radioTower' },
        { $set: { 'buildings.$.level': config.radioTower.incomingTiers.kind } },
      );
      const atKind = await getIncoming(defender.cookie);
      expect(atKind.body.movements).toHaveLength(1);
      const kindEntry = atKind.body.movements[0];
      expect(kindEntry.detailTier).toBe('kind');
      expect(kindEntry.type).toBe('assault');
      expect(kindEntry.unitCount).toBe(7);
      expect(kindEntry.units).toBeUndefined();
      expect(kindEntry.siegeTarget).toBeUndefined();

      const kindSerialized = JSON.stringify(atKind.body);
      for (const leaked of ['"units"', 'ramTruck', 'siegeTarget', 'warehouse']) {
        expect(kindSerialized).not.toContain(leaked);
      }

      // --- Radio Tower at the `full` threshold: full per-unit-type composition AND the
      // siege target both appear.
      await settlementModel.updateOne(
        { _id: defenderSettlement._id, 'buildings.type': 'radioTower' },
        { $set: { 'buildings.$.level': config.radioTower.incomingTiers.full } },
      );
      const atFull = await getIncoming(defender.cookie);
      expect(atFull.body.movements).toHaveLength(1);
      const fullEntry = atFull.body.movements[0];
      expect(fullEntry.detailTier).toBe('full');
      expect(fullEntry.type).toBe('assault');
      expect(fullEntry.unitCount).toBe(7);
      expect(fullEntry.units).toEqual(
        expect.arrayContaining([
          { unitType: 'brute', count: 5 },
          { unitType: 'ramTruck', count: 2 },
        ]),
      );
      expect(fullEntry.units).toHaveLength(2);
      expect(fullEntry.siegeTarget).toBe('warehouse');
    });

    it('an inbound scout is never listed, even at Radio Tower level 0', async () => {
      const attacker = await createGuestSession();
      const scouts = [{ unitType: 'lookout', count: 2 }];
      const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
        troops: scouts,
      });
      const { defender } = await seedDefenderWithTower(0, 5, 0);

      const sendResponse = await postSend(attacker.cookie, {
        type: 'scout',
        fromSettlementId: String(attackerSettlement._id),
        target: { x: 5, y: 0 },
        units: scouts,
      });
      expect(sendResponse.status).toBe(201);

      const response = await getIncoming(defender.cookie);
      expect(response.status).toBe(200);
      expect(response.body.movements).toEqual([]);
    });

    it('an inbound scout is never listed, even at the full Radio Tower threshold — M2 §8’s rule, kept by §12: a scout you can see coming is not a scout', async () => {
      const attacker = await createGuestSession();
      const scouts = [{ unitType: 'lookout', count: 2 }];
      const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, {
        troops: scouts,
      });
      const { defender } = await seedDefenderWithTower(config.radioTower.incomingTiers.full, 5, 0);

      const sendResponse = await postSend(attacker.cookie, {
        type: 'scout',
        fromSettlementId: String(attackerSettlement._id),
        target: { x: 5, y: 0 },
        units: scouts,
      });
      expect(sendResponse.status).toBe(201);

      const response = await getIncoming(defender.cookie);
      expect(response.status).toBe(200);
      expect(response.body.movements).toEqual([]);
    });

    it('inbound support is fully visible even at Radio Tower level 0 (§12/§8: it is help, the host may need to evict it)', async () => {
      const supporter = await createGuestSession();
      const troops = [{ unitType: 'brute', count: 3 }];
      const supporterSettlement = await seedSettlementAt(supporter.accountId, 0, 0, { troops });
      const { defender } = await seedDefenderWithTower(0, 5, 0);

      const sendResponse = await postSend(supporter.cookie, {
        type: 'support',
        fromSettlementId: String(supporterSettlement._id),
        target: { x: 5, y: 0 },
        units: troops,
      });
      expect(sendResponse.status).toBe(201);

      const response = await getIncoming(defender.cookie);
      expect(response.status).toBe(200);
      expect(response.body.movements).toHaveLength(1);
      const entry = response.body.movements[0];
      expect(entry.hostile).toBe(false);
      expect(entry.detailTier).toBe('full');
      expect(entry.type).toBe('support');
      expect(entry.unitCount).toBe(3);
      expect(entry.units).toEqual([{ unitType: 'brute', count: 3 }]);
    });

    it('a returning movement is not listed as incoming for the settlement it was originally sent at — it is going home to its OWNER, not inbound at anyone', async () => {
      const attacker = await createGuestSession();
      const troops = [{ unitType: 'brute', count: 5 }];
      const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, { troops });
      const { defender } = await seedDefenderWithTower(0, 5, 0);

      const sendResponse = await postSend(attacker.cookie, {
        type: 'raid',
        fromSettlementId: String(attackerSettlement._id),
        target: { x: 5, y: 0 },
        units: troops,
      });
      expect(sendResponse.status).toBe(201);
      const movementId = sendResponse.body.id as string;

      const cancelResponse = await postCancel(attacker.cookie, movementId);
      expect(cancelResponse.status).toBe(200);
      expect(cancelResponse.body.status).toBe('returning');

      const response = await getIncoming(defender.cookie);
      expect(response.status).toBe(200);
      expect(response.body.movements).toEqual([]);
    });

    it('another account’s settlement’s incoming movements are not visible to the caller', async () => {
      const attacker = await createGuestSession();
      const bystander = await createGuestSession();
      const troops = [{ unitType: 'brute', count: 5 }];
      const attackerSettlement = await seedSettlementAt(attacker.accountId, 0, 0, { troops });
      const { defender } = await seedDefenderWithTower(0, 5, 0);

      const sendResponse = await postSend(attacker.cookie, {
        type: 'raid',
        fromSettlementId: String(attackerSettlement._id),
        target: { x: 5, y: 0 },
        units: troops,
      });
      expect(sendResponse.status).toBe(201);

      const bystanderResponse = await getIncoming(bystander.cookie);
      expect(bystanderResponse.status).toBe(200);
      expect(bystanderResponse.body.movements).toEqual([]);

      const defenderResponse = await getIncoming(defender.cookie);
      expect(defenderResponse.body.movements).toHaveLength(1);
    });

    it('a caller with several settlements sees incoming across all of them, each tiered by its OWN settlement’s tower level', async () => {
      const defender = await createGuestSession();
      const settlementLow = await seedSettlementAt(defender.accountId, 5, 0, {
        buildings: [
          { type: 'commandCenter', level: 1 },
          { type: 'radioTower', level: 0 },
        ],
      });
      const settlementHigh = await seedSettlementAt(defender.accountId, -5, 0, {
        buildings: [
          { type: 'commandCenter', level: 1 },
          { type: 'radioTower', level: config.radioTower.incomingTiers.full },
        ],
      });

      const attacker1 = await createGuestSession();
      const attacker2 = await createGuestSession();
      const troops1 = [{ unitType: 'brute', count: 3 }];
      const troops2 = [{ unitType: 'brute', count: 4 }];
      const attackerSettlement1 = await seedSettlementAt(attacker1.accountId, 0, 0, {
        troops: troops1,
      });
      const attackerSettlement2 = await seedSettlementAt(attacker2.accountId, 0, -1, {
        troops: troops2,
      });

      const send1 = await postSend(attacker1.cookie, {
        type: 'raid',
        fromSettlementId: String(attackerSettlement1._id),
        target: { x: 5, y: 0 },
        units: troops1,
      });
      expect(send1.status).toBe(201);

      const send2 = await postSend(attacker2.cookie, {
        type: 'raid',
        fromSettlementId: String(attackerSettlement2._id),
        target: { x: -5, y: 0 },
        units: troops2,
      });
      expect(send2.status).toBe(201);

      const response = await getIncoming(defender.cookie);
      expect(response.status).toBe(200);
      expect(response.body.movements).toHaveLength(2);

      const lowEntry = response.body.movements.find(
        (m: { toSettlementId: string }) => m.toSettlementId === String(settlementLow._id),
      );
      const highEntry = response.body.movements.find(
        (m: { toSettlementId: string }) => m.toSettlementId === String(settlementHigh._id),
      );
      expect(lowEntry).toBeDefined();
      expect(highEntry).toBeDefined();
      expect(lowEntry.detailTier).toBe('existence');
      expect(lowEntry.type).toBeUndefined();
      expect(lowEntry.units).toBeUndefined();
      expect(highEntry.detailTier).toBe('full');
      expect(highEntry.type).toBe('raid');
      expect(highEntry.unitCount).toBe(4);
      expect(highEntry.units).toEqual([{ unitType: 'brute', count: 4 }]);
    });
  });

  // M3d.1: the settler convoy and Influence-gated founding (`docs/M3_DESIGN_DECISIONS.md`
  // §13) — the `settle` movement, its send-time validation (composition + the Influence gate,
  // "checked twice"), and `SettleArrivalResolver`'s arrival re-checks/founding/turn-around.
  describe('M3d.1: settler convoy and Influence-gated founding', () => {
    // §13: founding costs exactly `config.settle.settlersRequired` Settlers — read from the
    // real config, never hardcoded, so a future retune of the draft number can't silently
    // desync this suite from the real gate it's supposed to be testing.
    const SETTLERS_REQUIRED = config.settle.settlersRequired;
    const SETTLER_TROOPS = [{ unitType: 'settler', count: SETTLERS_REQUIRED }];

    // Building levels seeded directly (bypassing the real build queue, which this suite has
    // no time to run through) purely to satisfy the Influence *precondition* a test needs —
    // CC L20 (weight 3 -> 60) + Scrap Yard L20 + Fuel Refinery L20 (weight 1 each -> 40) = 100,
    // comfortably clearing `config.influence.settlementThresholds[0]` (90 by default).
    // `assertAllowsAnotherSettlement` below still derives the actual gate from
    // `calcInfluence`/`settlementsAllowed` rather than assuming 100 clears it forever.
    const HIGH_INFLUENCE_BUILDINGS = [
      { type: 'commandCenter', level: 20 },
      { type: 'scrapYard', level: 20 },
      { type: 'fuelRefinery', level: 20 },
    ];

    // Fails the test loudly (rather than letting a later assertion fail confusingly) if
    // `HIGH_INFLUENCE_BUILDINGS` ever stops clearing the gate for the given number of
    // already-existing settlements — the real formulas, not an assumption.
    function assertAllowsAnotherSettlement(existingCount: number): void {
      const influence = calcInfluence(config, [HIGH_INFLUENCE_BUILDINGS as BuildingLevels]);
      expect(settlementsAllowed(config, influence)).toBeGreaterThan(existingCount);
    }

    function postSettle(
      cookie: string[],
      fromSettlementId: string,
      target: { x: number; y: number },
      units: Array<{ unitType: string; count: number }> = SETTLER_TROOPS,
    ) {
      return postSend(cookie, { type: 'settle', fromSettlementId, target, units });
    }

    function getMySettlements(cookie: string[]) {
      return request(app.getHttpServer()).get('/api/settlements/mine').set('Cookie', cookie);
    }

    // Finds a tile that genuinely passes `isSettleable` against the CURRENT live world/
    // settlement/oasis state, searching outward in Chebyshev rings from `(baseX, baseY)` —
    // hand-picking a fixed coordinate would be flaky: the world seed is freshly randomised
    // per test run (`WorldService.bootstrap`), so whether any given tile is a toxic lake, and
    // whether it happens to coincide with one of the 24 real generated oases, is not fixed
    // across runs. Uses the exact same `game-core` functions `PlacementService.isTileSettleable`
    // calls, so a tile this returns is guaranteed to pass the real send-time and arrival-time
    // re-checks too — never a hardcoded coordinate standing in for "some legal tile".
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
            if (legal) {
              return tile;
            }
          }
        }
      }
      throw new Error('findLegalSettleTile: no legal tile found near the requested base');
    }

    // A tile deliberately too close to `origin` (Chebyshev distance < `config.map.settlement
    // .minDistance`, default 3) to be settleable — for the `tileNotSettleable` rejection,
    // distinct from `tileOccupied`. Checked against the live oasis set so the offset itself
    // never accidentally lands on a real oasis, which would produce `tileOccupied` instead.
    async function findTooCloseTile(origin: { x: number; y: number }): Promise<{
      x: number;
      y: number;
    }> {
      const oasisDocs = await oasisModel.find({}, 'x y');
      const oasisTiles = new Set(oasisDocs.map((d) => `${d.x},${d.y}`));
      const candidates = [
        { x: origin.x + 1, y: origin.y },
        { x: origin.x + 2, y: origin.y },
        { x: origin.x, y: origin.y + 1 },
        { x: origin.x, y: origin.y + 2 },
        { x: origin.x - 1, y: origin.y },
        { x: origin.x - 2, y: origin.y },
      ];
      for (const candidate of candidates) {
        const inGrid = Math.max(Math.abs(candidate.x), Math.abs(candidate.y)) <= config.map.radius;
        if (inGrid && !oasisTiles.has(`${candidate.x},${candidate.y}`)) {
          return candidate;
        }
      }
      throw new Error('findTooCloseTile: no candidate tile available');
    }

    // Backdates `departAt` and forces the `movementArrive` event due for TWO movements at
    // once, then drains both through ONE `schedulerService.runOnce()` call — the playbook-race
    // test's own variant of `forceArrive` (which only ever handles one movement at a time).
    // Staggered `dueAt`s (1s apart) make the processing order deterministic without changing
    // which of the two "wins": the `{x, y}` unique index — not arrival order — is what §13
    // names as "the final authority" here, so either order must produce the identical outcome
    // (exactly one founds).
    async function forceBothArrive(movementIdA: string, movementIdB: string): Promise<void> {
      await movementModel.updateMany(
        { _id: { $in: [movementIdA, movementIdB] } },
        { $set: { departAt: Date.now() - 600_000 } },
      );
      await eventModel.updateOne(
        { type: 'movementArrive', 'payload.movementId': movementIdA },
        { $set: { dueAt: Date.now() - 2_000 } },
      );
      await eventModel.updateOne(
        { type: 'movementArrive', 'payload.movementId': movementIdB },
        { $set: { dueAt: Date.now() - 1_000 } },
      );
      await schedulerService.runOnce();
    }

    it('end to end (§20 acceptance): 3 Settlers found a second settlement with a Command Center at L1, starting resources, and it appears in GET /api/settlements/mine', async () => {
      const founder = await createGuestSession();
      const origin = await seedSettlementAt(founder.accountId, 0, 0, {
        buildings: HIGH_INFLUENCE_BUILDINGS,
        troops: SETTLER_TROOPS,
      });
      assertAllowsAnotherSettlement(1);
      const target = await findLegalSettleTile(20, 0);

      const sendResponse = await postSettle(founder.cookie, String(origin._id), target);
      expect(sendResponse.status).toBe(201);
      const movementId = sendResponse.body.id as string;

      await forceArrive(movementId);

      const movement = await movementModel.findById(movementId);
      expect(movement?.status).toBe('done');
      expect(movement?.survivors).toHaveLength(0);
      expect(movement?.toSettlementId).toBeUndefined();
      expect(movement?.toOasisId).toBeUndefined();

      const newSettlementDoc = await settlementModel.findOne({ x: target.x, y: target.y });
      expect(newSettlementDoc).not.toBeNull();
      if (!newSettlementDoc) throw new Error('unreachable');
      expect(String(newSettlementDoc.accountId)).toBe(String(founder.accountId));
      expect(newSettlementDoc.buildings.map((b) => ({ type: b.type, level: b.level }))).toEqual([
        { type: 'commandCenter', level: 1 },
      ]);
      expectResourcesCloseTo(
        newSettlementDoc.resources.values,
        STARTING_RESOURCES,
        [{ type: 'commandCenter', level: 1 }],
        [],
      );

      // The Settlers are consumed, not credited anywhere (§13) — the origin's `awayTroops`
      // (which held them while the convoy was in transit) is empty, and the new settlement's
      // own `troops` is empty too (it starts with nothing but its Command Center).
      const originAfter = await settlementModel.findById(origin._id);
      expect(plainUnitEntries(originAfter?.awayTroops)).toEqual([]);
      expect(plainUnitEntries(newSettlementDoc.troops)).toEqual([]);

      const report = await reportModel.findOne({ accountId: founder.accountId, type: 'settle' });
      expect(report).not.toBeNull();
      expect(report?.payload['founded']).toBe(true);
      expect(report?.payload['newSettlementId']).toBe(String(newSettlementDoc._id));
      expect(report?.payload['target']).toEqual(target);

      const mineResponse = await getMySettlements(founder.cookie);
      expect(mineResponse.status).toBe(200);
      const ids = (mineResponse.body as Array<{ id: string }>).map((s) => s.id);
      expect(ids).toContain(String(origin._id));
      expect(ids).toContain(String(newSettlementDoc._id));
      expect(ids).toHaveLength(2);
    });

    it('rejected at send: the target tile already holds a settlement (tileOccupied)', async () => {
      const founder = await createGuestSession();
      const origin = await seedSettlementAt(founder.accountId, 0, 0, {
        buildings: HIGH_INFLUENCE_BUILDINGS,
        troops: SETTLER_TROOPS,
      });
      assertAllowsAnotherSettlement(1);
      const occupant = await createGuestSession();
      const occupiedTile = { x: 15, y: 0 };
      await seedSettlementAt(occupant.accountId, occupiedTile.x, occupiedTile.y);

      const response = await postSettle(founder.cookie, String(origin._id), occupiedTile);
      expect(response.status).toBe(400);
      expect(response.body.error.key).toBe('errors.movement.tileOccupied');
    });

    it('rejected at send: the target tile already holds an oasis (tileOccupied)', async () => {
      const founder = await createGuestSession();
      const origin = await seedSettlementAt(founder.accountId, 0, 0, {
        buildings: HIGH_INFLUENCE_BUILDINGS,
        troops: SETTLER_TROOPS,
      });
      assertAllowsAnotherSettlement(1);
      // x=29 is edge-safe (`generateOases` never places a real oasis there, §2's own margin
      // rule) — the same file-wide convention every `seedOasisAt` call above follows; y=0 at
      // this x is not reused by any earlier call in this file.
      const occupiedTile = { x: 29, y: 0 };
      await seedOasisAt(occupiedTile.x, occupiedTile.y);

      const response = await postSettle(founder.cookie, String(origin._id), occupiedTile);
      expect(response.status).toBe(400);
      expect(response.body.error.key).toBe('errors.movement.tileOccupied');
    });

    it('rejected at send: the target tile is too close to an existing settlement (tileNotSettleable)', async () => {
      const founder = await createGuestSession();
      const origin = await seedSettlementAt(founder.accountId, 0, 0, {
        buildings: HIGH_INFLUENCE_BUILDINGS,
        troops: SETTLER_TROOPS,
      });
      assertAllowsAnotherSettlement(1);
      const tooClose = await findTooCloseTile({ x: 0, y: 0 });

      const response = await postSettle(founder.cookie, String(origin._id), tooClose);
      expect(response.status).toBe(400);
      expect(response.body.error.key).toBe('errors.movement.tileNotSettleable');
    });

    it('legal at send, but the tile is taken before arrival: the convoy returns home with all 3 Settlers alive, and a settle report names the reason', async () => {
      const founder = await createGuestSession();
      const origin = await seedSettlementAt(founder.accountId, 0, 0, {
        buildings: HIGH_INFLUENCE_BUILDINGS,
        troops: SETTLER_TROOPS,
      });
      assertAllowsAnotherSettlement(1);
      const target = await findLegalSettleTile(-20, 0);

      const sendResponse = await postSettle(founder.cookie, String(origin._id), target);
      expect(sendResponse.status).toBe(201);
      const movementId = sendResponse.body.id as string;

      // The world moved while the convoy travelled (§13): someone else founded on the exact
      // same tile in the meantime.
      const rival = await createGuestSession();
      await seedSettlementAt(rival.accountId, target.x, target.y);

      await forceArrive(movementId);

      const movement = await movementModel.findById(movementId);
      expect(movement?.status).toBe('returning');
      expect(plainUnitEntries(movement?.survivors)).toEqual(SETTLER_TROOPS);

      // No second settlement was created at the origin's expense — the tile still holds only
      // the rival's own settlement.
      expect(await settlementModel.countDocuments({ x: target.x, y: target.y })).toBe(1);

      const report = await reportModel.findOne({ accountId: founder.accountId, type: 'settle' });
      expect(report?.payload['founded']).toBe(false);
      expect(report?.payload['reason']).toBe('tileOccupied');

      // Full round trip (§13: "the Settlers alive"): force the scheduled return leg too, and
      // confirm they actually land back home, not just "still alive somewhere on the wire".
      if (!movementId) throw new Error('unreachable');
      await forceReturn(movementId);
      const originAfterReturn = await settlementModel.findById(origin._id);
      expect(plainUnitEntries(originAfterReturn?.troops)).toEqual(SETTLER_TROOPS);
      expect(plainUnitEntries(originAfterReturn?.awayTroops)).toEqual([]);
    });

    it("legal at send, but the sender's Influence no longer permits founding by arrival: the convoy returns home with all 3 Settlers alive", async () => {
      const founder = await createGuestSession();
      const origin = await seedSettlementAt(founder.accountId, 0, 0, {
        buildings: HIGH_INFLUENCE_BUILDINGS,
        troops: SETTLER_TROOPS,
      });
      assertAllowsAnotherSettlement(1);
      const target = await findLegalSettleTile(20, -20);

      const sendResponse = await postSettle(founder.cookie, String(origin._id), target);
      expect(sendResponse.status).toBe(201);
      const movementId = sendResponse.body.id as string;

      // §13's own named example: "Influence dropped below the threshold because a building
      // was destroyed in the meantime" — driven here by actually lowering the buildings that
      // used to carry the Influence, not by mocking `calcInfluence`.
      await settlementModel.updateOne(
        { _id: origin._id },
        { $set: { buildings: [{ id: randomUUID(), type: 'commandCenter', level: 1, slot: 0 }] } },
      );
      const lowInfluence = calcInfluence(config, [
        [{ type: 'commandCenter', level: 1 }] as BuildingLevels,
      ]);
      expect(settlementsAllowed(config, lowInfluence)).toBe(1);

      await forceArrive(movementId);

      const movement = await movementModel.findById(movementId);
      expect(movement?.status).toBe('returning');
      expect(plainUnitEntries(movement?.survivors)).toEqual(SETTLER_TROOPS);
      expect(await settlementModel.countDocuments({ x: target.x, y: target.y })).toBe(0);

      const report = await reportModel.findOne({ accountId: founder.accountId, type: 'settle' });
      expect(report?.payload['founded']).toBe(false);
      expect(report?.payload['reason']).toBe('settlementLimitReached');
    });

    it('rejected at send: the wrong army composition (2 Settlers; 3 Settlers + 1 Brute; 3 Brutes)', async () => {
      const founder = await createGuestSession();
      const origin = await seedSettlementAt(founder.accountId, 0, 0);
      const target = { x: 10, y: 10 };

      const tooFew = await postSettle(founder.cookie, String(origin._id), target, [
        { unitType: 'settler', count: 2 },
      ]);
      expect(tooFew.status).toBe(400);
      expect(tooFew.body.error.key).toBe('errors.movement.settleRequiresSettlers');
      expect(tooFew.body.error.params).toEqual({ required: SETTLERS_REQUIRED, supplied: 2 });

      const extraUnit = await postSettle(founder.cookie, String(origin._id), target, [
        { unitType: 'settler', count: SETTLERS_REQUIRED },
        { unitType: 'brute', count: 1 },
      ]);
      expect(extraUnit.status).toBe(400);
      expect(extraUnit.body.error.key).toBe('errors.movement.settleRequiresSettlers');
      expect(extraUnit.body.error.params).toEqual({
        required: SETTLERS_REQUIRED,
        supplied: SETTLERS_REQUIRED,
      });

      const noSettlers = await postSettle(founder.cookie, String(origin._id), target, [
        { unitType: 'brute', count: 3 },
      ]);
      expect(noSettlers.status).toBe(400);
      expect(noSettlers.body.error.key).toBe('errors.movement.settleRequiresSettlers');
      expect(noSettlers.body.error.params).toEqual({ required: SETTLERS_REQUIRED, supplied: 0 });
    });

    it('the settlement cap is enforced at send: an account already at its Influence-allowed limit is rejected before the target is even resolved', async () => {
      const founder = await createGuestSession();
      const first = await seedSettlementAt(founder.accountId, 0, 0, { troops: SETTLER_TROOPS });
      await seedSettlementAt(founder.accountId, 5, 0);

      // Both settlements are bare Command Centers (influence 3 each, 6 total) — well below
      // `settlementThresholds[0]` — so `settlementsAllowed` permits exactly 1, and the
      // account already holds 2.
      const influence = calcInfluence(config, [
        [{ type: 'commandCenter', level: 1 }] as BuildingLevels,
        [{ type: 'commandCenter', level: 1 }] as BuildingLevels,
      ]);
      expect(settlementsAllowed(config, influence)).toBe(1);

      const response = await postSettle(founder.cookie, String(first._id), { x: 20, y: 20 });
      expect(response.status).toBe(400);
      expect(response.body.error.key).toBe('errors.movement.settlementLimitReached');
    });

    it('protectedUntil is NOT re-stamped on the founding account when a settle movement founds its second settlement', async () => {
      const founder = await createGuestSession();
      const origin = await seedSettlementAt(founder.accountId, 0, 0, {
        buildings: HIGH_INFLUENCE_BUILDINGS,
        troops: SETTLER_TROOPS,
      });
      assertAllowsAnotherSettlement(1);
      // Simulates the stamp `createSettlement` would have made on this account's real first
      // settlement (`seedSettlementAt` bypasses that flow entirely, §11) — a fixed, easily
      // distinguished sentinel value this test can assert stays byte-for-byte unchanged.
      const originalProtectedUntil = Date.now() + 999_000_000;
      await accountModel.updateOne(
        { _id: founder.accountId },
        { $set: { protectedUntil: originalProtectedUntil } },
      );
      const target = await findLegalSettleTile(0, 20);

      const sendResponse = await postSettle(founder.cookie, String(origin._id), target);
      expect(sendResponse.status).toBe(201);
      await forceArrive(sendResponse.body.id as string);

      expect(await settlementModel.countDocuments({ x: target.x, y: target.y })).toBe(1);
      const accountAfter = await accountModel.findById(founder.accountId);
      expect(accountAfter?.protectedUntil).toBe(originalProtectedUntil);
    });

    it('replay safety: running the same movementArrive event twice creates exactly ONE settlement', async () => {
      const founder = await createGuestSession();
      const origin = await seedSettlementAt(founder.accountId, 0, 0, {
        buildings: HIGH_INFLUENCE_BUILDINGS,
        troops: SETTLER_TROOPS,
      });
      assertAllowsAnotherSettlement(1);
      const target = await findLegalSettleTile(0, -20);

      const sendResponse = await postSettle(founder.cookie, String(origin._id), target);
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
      expect(await settlementModel.countDocuments({ x: target.x, y: target.y })).toBe(1);
      expect(
        await reportModel.countDocuments({ accountId: founder.accountId, type: 'settle' }),
      ).toBe(1);
      const afterFirst = await movementModel.findById(movementId);
      expect(afterFirst?.status).toBe('done');

      await replayArrive();
      expect(await settlementModel.countDocuments({ x: target.x, y: target.y })).toBe(1);
      expect(
        await reportModel.countDocuments({ accountId: founder.accountId, type: 'settle' }),
      ).toBe(1);
      const afterSecond = await movementModel.findById(movementId);
      expect(afterSecond?.status).toBe('done');
      expect(afterSecond?.version).toBe(afterFirst?.version);
    });

    it('the playbook race: two convoys from different accounts arriving at the same tile — exactly one founds, the other returns with its Settlers alive', async () => {
      const founderA = await createGuestSession();
      const founderB = await createGuestSession();
      const originA = await seedSettlementAt(founderA.accountId, 0, 0, {
        buildings: HIGH_INFLUENCE_BUILDINGS,
        troops: SETTLER_TROOPS,
      });
      const originB = await seedSettlementAt(founderB.accountId, 0, 8, {
        buildings: HIGH_INFLUENCE_BUILDINGS,
        troops: SETTLER_TROOPS,
      });
      assertAllowsAnotherSettlement(1);
      const target = await findLegalSettleTile(20, 20);

      const sendA = await postSettle(founderA.cookie, String(originA._id), target);
      expect(sendA.status).toBe(201);
      const sendB = await postSettle(founderB.cookie, String(originB._id), target);
      expect(sendB.status).toBe(201);

      await forceBothArrive(sendA.body.id as string, sendB.body.id as string);

      const movementA = await movementModel.findById(sendA.body.id as string);
      const movementB = await movementModel.findById(sendB.body.id as string);
      const statuses = [movementA?.status, movementB?.status].sort();
      expect(statuses).toEqual(['done', 'returning']);

      const winner = movementA?.status === 'done' ? movementA : movementB;
      const loser = movementA?.status === 'done' ? movementB : movementA;
      expect(plainUnitEntries(loser?.survivors)).toEqual(SETTLER_TROOPS);

      expect(await settlementModel.countDocuments({ x: target.x, y: target.y })).toBe(1);

      const winnerAccountId = winner === movementA ? founderA.accountId : founderB.accountId;
      const loserAccountId = loser === movementA ? founderA.accountId : founderB.accountId;
      const winnerReport = await reportModel.findOne({
        accountId: winnerAccountId,
        type: 'settle',
      });
      const loserReport = await reportModel.findOne({ accountId: loserAccountId, type: 'settle' });
      expect(winnerReport?.payload['founded']).toBe(true);
      expect(loserReport?.payload['founded']).toBe(false);
      expect(loserReport?.payload['reason']).toBe('tileOccupied');
    });
  });
});
