import { randomUUID } from 'node:crypto';

import type {
  BuildingLevels,
  BuildingType,
  Faction,
  GameConfig,
  Resources,
  UnitType,
} from '@last-signal/game-core';
import {
  BUILDING_TYPES,
  DEFAULT_CONFIG,
  FACTIONS,
  HOUR_MS,
  RESOURCE_KINDS,
  calcBuildCost,
  calcFoodUpkeepPerHour,
  calcNetFoodPerHour,
  calcNetRates,
  calcTrainCost,
  calcTrainTimeMs,
  calcTroopFoodUpkeepPerHour,
  msUntilEmpty,
  resolveStarvation,
  scoutUnitForFaction,
  starvationOrder,
  unitsTrainableAt,
  wouldStarveSettlement,
  wouldStarveWithTroops,
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
import { GameEvent } from '../schemas/event.schema';
import type { GameEventDocument } from '../schemas/event.schema';
import { Account } from '../schemas/account.schema';
import type { AccountDocument } from '../schemas/account.schema';
import { Report } from '../schemas/report.schema';
import type { ReportDocument } from '../schemas/report.schema';
import { Settlement } from '../schemas/settlement.schema';
import type { SettlementDocument } from '../schemas/settlement.schema';
import { SchedulerService } from '../scheduler/scheduler.service';
import { BuildCompleteHandler } from './handlers/build-complete.handler';
import { StarvationTickHandler } from './handlers/starvation-tick.handler';
import { TrainingCompleteHandler } from './handlers/training-complete.handler';
import { ACTIVE_BUILD_SLOTS, MAX_TRAIN_COUNT, WAITING_QUEUE_SLOTS } from './settlements.constants';
import { stationedContingentKey, toBuildingLevels } from './settlements.util';

// Proves the M1a.7 acceptance criterion end to end: a build starts and completes through
// the REST API against a real MongoDB replica set. Follows the exact pattern already
// established by `health.integration.spec.ts` (boot the whole `AppModule` against a
// `MongoMemoryReplSet`) and `scheduler.integration.spec.ts` (disable the scheduler's real
// timer, drive completions deterministically via `runOnce()` after forcing an event
// overdue) rather than inventing a third convention.
//
// M1b note: every settlement route is now ownership-checked (ownership itself, and the
// creation/placement flow, are covered by `settlement-creation.integration.spec.ts`) — every
// request below rides a real guest session cookie for the settlement's own owner, obtained
// via `createGuestSession()`.
describe('Settlements (integration)', () => {
  let app: INestApplication;
  let replSet: MongoMemoryReplSet;
  let moduleRef: TestingModule;
  let connection: Connection;
  let accountModel: Model<AccountDocument>;
  let settlementModel: Model<SettlementDocument>;
  let eventModel: Model<GameEventDocument>;
  let reportModel: Model<ReportDocument>;
  let schedulerService: SchedulerService;
  let buildCompleteHandler: BuildCompleteHandler;
  let trainingCompleteHandler: TrainingCompleteHandler;
  let starvationTickHandler: StarvationTickHandler;
  let activeBuildSlots: number;

  const config: GameConfig = DEFAULT_CONFIG;
  // Every no-prerequisite building type in the catalogue (§2) that a fixture can freely
  // queue as a "fresh" build — excludes `commandCenter` even though it also has
  // `requires: []`, since every seeded settlement already has one at level 1 (queuing it
  // "fresh" would actually compute a level-2 upgrade against the existing one, not a
  // level-1 build, throwing off every cost assertion below).
  const noPrereqTypes = BUILDING_TYPES.filter(
    (type) => type !== 'commandCenter' && config.buildings[type].requires.length === 0,
  );

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    process.env['MONGODB_URI'] = replSet.getUri('last-signal-settlements-test');
    // The real 1s timer would race this suite's manual `runOnce()` calls.
    process.env['SCHEDULER_ENABLED'] = 'false';
    // NPC seeding is covered by its own suite (`npc/npc-seeder.integration.spec.ts`) — off
    // here so it never contends with this file's own settlement/build-queue fixtures.
    process.env['WORLD_NPC_COUNT'] = '0';

    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();

    connection = moduleRef.get(getConnectionToken());
    accountModel = moduleRef.get(getModelToken(Account.name));
    settlementModel = moduleRef.get(getModelToken(Settlement.name));
    eventModel = moduleRef.get(getModelToken(GameEvent.name));
    reportModel = moduleRef.get(getModelToken(Report.name));
    schedulerService = moduleRef.get(SchedulerService);
    buildCompleteHandler = moduleRef.get(BuildCompleteHandler);
    trainingCompleteHandler = moduleRef.get(TrainingCompleteHandler);
    starvationTickHandler = moduleRef.get(StarvationTickHandler);
    activeBuildSlots = moduleRef.get(ACTIVE_BUILD_SLOTS);
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
      eventModel.deleteMany({}),
      reportModel.deleteMany({}),
    ]);
  });

  // The lowest Greenhouse Farm level such that, starting from just a level-1 Command
  // Center, queuing any single type from `noPrereqTypes` at its first level would NOT trip
  // the Food gate (§4) on its own. Computed against the live `GameConfig` (never a
  // hardcoded number) so this fixture stays correct however `game-core`'s constants get
  // tuned. Checked up to target level 4, not just 1: the race-condition test re-targets
  // the same type at level 2 on its losing side's retry (current level 0 + 1 already
  // queued + 1), so "safe at level 1" alone isn't a strong enough margin. Used by every
  // fixture below that wants "abundant, food-safe" starting buildings.
  const SAFETY_MAX_TARGET_LEVEL = 4;

  function pickFoodSafeGreenhouseLevel(): number {
    const def = config.buildings.greenhouseFarm;
    for (let level = 1; level <= def.maxLevel; level += 1) {
      const buildings: BuildingLevels = [
        { type: 'commandCenter', level: 1 },
        { type: 'greenhouseFarm', level },
      ];
      const allSafe = noPrereqTypes.every((type) =>
        Array.from({ length: SAFETY_MAX_TARGET_LEVEL }, (_, i) => i + 1).every(
          (targetLevel) => !wouldStarveSettlement(config, buildings, type, targetLevel),
        ),
      );
      if (allSafe) {
        return level;
      }
    }
    throw new Error('pickFoodSafeGreenhouseLevel: no safe level found within maxLevel');
  }

  const BARE_BUILDINGS: BuildingLevels = [{ type: 'commandCenter', level: 1 }];

  function foodSafeBuildings(): BuildingLevels {
    return [
      { type: 'commandCenter', level: 1 },
      { type: 'greenhouseFarm', level: pickFoodSafeGreenhouseLevel() },
    ];
  }

  // Generous ceiling for wall-clock time that can elapse between two settle points inside
  // one test (a couple of in-process HTTP round-trips against an in-memory Mongo) — covers
  // even a slow/loaded CI run without masking a real bug, since a real bug (a wrong cost, a
  // missed refund) is orders of magnitude larger than any plausible accrual over a few
  // seconds.
  const MAX_TEST_ELAPSED_MS = 5_000;

  // Asserts `actual` is within the natural production/upkeep drift of `expected`, given
  // `buildings`' own live rates (`calcNetRates` against the current `DEFAULT_CONFIG`, never
  // a hardcoded number or a fixed decimal precision). This is the principled replacement
  // for a fixed-precision `toBeCloseTo` whenever two resource snapshots are compared across
  // two different settle instants: resources settle continuously, and `game-core`'s tuned
  // rates are explicitly a moving target (first-pass values, retuned again in M4) — a bound
  // derived from the config itself stays correct no matter what those numbers are.
  function expectResourcesCloseTo(
    actual: Resources,
    expected: Resources,
    buildings: BuildingLevels,
  ): void {
    const rates = calcNetRates(config, buildings);
    for (const kind of RESOURCE_KINDS) {
      const maxDrift = (Math.abs(rates[kind]) * MAX_TEST_ELAPSED_MS) / HOUR_MS + 1e-6;
      expect(
        Math.abs(actual[kind] - expected[kind]),
        `${kind}: expected ${actual[kind]} to be within ${maxDrift} of ${expected[kind]}`,
      ).toBeLessThanOrEqual(maxDrift);
    }
  }

  interface GuestSession {
    accountId: Types.ObjectId;
    cookie: string[];
  }

  // A fresh guest account + session, via the real `POST /api/auth/guest` endpoint — every
  // settlement route below is ownership-checked (M1b), so exercising them needs a real
  // authenticated caller, not just a settlement document sitting in Mongo.
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

  interface SeedOptions {
    buildings?: Array<{ type: BuildingType; level: number }>;
    resources?: { scrap: number; fuel: number; electronics: number; food: number };
    // Units already away on a movement (M3a.4, §3) — only ever set by the Food-gate-union
    // test below, to prove `trainUnits`'s starvation gate is measured against
    // `upkeepTroopsOf`'s union and not `troops` alone.
    awayTroops?: Array<{ unitType: UnitType; count: number }>;
    // Home troops, seeded directly (god-mode) — only the M3a.6 starvation suite below sets
    // this, to get troops onto a settlement without a real `trainUnits` order per fixture.
    troops?: Array<{ unitType: UnitType; count: number }>;
    // Foreign contingents stationed here as support — god-mode: nothing writes this list yet
    // (the `support` movement is M3c, see `Settlement.stationedTroops`'s own schema
    // comment), so this is the only way to exercise starvation's "guests first" rule ahead
    // of that movement existing. Only the M3a.6 starvation suite below sets this.
    stationedTroops?: Array<{
      ownerAccountId: Types.ObjectId;
      fromSettlementId: Types.ObjectId;
      troops: Array<{ unitType: UnitType; count: number }>;
    }>;
  }

  const ABUNDANT_RESOURCES = {
    scrap: 1_000_000,
    fuel: 1_000_000,
    electronics: 1_000_000,
    food: 1_000_000,
  };

  // On-grid but otherwise arbitrary coordinates — these tests exercise the build-command
  // flow, not placement (see `settlement-creation.integration.spec.ts` for that), so a
  // uniform random pick within the 61×61 grid is enough; each test seeds at most one
  // settlement and `afterEach` clears the collection between tests, so collisions across
  // tests aren't a concern.
  function randomOnGridCoordinate(): number {
    return Math.floor(Math.random() * 61) - 30;
  }

  // Seeds a settlement directly via Mongoose (bypassing the real placement/creation HTTP
  // flow — deliberately, so these fixtures can set arbitrary buildings/resources) owned by
  // `accountId`, which must belong to a real, currently-authenticated account (see
  // `createGuestSession`) for the ownership-checked routes under test to accept it.
  async function seedSettlement(
    accountId: Types.ObjectId,
    options: SeedOptions = {},
  ): Promise<string> {
    const buildingsInput = options.buildings ?? [{ type: 'commandCenter' as const, level: 1 }];
    const settlement = await settlementModel.create({
      accountId,
      name: 'Test Settlement',
      x: randomOnGridCoordinate(),
      y: randomOnGridCoordinate(),
      buildings: buildingsInput.map((b) => ({
        id: randomUUID(),
        type: b.type,
        level: b.level,
        slot: buildingsInput.indexOf(b),
      })),
      resources: {
        values: options.resources ?? ABUNDANT_RESOURCES,
        lastCalcAt: Date.now(),
      },
      buildQueue: [],
      troops: options.troops ?? [],
      awayTroops: options.awayTroops ?? [],
      stationedTroops: options.stationedTroops ?? [],
      version: 0,
    });
    return String(settlement._id);
  }

  function foodSafeSettlement(
    accountId: Types.ObjectId,
    resources = ABUNDANT_RESOURCES,
  ): Promise<string> {
    return seedSettlement(accountId, {
      buildings: foodSafeBuildings().map((b) => ({ ...b })),
      resources,
    });
  }

  // The lowest Greenhouse Farm level whose hourly production alone (bare Command Center plus
  // that farm, no troops) covers at least `minFood` of headroom — the M3a.6 starvation suite's
  // equivalent of `pickFoodSafeGreenhouseLevel` above, but computing a *positive net Food*
  // floor rather than "safe to queue one more building". Mirrors
  // `packages/game-core/src/units/starvation.test.ts`'s own `farmLevelCovering` helper
  // exactly, for the same reason that file needs it: a starvation fixture that can actually
  // *resolve* (some troops survive) needs real headroom to kill into, not just "less deficit
  // than a bare Command Center".
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

  // The M3a.6 starvation suite's own seeding entry point: `buildings` defaults to
  // `BARE_BUILDINGS` (a level-1 Command Center alone already runs a negative net Food — see
  // `STARTING_RESOURCES`'s own comment in `settlements.constants.ts` — so no troops are
  // needed just to get a starving settlement), `food` defaults to 0 (the trigger's other
  // half: stored Food already empty, ready for the tick to fire the instant it's scheduled).
  function starvingSettlement(
    accountId: Types.ObjectId,
    options: {
      buildings?: BuildingLevels;
      food?: number;
      troops?: Array<{ unitType: UnitType; count: number }>;
      awayTroops?: Array<{ unitType: UnitType; count: number }>;
      stationedTroops?: SeedOptions['stationedTroops'];
    } = {},
  ): Promise<string> {
    return seedSettlement(accountId, {
      buildings: (options.buildings ?? BARE_BUILDINGS).map((b) => ({ ...b })),
      resources: {
        scrap: ABUNDANT_RESOURCES.scrap,
        fuel: ABUNDANT_RESOURCES.fuel,
        electronics: ABUNDANT_RESOURCES.electronics,
        food: options.food ?? 0,
      },
      troops: options.troops,
      awayTroops: options.awayTroops,
      stationedTroops: options.stationedTroops,
    });
  }

  // Forces the pending `starvationTick` event for `settlementId` overdue and runs the
  // scheduler once — same determinism trick as `completeQueueItem`/`completeTrainingUnit`.
  // Keyed on `status: 'due'` like `completeTrainingUnit`, so a loop of calls always advances
  // whichever tick is currently pending rather than re-matching an already-`done` one.
  // Returns the forced `dueAt` — the handler chains its own follow-up off `event.dueAt`
  // (never `Date.now()`, §12), so a test asserting an exact chained deadline must anchor its
  // own expectation off the *forced* value, not the event's original pre-forced `dueAt`.
  async function runStarvationTick(settlementId: string): Promise<number> {
    const forcedDueAt = Date.now() - 1_000;
    await eventModel.updateOne(
      { type: 'starvationTick', 'payload.settlementId': settlementId, status: 'due' },
      { $set: { dueAt: forcedDueAt } },
    );
    await schedulerService.runOnce();
    return forcedDueAt;
  }

  function getState(settlementId: string, cookie: string[]) {
    return request(app.getHttpServer())
      .get(`/api/settlements/${settlementId}`)
      .set('Cookie', cookie);
  }

  function postBuild(settlementId: string, cookie: string[], type: string) {
    return request(app.getHttpServer())
      .post(`/api/settlements/${settlementId}/build`)
      .set('Cookie', cookie)
      .send({ type });
  }

  function postCancel(settlementId: string, cookie: string[], queueItemId: string) {
    return request(app.getHttpServer())
      .post(`/api/settlements/${settlementId}/build/${queueItemId}/cancel`)
      .set('Cookie', cookie);
  }

  // Forces a scheduled `buildComplete` event overdue and runs the scheduler once — the
  // same determinism trick `scheduler.integration.spec.ts` uses, so completion doesn't
  // depend on real build-time durations.
  async function completeQueueItem(queueItemId: string): Promise<void> {
    await eventModel.updateOne(
      { type: 'buildComplete', 'payload.queueItemId': queueItemId },
      { $set: { dueAt: Date.now() - 1_000 } },
    );
    await schedulerService.runOnce();
  }

  // A settlement-fixture counter, so every `registerFaction` call below gets a unique
  // display name — `AccountsService.register` enforces name uniqueness, and every test in
  // this file runs against the same shared `accounts` collection until `afterEach` clears it.
  let registeredNameCounter = 0;

  // Turns a fresh guest session into a real, factioned account via the real
  // `POST /api/accounts/register` endpoint (§13 of the M1 record; see
  // `accounts.integration.spec.ts` for the endpoint's own dedicated coverage) — `trainScouts`
  // needs a real `account.faction`, not a guest's `undefined` one, for every case except the
  // "no faction at all" validation test itself.
  async function registerFaction(cookie: string[], faction: Faction): Promise<void> {
    registeredNameCounter += 1;
    const response = await request(app.getHttpServer())
      .post('/api/accounts/register')
      .set('Cookie', cookie)
      .send({ name: `Recruit-${registeredNameCounter}`, faction });
    expect(response.status).toBe(200);
  }

  // Same shape as `foodSafeBuildings()` plus a Barracks at `barracksLevel` — Barracks itself
  // carries zero Food upkeep weight regardless of level
  // (`packages/game-core/src/config/buildings.ts`'s own comment on
  // `barracks.foodUpkeepWeight`), so this fixture is exactly as Food-safe as
  // `foodSafeBuildings()` for scout upkeep on top, up to whatever count each test computes
  // against the live config (never a hardcoded number — see `pickStarvingTrainCount` below).
  function foodSafeBarracksBuildingsAtLevel(barracksLevel: number): BuildingLevels {
    return [...foodSafeBuildings(), { type: 'barracks', level: barracksLevel }];
  }

  function foodSafeBarracksBuildings(): BuildingLevels {
    return foodSafeBarracksBuildingsAtLevel(1);
  }

  function foodSafeBarracksSettlement(
    accountId: Types.ObjectId,
    resources = ABUNDANT_RESOURCES,
  ): Promise<string> {
    return seedSettlement(accountId, {
      buildings: foodSafeBarracksBuildings().map((b) => ({ ...b })),
      resources,
    });
  }

  function foodSafeBarracksSettlementAtLevel(
    accountId: Types.ObjectId,
    barracksLevel: number,
    resources = ABUNDANT_RESOURCES,
  ): Promise<string> {
    return seedSettlement(accountId, {
      buildings: foodSafeBarracksBuildingsAtLevel(barracksLevel).map((b) => ({ ...b })),
      resources,
    });
  }

  // The M3a.5 acceptance criterion's fixture (§2, §20): Barracks *and* Machine Shop both
  // built, so a unit at each can be ordered in the same settlement. Greenhouse Farm pinned
  // at its own `maxLevel` rather than derived to `foodSafeBuildings()`'s tight minimal-safe
  // margin — that margin only accounts for a single no-prereq building's own upkeep weight
  // (see its own comment), not the Machine Shop's nonzero `foodUpkeepWeight` stacked on top
  // *plus* two simultaneous training orders' troop upkeep. A maxed-out farm sidesteps a
  // second, more elaborate safety search for a fixture only ever paired with small, fixed
  // unit counts — a real Food-gate boundary search still runs against the tighter
  // `foodSafeBarracksBuildings()` fixture via `pickStarvingTrainCount` below.
  function wideRosterBuildings(): BuildingLevels {
    return [
      { type: 'commandCenter', level: 1 },
      { type: 'greenhouseFarm', level: config.buildings.greenhouseFarm.maxLevel },
      { type: 'barracks', level: 1 },
      { type: 'machineShop', level: 1 },
    ];
  }

  function wideRosterSettlement(
    accountId: Types.ObjectId,
    resources = ABUNDANT_RESOURCES,
  ): Promise<string> {
    return seedSettlement(accountId, {
      buildings: wideRosterBuildings().map((b) => ({ ...b })),
      resources,
    });
  }

  function postTrain(settlementId: string, cookie: string[], unitType: string, count: number) {
    return request(app.getHttpServer())
      .post(`/api/settlements/${settlementId}/train`)
      .set('Cookie', cookie)
      .send({ unitType, count });
  }

  // Forces the pending `trainingComplete` event for `orderId` overdue and runs the
  // scheduler once — same determinism trick as `completeQueueItem`. Deliberately keyed on
  // `payload.orderId` alone (not also `remainingCountAtSchedule`): the order's *current*
  // event is whichever one is still `due` for that order, and each call in a loop is meant
  // to advance whichever unit is next, without the caller having to track the count itself.
  async function completeTrainingUnit(orderId: string): Promise<void> {
    await eventModel.updateOne(
      { type: 'trainingComplete', 'payload.orderId': orderId, status: 'due' },
      { $set: { dueAt: Date.now() - 1_000 } },
    );
    await schedulerService.runOnce();
  }

  // The minimal `count` such that training `count` of `unitType` on top of `existingTroops`
  // would trip the Food gate (`wouldStarveWithTroops`), derived from the live `GameConfig`
  // rather than a hardcoded number — mirrors `pickFoodSafeGreenhouseLevel`'s own reasoning.
  // `count - 1` is then guaranteed to be the largest order that still fits.
  function pickStarvingTrainCount(
    buildings: BuildingLevels,
    unitType: UnitType,
    existingTroops: ReadonlyArray<{ unitType: UnitType; count: number }> = [],
  ): number {
    for (let count = 1; count <= MAX_TRAIN_COUNT; count += 1) {
      if (wouldStarveWithTroops(config, buildings, existingTroops, [{ unitType, count }])) {
        return count;
      }
    }
    throw new Error('pickStarvingTrainCount: no starving count found within MAX_TRAIN_COUNT');
  }

  it('acceptance criterion: a build starts and completes through the API', async () => {
    const { accountId, cookie } = await createGuestSession();
    const settlementId = await foodSafeSettlement(accountId);
    const type = noPrereqTypes.find((t) => t !== 'greenhouseFarm');
    expect(type).toBeDefined();
    if (!type) throw new Error('unreachable');

    const before = await getState(settlementId, cookie);
    expect(before.status).toBe(200);
    const expectedCost = calcBuildCost(config, type, 1);

    const buildResponse = await postBuild(settlementId, cookie, type);
    expect(buildResponse.status).toBe(200);
    // Deducted exactly the live-derived cost — bounded via the settlement's own rates
    // rather than a fixed decimal precision, since `before` and this response are two
    // separate settle instants.
    const expectedAfterDeduction: Resources = {
      scrap: before.body.resources.values.scrap - expectedCost.scrap,
      fuel: before.body.resources.values.fuel - expectedCost.fuel,
      electronics: before.body.resources.values.electronics - expectedCost.electronics,
      food: before.body.resources.values.food - expectedCost.food,
    };
    expectResourcesCloseTo(
      buildResponse.body.resources.values,
      expectedAfterDeduction,
      foodSafeBuildings(),
    );
    expect(buildResponse.body.buildQueue).toHaveLength(1);
    const queueItem = buildResponse.body.buildQueue[0];
    expect(queueItem.type).toBe(type);
    expect(queueItem.targetLevel).toBe(1);
    expect(queueItem.completesAt).toBeGreaterThan(Date.now());
    expect(queueItem.cost).toMatchObject(expectedCost);

    const scheduledEvent = await eventModel.findOne({
      type: 'buildComplete',
      'payload.queueItemId': queueItem.id,
    });
    expect(scheduledEvent).not.toBeNull();
    expect(scheduledEvent?.status).toBe('due');

    await completeQueueItem(queueItem.id);

    const after = await getState(settlementId, cookie);
    expect(after.status).toBe(200);
    expect(after.body.buildQueue).toHaveLength(0);
    const built = after.body.buildings.find((b: { type: string }) => b.type === type);
    expect(built).toBeDefined();
    expect(built.level).toBe(1);

    const doneEvent = await eventModel.findById(scheduledEvent?._id);
    expect(doneEvent?.status).toBe('done');
  });

  it('prerequisites: a gated building fails with prerequisitesNotMet and charges nothing', async () => {
    const { accountId, cookie } = await createGuestSession();
    const settlementId = await seedSettlement(accountId);
    const before = await getState(settlementId, cookie);

    const response = await postBuild(settlementId, cookie, 'barracks');

    expect(response.status).toBe(400);
    expect(response.body.error.key).toBe('errors.build.prerequisitesNotMet');
    const after = await getState(settlementId, cookie);
    // scrap/fuel/electronics have no producer built (bare Command Center only), so their
    // rate is exactly 0 and they're bit-exact; food has a nonzero (negative) rate from the
    // bare Command Center's own upkeep with no Greenhouse Farm offsetting it, so it
    // naturally drifts between the two `getState` calls even though the rejected build
    // itself charged nothing — bounded via the settlement's own live rate, not a fixed
    // decimal precision (see `expectResourcesCloseTo`'s comment).
    expectResourcesCloseTo(
      after.body.resources.values,
      before.body.resources.values,
      BARE_BUILDINGS,
    );
    expect(after.body.buildQueue).toHaveLength(0);
  });

  it('queue limit: a 4th simultaneous enqueue fails with queueFull', async () => {
    const { accountId, cookie } = await createGuestSession();
    const settlementId = await foodSafeSettlement(accountId);
    const candidates = noPrereqTypes.filter((t) => t !== 'greenhouseFarm').slice(0, 4);
    expect(candidates.length).toBe(4);

    const capacity = activeBuildSlots + WAITING_QUEUE_SLOTS;
    for (let i = 0; i < capacity; i += 1) {
      const candidate = candidates[i];
      expect(candidate).toBeDefined();
      if (!candidate) throw new Error('unreachable');
      const response = await postBuild(settlementId, cookie, candidate);
      expect(response.status).toBe(200);
    }

    const overflowType = candidates[capacity];
    expect(overflowType).toBeDefined();
    if (!overflowType) throw new Error('unreachable');
    const response = await postBuild(settlementId, cookie, overflowType);
    expect(response.status).toBe(400);
    expect(response.body.error.key).toBe('errors.build.queueFull');

    const state = await getState(settlementId, cookie);
    expect(state.body.buildQueue).toHaveLength(capacity);
  });

  it('affordability: an unaffordable build fails with insufficientResources and charges nothing', async () => {
    const { accountId, cookie } = await createGuestSession();
    // Food-safe (a Greenhouse Farm already built), but zero stored resources — isolates
    // the affordability gate from the Food gate, which a bare Command-Center-only
    // settlement would trip first for most types (see the Food gate test below).
    const settlementId = await foodSafeSettlement(accountId, {
      scrap: 0,
      fuel: 0,
      electronics: 0,
      food: 0,
    });
    const type = noPrereqTypes.find((t) => t !== 'greenhouseFarm');
    expect(type).toBeDefined();
    if (!type) throw new Error('unreachable');

    const response = await postBuild(settlementId, cookie, type);

    expect(response.status).toBe(400);
    expect(response.body.error.key).toBe('errors.build.insufficientResources');
    const state = await getState(settlementId, cookie);
    expect(state.body.buildQueue).toHaveLength(0);
    // scrap/fuel/electronics stay exactly 0 (no producer of any of them is built); food may
    // have accrued a small amount from the Greenhouse Farm in the wall-clock gap between
    // seeding and this request — bounded via the settlement's own live rate (see
    // `expectResourcesCloseTo`), not a hardcoded "< 1" that a retuned production rate could
    // outrun.
    expectResourcesCloseTo(
      state.body.resources.values,
      { scrap: 0, fuel: 0, electronics: 0, food: 0 },
      foodSafeBuildings(),
    );
  });

  it('the Food gate: a build that would push net Food negative fails with wouldStarve', async () => {
    // Only Command Center — no Greenhouse Farm — so its own Food upkeep alone already
    // outweighs any building with no Food production, tripping the gate deterministically
    // (verified against the live config, not assumed).
    const { accountId, cookie } = await createGuestSession();
    const settlementId = await seedSettlement(accountId);
    const starvingType = noPrereqTypes.find(
      (t) =>
        t !== 'greenhouseFarm' &&
        wouldStarveSettlement(config, [{ type: 'commandCenter', level: 1 }], t, 1),
    );
    expect(starvingType).toBeDefined();
    if (!starvingType) throw new Error('unreachable');

    const response = await postBuild(settlementId, cookie, starvingType);

    expect(response.status).toBe(400);
    expect(response.body.error.key).toBe('errors.build.wouldStarve');
    const state = await getState(settlementId, cookie);
    expect(state.body.buildQueue).toHaveLength(0);
  });

  it('cancel: refunds 100%, removes the item, and promotes the next waiting item', async () => {
    const { accountId, cookie } = await createGuestSession();
    const settlementId = await foodSafeSettlement(accountId);
    const [firstType, secondType] = noPrereqTypes.filter((t) => t !== 'greenhouseFarm');
    expect(firstType).toBeDefined();
    expect(secondType).toBeDefined();
    if (!firstType || !secondType) throw new Error('unreachable');

    const firstBuild = await postBuild(settlementId, cookie, firstType);
    expect(firstBuild.status).toBe(200);
    const afterSecond = await postBuild(settlementId, cookie, secondType);
    expect(afterSecond.status).toBe(200);

    const activeItem = afterSecond.body.buildQueue.find(
      (i: { startedAt: number | null }) => i.startedAt !== null,
    );
    const waitingItem = afterSecond.body.buildQueue.find(
      (i: { startedAt: number | null }) => i.startedAt === null,
    );
    expect(activeItem).toBeDefined();
    expect(waitingItem).toBeDefined();

    const activeEventBefore = await eventModel.findOne({
      type: 'buildComplete',
      'payload.queueItemId': activeItem.id,
    });
    expect(activeEventBefore).not.toBeNull();

    const cancelResponse = await postCancel(settlementId, cookie, activeItem.id);
    expect(cancelResponse.status).toBe(200);

    // Refunded exactly 100% of the cancelled (active) item's own cost, on top of whatever
    // the balance was right before cancelling — not compared to `afterFirst`, since the two
    // builds are different types with different costs. Bounded via the settlement's own
    // live rates rather than a fixed decimal precision, since cancel's own settle step
    // advances the clock again between `afterSecond` and this response.
    const expectedRefunded: Resources = {
      scrap: afterSecond.body.resources.values.scrap + activeItem.cost.scrap,
      fuel: afterSecond.body.resources.values.fuel + activeItem.cost.fuel,
      electronics: afterSecond.body.resources.values.electronics + activeItem.cost.electronics,
      food: afterSecond.body.resources.values.food + activeItem.cost.food,
    };
    expectResourcesCloseTo(
      cancelResponse.body.resources.values,
      expectedRefunded,
      foodSafeBuildings(),
    );
    expect(cancelResponse.body.buildQueue).toHaveLength(1);
    const promoted = cancelResponse.body.buildQueue[0];
    expect(promoted.id).toBe(waitingItem.id);
    expect(promoted.startedAt).not.toBeNull();
    expect(promoted.completesAt).not.toBeNull();

    const cancelledEvent = await eventModel.findById(activeEventBefore?._id);
    expect(cancelledEvent).toBeNull();
    const promotedEvent = await eventModel.findOne({
      type: 'buildComplete',
      'payload.queueItemId': promoted.id,
    });
    expect(promotedEvent).not.toBeNull();
  });

  it('idempotency: replaying the buildComplete handler for the same event increments the level only once', async () => {
    const { accountId, cookie } = await createGuestSession();
    const settlementId = await foodSafeSettlement(accountId);
    const type = noPrereqTypes.find((t) => t !== 'greenhouseFarm');
    expect(type).toBeDefined();
    if (!type) throw new Error('unreachable');

    const buildResponse = await postBuild(settlementId, cookie, type);
    const queueItemId = buildResponse.body.buildQueue[0].id;
    const event = await eventModel.findOne({
      type: 'buildComplete',
      'payload.queueItemId': queueItemId,
    });
    expect(event).not.toBeNull();
    if (!event) throw new Error('unreachable');
    // Narrowed to a fresh binding: a nested function declaration doesn't retain the
    // surrounding `if (!event) throw` narrowing from TypeScript's point of view.
    const confirmedEvent = event;

    async function replay(): Promise<void> {
      const session = await connection.startSession();
      try {
        await session.withTransaction(async () => {
          await buildCompleteHandler.handle(confirmedEvent, session);
        });
      } finally {
        await session.endSession();
      }
    }

    await replay();
    const afterFirst = await settlementModel.findById(settlementId);
    const builtAfterFirst = afterFirst?.buildings.find((b) => b.type === type);
    expect(builtAfterFirst?.level).toBe(1);
    expect(afterFirst?.buildQueue).toHaveLength(0);

    await replay();
    const afterSecond = await settlementModel.findById(settlementId);
    const builtAfterSecond = afterSecond?.buildings.find((b) => b.type === type);
    expect(builtAfterSecond?.level).toBe(1);
    expect(afterSecond?.buildQueue).toHaveLength(0);
  });

  it('the race: two concurrent startBuild calls that can only afford one — exactly one succeeds, resources never go negative', async () => {
    const { accountId, cookie } = await createGuestSession();
    const type = noPrereqTypes.find((t) => t !== 'greenhouseFarm');
    expect(type).toBeDefined();
    if (!type) throw new Error('unreachable');
    const cost = calcBuildCost(config, type, 1);
    const settlementId = await foodSafeSettlement(accountId, {
      ...cost,
      food: ABUNDANT_RESOURCES.food,
    });

    const [responseA, responseB] = await Promise.all([
      postBuild(settlementId, cookie, type),
      postBuild(settlementId, cookie, type),
    ]);

    const statuses = [responseA.status, responseB.status].sort();
    expect(statuses).toEqual([200, 400]);
    const failure = responseA.status === 400 ? responseA : responseB;
    expect(failure.body.error.key).toBe('errors.build.insufficientResources');

    const state = await settlementModel.findById(settlementId);
    expect(state).not.toBeNull();
    if (!state) throw new Error('unreachable');
    for (const kind of ['scrap', 'fuel', 'electronics', 'food'] as const) {
      expect(state.resources.values[kind]).toBeGreaterThanOrEqual(0);
    }
    expect(state.buildQueue).toHaveLength(1);
  });

  it('queue ordering: with one active slot, the second item does not start until the first completes', async () => {
    const { accountId, cookie } = await createGuestSession();
    const settlementId = await foodSafeSettlement(accountId);
    const [firstType, secondType] = noPrereqTypes.filter((t) => t !== 'greenhouseFarm');
    expect(firstType).toBeDefined();
    expect(secondType).toBeDefined();
    if (!firstType || !secondType) throw new Error('unreachable');

    const afterFirst = await postBuild(settlementId, cookie, firstType);
    const afterSecond = await postBuild(settlementId, cookie, secondType);
    const firstItem = afterFirst.body.buildQueue[0];
    const secondItem = afterSecond.body.buildQueue.find(
      (i: { id: string }) => i.id !== firstItem.id,
    );
    expect(firstItem.startedAt).not.toBeNull();
    expect(secondItem.startedAt).toBeNull();
    expect(secondItem.completesAt).toBeNull();

    await completeQueueItem(firstItem.id);

    const state = await getState(settlementId, cookie);
    expect(state.body.buildQueue).toHaveLength(1);
    const promoted = state.body.buildQueue[0];
    expect(promoted.id).toBe(secondItem.id);
    expect(promoted.startedAt).not.toBeNull();
    expect(promoted.completesAt).not.toBeNull();
  });

  describe('M3c.5b: the build-queue rule — a knocked building does not get a free jump (§7)', () => {
    // `docs/M3_DESIGN_DECISIONS.md` §7: "on completion the handler sets `level =
    // min(item.targetLevel, currentLevel + 1)`, so a queued '→ L8' that finds the building at
    // L5 [knocked down by a siege pass mid-build] delivers L6, not a free three-level jump."
    // The siege pass itself is `BattleArrivalResolver`'s own concern
    // (`movements.integration.spec.ts`'s M3c.5b suite) — this suite only proves
    // `BuildCompleteHandler` honours the rule regardless of *why* the building's level moved
    // between enqueue and completion, so a direct Mongoose downgrade stands in for "a siege
    // pass landed mid-build" without needing a real battle.
    //
    // Maxed Greenhouse Farm headroom, not `foodSafeBuildings()`: that helper is only proven
    // safe for a *fresh* build up to `SAFETY_MAX_TARGET_LEVEL` (4) — these fixtures queue an
    // existing L7 building up to L8, well past that margin.
    function siegeRuleBuildings(type: BuildingType): BuildingLevels {
      return [
        { type: 'commandCenter', level: 1 },
        { type: 'greenhouseFarm', level: config.buildings.greenhouseFarm.maxLevel },
        { type, level: 7 },
      ];
    }

    it('a queued upgrade to L8 whose building sits at L5 when the event fires delivers L6, not L8', async () => {
      const { accountId, cookie } = await createGuestSession();
      const type = noPrereqTypes.find((t) => t !== 'greenhouseFarm');
      expect(type).toBeDefined();
      if (!type) throw new Error('unreachable');

      const settlementId = await seedSettlement(accountId, {
        buildings: siegeRuleBuildings(type).map((b) => ({ ...b })) as Array<{
          type: BuildingType;
          level: number;
        }>,
        resources: ABUNDANT_RESOURCES,
      });

      const buildResponse = await postBuild(settlementId, cookie, type);
      expect(buildResponse.status).toBe(200);
      const queueItem = buildResponse.body.buildQueue[0];
      expect(queueItem.targetLevel).toBe(8);

      // Stands in for a siege pass knocking the building down mid-build — `completesAt` is
      // fixed at enqueue (M1) and is deliberately left untouched here; only the level landed
      // at completion should be affected.
      await settlementModel.updateOne(
        { _id: settlementId, 'buildings.type': type },
        { $set: { 'buildings.$.level': 5 } },
      );

      await completeQueueItem(queueItem.id);

      const after = await settlementModel.findById(settlementId);
      const built = after?.buildings.find((b) => b.type === type);
      expect(built?.level).toBe(6);
      expect(after?.buildQueue).toHaveLength(0);
    });

    it('an ordinary upgrade — nothing destroyed meanwhile — still delivers its exact target level', async () => {
      const { accountId, cookie } = await createGuestSession();
      const type = noPrereqTypes.find((t) => t !== 'greenhouseFarm');
      expect(type).toBeDefined();
      if (!type) throw new Error('unreachable');

      const settlementId = await seedSettlement(accountId, {
        buildings: siegeRuleBuildings(type).map((b) => ({ ...b })) as Array<{
          type: BuildingType;
          level: number;
        }>,
        resources: ABUNDANT_RESOURCES,
      });

      const buildResponse = await postBuild(settlementId, cookie, type);
      expect(buildResponse.status).toBe(200);
      const queueItem = buildResponse.body.buildQueue[0];
      expect(queueItem.targetLevel).toBe(8);

      await completeQueueItem(queueItem.id);

      const after = await settlementModel.findById(settlementId);
      const built = after?.buildings.find((b) => b.type === type);
      expect(built?.level).toBe(8);
      expect(after?.buildQueue).toHaveLength(0);
    });
  });

  it('unauthenticated: every settlement route rejects a request with no session cookie', async () => {
    const { accountId } = await createGuestSession();
    const settlementId = await seedSettlement(accountId);

    const response = await request(app.getHttpServer()).get(`/api/settlements/${settlementId}`);

    expect(response.status).toBe(401);
    expect(response.body.error.key).toBe('errors.auth.notAuthenticated');
  });

  it('ownership: account A cannot read or command account B settlement', async () => {
    const owner = await createGuestSession();
    const intruder = await createGuestSession();
    const settlementId = await foodSafeSettlement(owner.accountId);
    const type = noPrereqTypes.find((t) => t !== 'greenhouseFarm');
    expect(type).toBeDefined();
    if (!type) throw new Error('unreachable');

    const readAsIntruder = await getState(settlementId, intruder.cookie);
    expect(readAsIntruder.status).toBe(404);
    expect(readAsIntruder.body.error.key).toBe('errors.settlement.notFound');

    const buildAsIntruder = await postBuild(settlementId, intruder.cookie, type);
    expect(buildAsIntruder.status).toBe(404);
    expect(buildAsIntruder.body.error.key).toBe('errors.settlement.notFound');

    // The owner's own session still works — confirms the 404 above is really an
    // ownership check, not the settlement being broken/missing.
    const readAsOwner = await getState(settlementId, owner.cookie);
    expect(readAsOwner.status).toBe(200);
  });

  it('dev seed: creates an account + an on-grid, level-1 Command Center settlement, blocked in production', async () => {
    const response = await request(app.getHttpServer()).post('/api/dev/seed-settlement').send({});
    expect(response.status).toBe(201);
    const settlementId = response.body.settlementId as string;
    expect(Types.ObjectId.isValid(settlementId)).toBe(true);
    const settlement = await settlementModel.findById(settlementId);
    expect(settlement?.buildings).toEqual([
      expect.objectContaining({ type: 'commandCenter', level: 1 }),
    ]);
    // The bug this rework fixed: the pre-M1b dev seeder placed settlements far outside the
    // 61×61 grid (e.g. `x: 28418, y: 79586`) because it generated raw random coordinates
    // instead of going through `PlacementService`.
    expect(settlement?.x).toBeGreaterThanOrEqual(-30);
    expect(settlement?.x).toBeLessThanOrEqual(30);
    expect(settlement?.y).toBeGreaterThanOrEqual(-30);
    expect(settlement?.y).toBeLessThanOrEqual(30);

    const previousNodeEnv = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      const blocked = await request(app.getHttpServer()).post('/api/dev/seed-settlement').send({});
      expect(blocked.status).toBe(404);
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env['NODE_ENV'];
      } else {
        process.env['NODE_ENV'] = previousNodeEnv;
      }
    }
  });

  // M2b.2: the training command, unit-by-unit completion, and troop Food upkeep. Widened
  // in M3a.5 (`docs/M3_DESIGN_DECISIONS.md` §2) from `trainScouts` (one Barracks scout order
  // per settlement) to `trainUnits` (the full roster, three training buildings, one active
  // order per building). Nested in the same file/describe (shares `beforeAll`'s app/DB boot
  // and every helper above) rather than a separate spec file — same convention the
  // build-command tests above already establish for this module.
  describe('Unit training (M2b.2 → M3a.5)', () => {
    const RAIDER_FACTION: Faction = 'raiders';
    // Derived from the live config, never hardcoded as `'lookout'` — see every other
    // fixture in this file for the same "derive, don't hardcode" convention.
    const raiderScout = scoutUnitForFaction(config, RAIDER_FACTION).type;
    // Any Machine Shop unit works for the "two buildings in parallel" acceptance criterion —
    // catalogue order's first entry (`unitsTrainableAt`, §2) rather than hardcoding `'biker'`.
    const raiderMachineShopUnitDef = unitsTrainableAt(config, 'machineShop', RAIDER_FACTION)[0];
    if (!raiderMachineShopUnitDef) {
      throw new Error('fixture error: raiders have no Machine Shop unit in the catalogue');
    }
    const raiderMachineShopUnit = raiderMachineShopUnitDef.type;
    // The one faction-neutral unit (§1) — a real catalogue key, not a magic string; see the
    // Settler test below for why this is asserted directly rather than derived.
    const SETTLER: UnitType = 'settler';

    it('happy path: resources deducted at enqueue, units credited one at a time, Food upkeep drops', async () => {
      const { accountId, cookie } = await createGuestSession();
      await registerFaction(cookie, RAIDER_FACTION);
      const settlementId = await foodSafeBarracksSettlement(accountId);

      const before = await getState(settlementId, cookie);
      expect(before.status).toBe(200);
      expect(before.body.troops).toEqual([]);
      const trainCount = 3;
      const expectedCost = calcTrainCost(config, raiderScout, trainCount);

      const trainResponse = await postTrain(settlementId, cookie, raiderScout, trainCount);
      expect(trainResponse.status).toBe(200);
      const expectedAfterDeduction: Resources = {
        scrap: before.body.resources.values.scrap - expectedCost.scrap,
        fuel: before.body.resources.values.fuel - expectedCost.fuel,
        electronics: before.body.resources.values.electronics - expectedCost.electronics,
        food: before.body.resources.values.food - expectedCost.food,
      };
      expectResourcesCloseTo(
        trainResponse.body.resources.values,
        expectedAfterDeduction,
        foodSafeBarracksBuildings(),
      );
      expect(trainResponse.body.trainingQueue).toHaveLength(1);
      const order = trainResponse.body.trainingQueue[0];
      expect(order.unitType).toBe(raiderScout);
      expect(order.totalCount).toBe(trainCount);
      expect(order.remainingCount).toBe(trainCount);
      expect(order.cost).toMatchObject(expectedCost);
      expect(order.nextCompletesAt).toBeGreaterThan(Date.now());
      expect(trainResponse.body.troops).toEqual([]);

      const scheduledEvent = await eventModel.findOne({
        type: 'trainingComplete',
        'payload.orderId': order.id,
      });
      expect(scheduledEvent).not.toBeNull();
      expect(scheduledEvent?.status).toBe('due');

      // Complete the first unit and assert the INTERMEDIATE state (not just the end
      // state) — this is the M2b.2 acceptance criterion: units land one at a time, and
      // Food upkeep visibly drops the moment the first scout is credited, derived from
      // `calcTroopFoodUpkeepPerHour`, never a hardcoded number.
      await completeTrainingUnit(order.id);
      const afterFirst = await getState(settlementId, cookie);
      expect(afterFirst.status).toBe(200);
      expect(afterFirst.body.troops).toEqual([{ unitType: raiderScout, count: 1 }]);
      expect(afterFirst.body.trainingQueue).toHaveLength(1);
      expect(afterFirst.body.trainingQueue[0].remainingCount).toBe(trainCount - 1);
      expect(afterFirst.body.trainingQueue[0].totalCount).toBe(trainCount);
      const expectedNetFoodAfterFirst =
        before.body.netFoodPerHour -
        calcTroopFoodUpkeepPerHour(config, [{ unitType: raiderScout, count: 1 }]);
      expect(afterFirst.body.netFoodPerHour).toBeCloseTo(expectedNetFoodAfterFirst, 6);

      // Drive the remaining two units to completion, one event at a time.
      await completeTrainingUnit(order.id);
      await completeTrainingUnit(order.id);

      const after = await getState(settlementId, cookie);
      expect(after.status).toBe(200);
      expect(after.body.troops).toEqual([{ unitType: raiderScout, count: trainCount }]);
      expect(after.body.trainingQueue).toHaveLength(0);
      const expectedNetFoodAfterAll =
        before.body.netFoodPerHour -
        calcTroopFoodUpkeepPerHour(config, [{ unitType: raiderScout, count: trainCount }]);
      expect(after.body.netFoodPerHour).toBeCloseTo(expectedNetFoodAfterAll, 6);

      const doneEvent = await eventModel.findById(scheduledEvent?._id);
      expect(doneEvent?.status).toBe('done');
    });

    it('the Food gate: a batch that would push net Food negative is rejected with wouldStarve; a smaller batch is accepted', async () => {
      const { accountId, cookie } = await createGuestSession();
      await registerFaction(cookie, RAIDER_FACTION);
      const buildings = foodSafeBarracksBuildings();
      const starvingCount = pickStarvingTrainCount(buildings, raiderScout);
      const settlementId = await foodSafeBarracksSettlement(accountId);

      const starvingResponse = await postTrain(settlementId, cookie, raiderScout, starvingCount);
      expect(starvingResponse.status).toBe(400);
      expect(starvingResponse.body.error.key).toBe('errors.training.wouldStarve');
      const afterStarving = await getState(settlementId, cookie);
      expect(afterStarving.body.trainingQueue).toHaveLength(0);

      const safeCount = starvingCount - 1;
      expect(safeCount).toBeGreaterThan(0);
      const safeResponse = await postTrain(settlementId, cookie, raiderScout, safeCount);
      expect(safeResponse.status).toBe(200);
      expect(safeResponse.body.trainingQueue).toHaveLength(1);
      expect(safeResponse.body.trainingQueue[0].totalCount).toBe(safeCount);
    });

    it('validation: an unrecognised unit type is rejected with unknownType and charges nothing', async () => {
      const { accountId, cookie } = await createGuestSession();
      await registerFaction(cookie, RAIDER_FACTION);
      const settlementId = await foodSafeBarracksSettlement(accountId);
      const before = await getState(settlementId, cookie);

      const response = await postTrain(settlementId, cookie, 'notARealUnit', 1);

      expect(response.status).toBe(400);
      expect(response.body.error.key).toBe('errors.training.unknownType');
      const after = await getState(settlementId, cookie);
      expectResourcesCloseTo(
        after.body.resources.values,
        before.body.resources.values,
        foodSafeBarracksBuildings(),
      );
      expect(after.body.trainingQueue).toHaveLength(0);
    });

    it("validation: training another faction's unit is rejected with wrongFaction and charges nothing", async () => {
      const { accountId, cookie } = await createGuestSession();
      await registerFaction(cookie, RAIDER_FACTION);
      const settlementId = await foodSafeBarracksSettlement(accountId);
      const before = await getState(settlementId, cookie);
      const otherFactionScout = scoutUnitForFaction(config, 'nomads').type;

      const response = await postTrain(settlementId, cookie, otherFactionScout, 1);

      expect(response.status).toBe(400);
      expect(response.body.error.key).toBe('errors.training.wrongFaction');
      expect(response.body.error.params).toMatchObject({
        unitType: otherFactionScout,
        faction: RAIDER_FACTION,
      });
      const after = await getState(settlementId, cookie);
      expectResourcesCloseTo(
        after.body.resources.values,
        before.body.resources.values,
        foodSafeBarracksBuildings(),
      );
      expect(after.body.trainingQueue).toHaveLength(0);
    });

    it('validation: a wildlife unit type (no trainedIn at all) is rejected with the same wrongFaction key', async () => {
      const { accountId, cookie } = await createGuestSession();
      await registerFaction(cookie, RAIDER_FACTION);
      const settlementId = await foodSafeBarracksSettlement(accountId);
      const before = await getState(settlementId, cookie);

      // `feralDog` has no `trainedIn` at all (§1) — `canFactionTrain` rejects it via the
      // same check (3) and the same key as an off-faction unit; there is deliberately no
      // separate "untrainable" key (see `SettlementsService.trainUnits`'s own comment).
      const response = await postTrain(settlementId, cookie, 'feralDog', 1);

      expect(response.status).toBe(400);
      expect(response.body.error.key).toBe('errors.training.wrongFaction');
      const after = await getState(settlementId, cookie);
      expectResourcesCloseTo(
        after.body.resources.values,
        before.body.resources.values,
        foodSafeBarracksBuildings(),
      );
      expect(after.body.trainingQueue).toHaveLength(0);
    });

    it('validation: a guest with no faction at all is rejected with noFaction and charges nothing', async () => {
      const { accountId, cookie } = await createGuestSession();
      const settlementId = await foodSafeBarracksSettlement(accountId);
      const before = await getState(settlementId, cookie);

      const response = await postTrain(settlementId, cookie, raiderScout, 1);

      expect(response.status).toBe(400);
      expect(response.body.error.key).toBe('errors.training.noFaction');
      const after = await getState(settlementId, cookie);
      expectResourcesCloseTo(
        after.body.resources.values,
        before.body.resources.values,
        foodSafeBarracksBuildings(),
      );
      expect(after.body.trainingQueue).toHaveLength(0);
    });

    it('validation: count 0/negative/non-integer/over-the-cap are each rejected with invalidCount and charge nothing', async () => {
      const { accountId, cookie } = await createGuestSession();
      await registerFaction(cookie, RAIDER_FACTION);
      const settlementId = await foodSafeBarracksSettlement(accountId);
      const before = await getState(settlementId, cookie);

      for (const badCount of [0, -1, 1.5, MAX_TRAIN_COUNT + 1]) {
        const response = await postTrain(settlementId, cookie, raiderScout, badCount);
        expect(response.status, `count=${badCount}`).toBe(400);
        expect(response.body.error.key, `count=${badCount}`).toBe('errors.training.invalidCount');
      }

      const after = await getState(settlementId, cookie);
      expectResourcesCloseTo(
        after.body.resources.values,
        before.body.resources.values,
        foodSafeBarracksBuildings(),
      );
      expect(after.body.trainingQueue).toHaveLength(0);
    });

    it('validation: training at a building that is not built is rejected with buildingMissing and the right building param, and charges nothing', async () => {
      const { accountId, cookie } = await createGuestSession();
      await registerFaction(cookie, RAIDER_FACTION);
      // No Barracks *and* no Machine Shop — exercises the check for both training buildings
      // a real settlement can lack, not just the Barracks.
      const settlementId = await foodSafeSettlement(accountId);
      const before = await getState(settlementId, cookie);

      const barracksResponse = await postTrain(settlementId, cookie, raiderScout, 1);
      expect(barracksResponse.status).toBe(400);
      expect(barracksResponse.body.error.key).toBe('errors.training.buildingMissing');
      expect(barracksResponse.body.error.params.building).toBe('barracks');

      const machineShopResponse = await postTrain(settlementId, cookie, raiderMachineShopUnit, 1);
      expect(machineShopResponse.status).toBe(400);
      expect(machineShopResponse.body.error.key).toBe('errors.training.buildingMissing');
      expect(machineShopResponse.body.error.params.building).toBe('machineShop');

      const after = await getState(settlementId, cookie);
      expectResourcesCloseTo(
        after.body.resources.values,
        before.body.resources.values,
        foodSafeBuildings(),
      );
      expect(after.body.trainingQueue).toHaveLength(0);
    });

    it('validation: insufficient resources is rejected with insufficientResources and charges nothing', async () => {
      const { accountId, cookie } = await createGuestSession();
      await registerFaction(cookie, RAIDER_FACTION);
      const zero = { scrap: 0, fuel: 0, electronics: 0, food: 0 };
      const settlementId = await foodSafeBarracksSettlement(accountId, zero);

      const response = await postTrain(settlementId, cookie, raiderScout, 1);

      expect(response.status).toBe(400);
      expect(response.body.error.key).toBe('errors.training.insufficientResources');
      const state = await getState(settlementId, cookie);
      expect(state.body.trainingQueue).toHaveLength(0);
      expectResourcesCloseTo(state.body.resources.values, zero, foodSafeBarracksBuildings());
    });

    it('one active order per building: a second order at the same building while one is running is rejected with queueBusy', async () => {
      const { accountId, cookie } = await createGuestSession();
      await registerFaction(cookie, RAIDER_FACTION);
      const settlementId = await foodSafeBarracksSettlement(accountId);

      const first = await postTrain(settlementId, cookie, raiderScout, 1);
      expect(first.status).toBe(200);

      const second = await postTrain(settlementId, cookie, raiderScout, 1);
      expect(second.status).toBe(400);
      expect(second.body.error.key).toBe('errors.training.queueBusy');
      expect(second.body.error.params.building).toBe('barracks');

      const state = await getState(settlementId, cookie);
      expect(state.body.trainingQueue).toHaveLength(1);
      // Only the first order's cost was ever deducted — bounded via the settlement's own
      // live rates, since two separate settle instants sit between `first` and this
      // `getState` call (see `expectResourcesCloseTo`'s comment).
      const singleOrderCost = calcTrainCost(config, raiderScout, 1);
      const expectedAfterOneDeduction: Resources = {
        scrap: ABUNDANT_RESOURCES.scrap - singleOrderCost.scrap,
        fuel: ABUNDANT_RESOURCES.fuel - singleOrderCost.fuel,
        electronics: ABUNDANT_RESOURCES.electronics - singleOrderCost.electronics,
        food: ABUNDANT_RESOURCES.food - singleOrderCost.food,
      };
      expectResourcesCloseTo(
        state.body.resources.values,
        expectedAfterOneDeduction,
        foodSafeBarracksBuildings(),
      );
    });

    it('acceptance criterion (§20): a Barracks order and a Machine Shop order run simultaneously, and each building still caps at one active order', async () => {
      const { accountId, cookie } = await createGuestSession();
      await registerFaction(cookie, RAIDER_FACTION);
      const settlementId = await wideRosterSettlement(accountId);

      const barracksResponse = await postTrain(settlementId, cookie, raiderScout, 1);
      expect(barracksResponse.status).toBe(200);
      expect(barracksResponse.body.trainingQueue).toHaveLength(1);

      // Still running — proves the Barracks order didn't block the Machine Shop order, the
      // acceptance criterion itself.
      const machineShopResponse = await postTrain(settlementId, cookie, raiderMachineShopUnit, 1);
      expect(machineShopResponse.status).toBe(200);
      expect(machineShopResponse.body.trainingQueue).toHaveLength(2);

      // Parallelism is per building, not unlimited (§2): a second order at either
      // already-busy building is still rejected.
      const secondBarracks = await postTrain(settlementId, cookie, raiderScout, 1);
      expect(secondBarracks.status).toBe(400);
      expect(secondBarracks.body.error.key).toBe('errors.training.queueBusy');
      expect(secondBarracks.body.error.params.building).toBe('barracks');

      const secondMachineShop = await postTrain(settlementId, cookie, raiderMachineShopUnit, 1);
      expect(secondMachineShop.status).toBe(400);
      expect(secondMachineShop.body.error.key).toBe('errors.training.queueBusy');
      expect(secondMachineShop.body.error.params.building).toBe('machineShop');

      const state = await getState(settlementId, cookie);
      expect(state.body.trainingQueue).toHaveLength(2);
      const buildingsInQueue = (state.body.trainingQueue as Array<{ unitType: UnitType }>)
        .map((item) => config.units[item.unitType].trainedIn)
        .sort();
      expect(buildingsInQueue).toEqual(['barracks', 'machineShop']);
    });

    it('the Settler is faction-neutral: every faction can train one at the Command Center, no extra level requirement beyond the level-1 every settlement already has (§1/§2)', async () => {
      for (const faction of FACTIONS) {
        const { accountId, cookie } = await createGuestSession();
        await registerFaction(cookie, faction);
        // The Settler is expensive (900 scrap / 700 fuel / 400 electronics / 500 food) — a
        // bare `foodSafeSettlement` (Command Center L1 + a food-safe Greenhouse Farm) with
        // `ABUNDANT_RESOURCES` covers it comfortably.
        const settlementId = await foodSafeSettlement(accountId);

        const response = await postTrain(settlementId, cookie, SETTLER, 1);

        expect(response.status, `faction=${faction}`).toBe(200);
        expect(response.body.trainingQueue, `faction=${faction}`).toHaveLength(1);
        expect(response.body.trainingQueue[0].unitType, `faction=${faction}`).toBe(SETTLER);
      }
    });

    it('the Food gate is measured against the union including awayTroops, not home troops alone (M3a.4, §3)', async () => {
      const { accountId, cookie } = await createGuestSession();
      await registerFaction(cookie, RAIDER_FACTION);
      const buildings = foodSafeBarracksBuildings();
      const starvingCount = pickStarvingTrainCount(buildings, raiderScout);
      // A meaningful margin to split between "already away" and "one more at home" below —
      // guards against a degenerate config where even a single scout alone would starve.
      expect(starvingCount).toBeGreaterThan(1);
      const awayCount = starvingCount - 1;

      // Sanity checks against the live formula directly (not just the HTTP outcome): with
      // zero existing troops, training 1 more is safe; with `awayCount` already away,
      // training 1 more tips it over — proving the settlement below starves specifically
      // *because* of the awayTroops union, not despite it.
      expect(
        wouldStarveWithTroops(config, buildings, [], [{ unitType: raiderScout, count: 1 }]),
      ).toBe(false);
      expect(
        wouldStarveWithTroops(
          config,
          buildings,
          [{ unitType: raiderScout, count: awayCount }],
          [{ unitType: raiderScout, count: 1 }],
        ),
      ).toBe(true);

      const settlementId = await seedSettlement(accountId, {
        buildings: buildings.map((b) => ({ ...b })),
        resources: ABUNDANT_RESOURCES,
        awayTroops: [{ unitType: raiderScout, count: awayCount }],
      });

      const response = await postTrain(settlementId, cookie, raiderScout, 1);

      expect(response.status).toBe(400);
      expect(response.body.error.key).toBe('errors.training.wouldStarve');
      const state = await getState(settlementId, cookie);
      expect(state.body.trainingQueue).toHaveLength(0);
      expect(state.body.awayTroops).toEqual([{ unitType: raiderScout, count: awayCount }]);
    });

    it("a training order's unitTrainTimeMs derives from the training building's own level, not a flat level-1 assumption (M3a.2/§2)", async () => {
      const { accountId, cookie } = await createGuestSession();
      await registerFaction(cookie, RAIDER_FACTION);
      const barracksLevel = 5;
      const settlementId = await foodSafeBarracksSettlementAtLevel(accountId, barracksLevel);

      const response = await postTrain(settlementId, cookie, raiderScout, 1);

      expect(response.status).toBe(200);
      const order = response.body.trainingQueue[0];
      expect(order.unitTrainTimeMs).toBe(calcTrainTimeMs(config, raiderScout, barracksLevel));
    });

    it('idempotency: replaying the trainingComplete handler for the same event credits one unit, not two', async () => {
      const { accountId, cookie } = await createGuestSession();
      await registerFaction(cookie, RAIDER_FACTION);
      const settlementId = await foodSafeBarracksSettlement(accountId);

      // count=2, not 1: the order must still exist after the first credited unit so the
      // second `handle` call has a live `remainingCount` to (correctly) fail to match —
      // see the handler's own class comment on why "item still exists" alone isn't a
      // sufficient guard for this handler, unlike `BuildCompleteHandler`.
      const trainResponse = await postTrain(settlementId, cookie, raiderScout, 2);
      const orderId = trainResponse.body.trainingQueue[0].id as string;
      const event = await eventModel.findOne({
        type: 'trainingComplete',
        'payload.orderId': orderId,
      });
      expect(event).not.toBeNull();
      if (!event) throw new Error('unreachable');
      const confirmedEvent = event;

      async function replay(): Promise<void> {
        const session = await connection.startSession();
        try {
          await session.withTransaction(async () => {
            await trainingCompleteHandler.handle(confirmedEvent, session);
          });
        } finally {
          await session.endSession();
        }
      }

      await replay();
      const afterFirst = await settlementModel.findById(settlementId);
      expect(afterFirst?.troops.find((t) => t.unitType === raiderScout)?.count).toBe(1);
      expect(afterFirst?.trainingQueue[0]?.remainingCount).toBe(1);

      await replay();
      const afterSecond = await settlementModel.findById(settlementId);
      expect(afterSecond?.troops.find((t) => t.unitType === raiderScout)?.count).toBe(1);
      expect(afterSecond?.trainingQueue[0]?.remainingCount).toBe(1);
    });

    it('the race: two concurrent train requests that can only afford one — exactly one succeeds, resources never go negative, exactly one order exists', async () => {
      const { accountId, cookie } = await createGuestSession();
      await registerFaction(cookie, RAIDER_FACTION);
      const cost = calcTrainCost(config, raiderScout, 1);
      const settlementId = await foodSafeBarracksSettlement(accountId, {
        ...cost,
        food: ABUNDANT_RESOURCES.food,
      });

      const [responseA, responseB] = await Promise.all([
        postTrain(settlementId, cookie, raiderScout, 1),
        postTrain(settlementId, cookie, raiderScout, 1),
      ]);

      const statuses = [responseA.status, responseB.status].sort();
      expect(statuses).toEqual([200, 400]);
      const failure = responseA.status === 400 ? responseA : responseB;
      // Both requests read an empty training queue and an affordable batch before either
      // commits; the loser's version-guarded write then loses the race and `runCommand`
      // retries the whole command from scratch. Unlike the build race (a second queue
      // slot is always available, so the retrying loser genuinely fails affordability),
      // here `MAX_ACTIVE_ORDERS_PER_BUILDING = 1` means the retry finds the Barracks queue
      // already occupied by the winner and trips `queueBusy` deterministically, before
      // affordability is even evaluated — this module's own validation order (see
      // `SettlementsService.trainUnits`'s comment) checks the queue cap before cost.
      expect(failure.body.error.key).toBe('errors.training.queueBusy');

      const state = await settlementModel.findById(settlementId);
      expect(state).not.toBeNull();
      if (!state) throw new Error('unreachable');
      for (const kind of ['scrap', 'fuel', 'electronics', 'food'] as const) {
        expect(state.resources.values[kind]).toBeGreaterThanOrEqual(0);
      }
      expect(state.trainingQueue).toHaveLength(1);
    });

    it('ownership: another account cannot train units on a settlement it does not own', async () => {
      const owner = await createGuestSession();
      await registerFaction(owner.cookie, RAIDER_FACTION);
      const intruder = await createGuestSession();
      await registerFaction(intruder.cookie, RAIDER_FACTION);
      const settlementId = await foodSafeBarracksSettlement(owner.accountId);

      const response = await postTrain(settlementId, intruder.cookie, raiderScout, 1);

      expect(response.status).toBe(404);
      expect(response.body.error.key).toBe('errors.settlement.notFound');
      const state = await settlementModel.findById(settlementId);
      expect(state?.trainingQueue).toHaveLength(0);
    });
  });

  // M3a.6, `docs/M3_DESIGN_DECISIONS.md` §4/§20: the hourly starvation tick and its lazy
  // scheduling. `starvationOrder`/`resolveStarvation` themselves are exhaustively unit-tested
  // in `packages/game-core/src/units/starvation.test.ts` (every kill-order rule, every tie
  // break) — this suite proves the *server's* wiring: `SettlementsService.settleDoc` ensures
  // exactly one pending tick per starving settlement (never a background sweep), and
  // `StarvationTickHandler` applies it exactly once even under replay.
  describe('Starvation (M3a.6)', () => {
    // Every killable unit type (nonzero Food upkeep), weakest-first — the two wildlife types
    // are excluded (0 upkeep, never trained) exactly as `starvation.test.ts` excludes them.
    const killableOrder = starvationOrder(config).filter(
      (t) => config.units[t].foodUpkeepPerHour > 0,
    );
    const WEAK = killableOrder[0];
    if (!WEAK) {
      throw new Error('fixture error: expected at least one killable unit type');
    }
    const WEAK_UPKEEP = config.units[WEAK].foodUpkeepPerHour;

    // Local to this describe block (the "Unit training" describe's own `RAIDER_FACTION`/
    // `raiderScout` consts are lexically scoped to that block) — only the
    // "handlers arm it too" test below needs a real trainable unit.
    const STARVATION_RAIDER_FACTION: Faction = 'raiders';
    const starvationRaiderScout = scoutUnitForFaction(config, STARVATION_RAIDER_FACTION).type;

    // Searches for a `{buildingsBefore, trainCount}` pair that reproduces the exact gap the
    // record's lazy-scheduling clause (§4: "when a command *or handler* settles a settlement
    // and sees net Food < 0") exists to close: two *individually* Food-safe commands — an
    // upgrade queued while current troops are affordable, then a training order sized
    // against *current* buildings — whose *combination*, once both land, crosses net Food
    // into negative territory. Neither command's own gate can see this coming (each checks
    // only its own change against the state as it stood at enqueue time), so nothing arms a
    // tick when either command runs — only `BuildCompleteHandler`, applying the queued
    // Command Center upgrade later, can observe the settlement is now starving.
    //
    // Searches Greenhouse Farm levels for one where: (a) the build gate passes (headroom
    // covers the Command Center's own L1→L2 upkeep delta with current troops at 0); (b) the
    // *largest* scout batch the training gate still allows against pre-upgrade buildings
    // fully exhausts that headroom (or comes close enough — see the `finalNet < 0` check);
    // (c) applying both together goes negative. Never hardcodes a level or a count.
    function findCrossZeroBuildTrainFixture(): {
      buildingsBefore: BuildingLevels;
      buildingsAfter: BuildingLevels;
      trainCount: number;
    } {
      const buildUpkeepDelta =
        calcFoodUpkeepPerHour(config, [{ type: 'commandCenter', level: 2 }]) -
        calcFoodUpkeepPerHour(config, [{ type: 'commandCenter', level: 1 }]);
      const farmDef = config.buildings.greenhouseFarm;
      for (let level = 1; level <= farmDef.maxLevel; level += 1) {
        const buildingsBefore: BuildingLevels = [
          { type: 'commandCenter', level: 1 },
          { type: 'greenhouseFarm', level },
          { type: 'barracks', level: 1 },
        ];
        const buildingsAfter: BuildingLevels = [
          { type: 'commandCenter', level: 2 },
          { type: 'greenhouseFarm', level },
          { type: 'barracks', level: 1 },
        ];
        const netBefore = calcNetFoodPerHour(config, buildingsBefore, []);
        if (netBefore < buildUpkeepDelta) {
          continue; // the build's own gate would reject this level — try a higher one.
        }
        const scoutUpkeep = config.units[starvationRaiderScout].foodUpkeepPerHour;
        const trainCount = Math.floor(netBefore / scoutUpkeep);
        if (trainCount < 1) {
          continue;
        }
        const finalNet = calcNetFoodPerHour(config, buildingsAfter, [
          { unitType: starvationRaiderScout, count: trainCount },
        ]);
        if (finalNet < 0) {
          return { buildingsBefore, buildingsAfter, trainCount };
        }
      }
      throw new Error(
        'findCrossZeroBuildTrainFixture: no Greenhouse Farm level reproduces the crossing scenario',
      );
    }

    it('handlers arm it too: a build and a training order that are each individually Food-safe, but combine to starve, get a starvationTick from BuildCompleteHandler', async () => {
      const { accountId, cookie } = await createGuestSession();
      await registerFaction(cookie, STARVATION_RAIDER_FACTION);
      const { buildingsBefore, trainCount } = findCrossZeroBuildTrainFixture();
      const settlementId = await seedSettlement(accountId, {
        buildings: buildingsBefore.map((b) => ({ ...b })),
        resources: ABUNDANT_RESOURCES,
      });

      // 1. Queue the Command Center upgrade — its own gate checks the upgrade alone against
      // *zero* troops and passes.
      const buildResponse = await postBuild(settlementId, cookie, 'commandCenter');
      expect(buildResponse.status).toBe(200);
      const queueItemId = buildResponse.body.buildQueue[0].id as string;

      // 2. Train the largest batch the training gate still allows — checked against
      // *pre-upgrade* buildings, since the build hasn't completed yet. Also passes.
      const trainResponse = await postTrain(
        settlementId,
        cookie,
        starvationRaiderScout,
        trainCount,
      );
      expect(trainResponse.status).toBe(200);
      const orderId = trainResponse.body.trainingQueue[0].id as string;

      // 3. Credit every trained scout *before* the build completes — matching the real
      // sequence that closes the gap: the settlement must actually be carrying the added
      // troops at the moment the upgrade lands.
      for (let i = 0; i < trainCount; i += 1) {
        await completeTrainingUnit(orderId);
      }
      const noTickYet = await eventModel.find({ type: 'starvationTick' });
      expect(noTickYet).toHaveLength(0); // still Food-safe: the upgrade hasn't landed yet.

      // 4. Complete the build. `BuildCompleteHandler` now applies the level *and* must arm
      // the tick itself (M3a.6 §4) — this is the wiring under test.
      await completeQueueItem(queueItemId);

      const buildCompleteEvent = await eventModel.findOne({
        type: 'buildComplete',
        'payload.queueItemId': queueItemId,
      });
      expect(buildCompleteEvent).not.toBeNull();
      if (!buildCompleteEvent) throw new Error('unreachable');

      const stateAfterBuild = await settlementModel.findById(settlementId);
      expect(stateAfterBuild).not.toBeNull();
      if (!stateAfterBuild) throw new Error('unreachable');
      expect(stateAfterBuild.buildings.find((b) => b.type === 'commandCenter')?.level).toBe(2);
      expect(stateAfterBuild.troops.map((t) => ({ unitType: t.unitType, count: t.count }))).toEqual(
        [{ unitType: starvationRaiderScout, count: trainCount }],
      );

      const starvationEvents = await eventModel.find({
        type: 'starvationTick',
        'payload.settlementId': settlementId,
      });
      expect(starvationEvents).toHaveLength(1);
      const starvationEvent = starvationEvents[0];
      expect(starvationEvent).toBeDefined();
      if (!starvationEvent) throw new Error('unreachable');

      // Derived from `game-core` against the settlement's own actual post-build state and
      // the exact `event.dueAt` the handler anchored off — never a hardcoded number.
      const expectedDueAt =
        buildCompleteEvent.dueAt +
        (msUntilEmpty(
          config,
          toBuildingLevels(stateAfterBuild.buildings),
          {
            values: stateAfterBuild.resources.values,
            lastCalcAt: stateAfterBuild.resources.lastCalcAt,
          },
          'food',
          [{ unitType: starvationRaiderScout, count: trainCount }],
        ) ?? 0);
      expect(starvationEvent.dueAt).toBe(expectedDueAt);
      expect(stateAfterBuild.pendingStarvationEventId?.equals(starvationEvent._id)).toBe(true);
      expect(stateAfterBuild.pendingStarvationDueAt).toBe(starvationEvent.dueAt);
    });

    it('scheduling: a command that leaves a settlement net-Food-negative schedules a starvationTick at now + msUntilEmpty', async () => {
      const { accountId, cookie } = await createGuestSession();
      const startingFood = 500;
      const settlementId = await starvingSettlement(accountId, { food: startingFood });

      const before = Date.now();
      const response = await getState(settlementId, cookie);
      const after = Date.now();
      expect(response.status).toBe(200);

      const events = await eventModel.find({
        type: 'starvationTick',
        'payload.settlementId': settlementId,
      });
      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event).toBeDefined();
      if (!event) throw new Error('unreachable');

      // `msUntilEmpty` is computed against whatever real `Date.now()` the server actually
      // used, which this test doesn't control — bracket the expectation the same
      // tolerance-window way `expectResourcesCloseTo` brackets resource drift, rather than
      // pinning an exact millisecond.
      const expectedDueAt =
        before +
        (msUntilEmpty(
          config,
          BARE_BUILDINGS,
          { values: { scrap: 0, fuel: 0, electronics: 0, food: startingFood }, lastCalcAt: before },
          'food',
          [],
        ) ?? 0);
      expect(Math.abs(event.dueAt - expectedDueAt)).toBeLessThanOrEqual(MAX_TEST_ELAPSED_MS);
      expect(after).toBeGreaterThanOrEqual(before);
    });

    it('no duplicates: repeated commands leave exactly one pending tick; the deadline updates (not duplicates) when the Food position changes; it clears on recovery', async () => {
      const { accountId, cookie } = await createGuestSession();
      const settlementId = await starvingSettlement(accountId, { food: 500 });

      await getState(settlementId, cookie);
      const first = await eventModel.find({
        type: 'starvationTick',
        'payload.settlementId': settlementId,
      });
      expect(first).toHaveLength(1);
      const firstEvent = first[0];
      if (!firstEvent) throw new Error('unreachable');

      // Several more commands against an unperturbed trajectory: still exactly one pending
      // tick, the same event, the same deadline.
      await getState(settlementId, cookie);
      await getState(settlementId, cookie);
      const stillOne = await eventModel.find({
        type: 'starvationTick',
        'payload.settlementId': settlementId,
      });
      expect(stillOne).toHaveLength(1);
      expect(stillOne[0]?._id.equals(firstEvent._id)).toBe(true);
      expect(stillOne[0]?.dueAt).toBe(firstEvent.dueAt);

      // The Food position changes (a god-mode write standing in for a real command that
      // would spend/refund Food, out of this step's scope) — the next settle must
      // reschedule, not duplicate.
      await settlementModel.updateOne(
        { _id: settlementId },
        { $set: { 'resources.values.food': 5_000 } },
      );
      await getState(settlementId, cookie);
      const rescheduled = await eventModel.find({
        type: 'starvationTick',
        'payload.settlementId': settlementId,
      });
      expect(rescheduled).toHaveLength(1);
      expect(rescheduled[0]?._id.equals(firstEvent._id)).toBe(false);
      expect(rescheduled[0]?.dueAt).toBeGreaterThan(firstEvent.dueAt);

      // Recovery: net Food goes back to >= 0 (a food-safe Greenhouse Farm, god-mode) — the
      // pending tick is cancelled outright, nothing left scheduled.
      const recoveredBuildings = foodSafeBuildings();
      await settlementModel.updateOne(
        { _id: settlementId },
        {
          $set: {
            buildings: recoveredBuildings.map((b, i) => ({
              id: randomUUID(),
              type: b.type,
              level: b.level,
              slot: i,
            })),
          },
        },
      );
      await getState(settlementId, cookie);
      const cleared = await eventModel.find({
        type: 'starvationTick',
        'payload.settlementId': settlementId,
      });
      expect(cleared).toHaveLength(0);
      const finalDoc = await settlementModel.findById(settlementId);
      expect(finalDoc?.pendingStarvationEventId).toBeNull();
      expect(finalDoc?.pendingStarvationDueAt).toBeNull();
    });

    it('the kill: with stored Food at 0 and net Food negative, running the handler kills the weakest units first, only as many as needed, and never touches buildings', async () => {
      const { accountId, cookie } = await createGuestSession();
      const level = farmLevelCovering(4 * WEAK_UPKEEP);
      const buildings: BuildingLevels = [
        { type: 'commandCenter', level: 1 },
        { type: 'greenhouseFarm', level },
      ];
      const headroom = calcNetFoodPerHour(config, buildings, []);
      const troopCount = Math.ceil(headroom / WEAK_UPKEEP) + 10;
      const troops = [{ unitType: WEAK, count: troopCount }];

      const expected = resolveStarvation(config, {
        buildings,
        troops,
        awayTroops: [],
        stationed: [],
      });
      expect(expected.resolved).toBe(true);
      const expectedSurvivors =
        expected.remaining.troops.find((t) => t.unitType === WEAK)?.count ?? 0;
      expect(expectedSurvivors).toBeGreaterThan(0);
      expect(expectedSurvivors).toBeLessThan(troopCount);

      const settlementId = await starvingSettlement(accountId, { buildings, food: 0, troops });

      await getState(settlementId, cookie);
      await runStarvationTick(settlementId);

      const state = await settlementModel.findById(settlementId);
      expect(state).not.toBeNull();
      if (!state) throw new Error('unreachable');
      expect(state.troops.map((t) => ({ unitType: t.unitType, count: t.count }))).toEqual(
        expected.remaining.troops,
      );
      expect(state.awayTroops).toEqual([]);
      expect(state.stationedTroops).toEqual([]);

      // Buildings never starve (§4) — the same two entries, same levels, before and after.
      expect(state.buildings.map((b) => ({ type: b.type, level: b.level }))).toEqual(buildings);
    });

    it('guests first: a stationed contingent is consumed before home troops, and awayTroops is never touched (owner decision 2026-08-17, §4)', async () => {
      const { accountId, cookie } = await createGuestSession();
      const supporter = await createGuestSession();

      // A big home-troops buffer absorbs whatever the small stationed contingent doesn't
      // cover — awayTroops is no longer a kill target at all (owner decision 2026-08-17), so
      // it can no longer play that role; home troops does instead.
      const homeCount = 1000;
      const buildings: BuildingLevels = [
        { type: 'commandCenter', level: 1 },
        { type: 'greenhouseFarm', level: 1 },
      ];
      const troops = [{ unitType: WEAK, count: homeCount }];
      // Adds real upkeep to the deficit but must come through this tick completely untouched —
      // its size is deliberately unrelated to how much dies elsewhere.
      const awayTroops = [{ unitType: WEAK, count: 7 }];
      const fromSettlementId = new Types.ObjectId();
      const stationedTroops = [
        {
          ownerAccountId: supporter.accountId,
          fromSettlementId,
          troops: [{ unitType: WEAK, count: 2 }],
        },
      ];

      const expected = resolveStarvation(config, {
        buildings,
        troops,
        awayTroops,
        stationed: [
          {
            key: stationedContingentKey(supporter.accountId, fromSettlementId),
            troops: stationedTroops[0]?.troops ?? [],
          },
        ],
      });
      // Sanity on the fixture itself, mirroring `starvation.test.ts`'s own analogous case.
      expect(expected.killed.stationed[0]?.troops).toEqual(stationedTroops[0]?.troops);
      const expectedHomeSurvivors =
        expected.remaining.troops.find((t) => t.unitType === WEAK)?.count ?? 0;
      expect(expectedHomeSurvivors).toBeGreaterThan(0);
      expect(expectedHomeSurvivors).toBeLessThan(homeCount);

      const settlementId = await starvingSettlement(accountId, {
        buildings,
        food: 0,
        troops,
        awayTroops,
        stationedTroops,
      });

      await getState(settlementId, cookie);
      await runStarvationTick(settlementId);

      const state = await settlementModel.findById(settlementId);
      expect(state).not.toBeNull();
      if (!state) throw new Error('unreachable');
      expect(state.troops.map((t) => ({ unitType: t.unitType, count: t.count }))).toEqual(
        expected.remaining.troops,
      );
      // awayTroops is never a kill target: the handler leaves it byte-for-byte untouched, no
      // matter how much of the deficit it caused.
      expect(state.awayTroops.map((t) => ({ unitType: t.unitType, count: t.count }))).toEqual(
        awayTroops,
      );
      // The contingent lost every unit — dropped from the document entirely, not left behind
      // as an empty entry.
      expect(state.stationedTroops).toEqual([]);
    });

    it('reports: the owner gets a starvation report covering the whole settlement, and the affected supporter gets their own report scoped to their contingent', async () => {
      const { accountId, cookie } = await createGuestSession();
      const supporter = await createGuestSession();

      const fromSettlementId = new Types.ObjectId();
      const stationedTroops = [
        {
          ownerAccountId: supporter.accountId,
          fromSettlementId,
          troops: [{ unitType: WEAK, count: 3 }],
        },
      ];
      const expected = resolveStarvation(config, {
        buildings: BARE_BUILDINGS,
        troops: [],
        awayTroops: [],
        stationed: [
          {
            key: stationedContingentKey(supporter.accountId, fromSettlementId),
            troops: stationedTroops[0]?.troops ?? [],
          },
        ],
      });

      const settlementId = await starvingSettlement(accountId, { food: 0, stationedTroops });

      await getState(settlementId, cookie);
      await runStarvationTick(settlementId);

      const ownerReports = await reportModel.find({ accountId, type: 'starvation' });
      expect(ownerReports).toHaveLength(1);
      const ownerReport = ownerReports[0];
      expect(ownerReport).toBeDefined();
      if (!ownerReport) throw new Error('unreachable');
      expect(ownerReport.payload['killedTroops']).toEqual(expected.killed.troops);
      expect(ownerReport.payload).not.toHaveProperty('killedAwayTroops');
      const ownerStationedPayload = ownerReport.payload['killedStationed'] as Array<
        Record<string, unknown>
      >;
      expect(ownerStationedPayload).toHaveLength(1);
      expect(ownerStationedPayload[0]?.['ownerAccountId']).toBe(String(supporter.accountId));
      expect(ownerStationedPayload[0]?.['fromSettlementId']).toBe(String(fromSettlementId));
      expect(ownerStationedPayload[0]?.['troops']).toEqual(expected.killed.stationed[0]?.troops);

      const supporterReports = await reportModel.find({
        accountId: supporter.accountId,
        type: 'starvation',
      });
      expect(supporterReports).toHaveLength(1);
      const supporterReport = supporterReports[0];
      expect(supporterReport).toBeDefined();
      if (!supporterReport) throw new Error('unreachable');
      expect(supporterReport.payload['fromSettlementId']).toBe(String(fromSettlementId));
      expect(supporterReport.payload['killedTroops']).toEqual(expected.killed.stationed[0]?.troops);
    });

    it('rescheduling: still negative after the kill schedules the next tick at exactly dueAt + 1 hour', async () => {
      const { accountId, cookie } = await createGuestSession();
      const settlementId = await starvingSettlement(accountId, {
        food: 0,
        troops: [{ unitType: WEAK, count: 5 }],
      });

      await getState(settlementId, cookie);
      const firstEvents = await eventModel.find({
        type: 'starvationTick',
        'payload.settlementId': settlementId,
      });
      expect(firstEvents).toHaveLength(1);

      const forcedDueAt = await runStarvationTick(settlementId);

      // Bare Command Center's own upkeep has no production to offset it (§4: buildings never
      // starve, so it can never be paid off by killing troops) — every troop dies and it's
      // still negative, which is exactly the "reschedule" branch this test targets.
      const state = await settlementModel.findById(settlementId);
      expect(state?.troops).toEqual([]);

      const secondEvents = await eventModel.find({
        type: 'starvationTick',
        'payload.settlementId': settlementId,
        status: 'due',
      });
      expect(secondEvents).toHaveLength(1);
      const secondEvent = secondEvents[0];
      if (!secondEvent) throw new Error('unreachable');
      expect(secondEvent.dueAt).toBe(forcedDueAt + HOUR_MS);
      expect(state?.pendingStarvationEventId?.equals(secondEvent._id)).toBe(true);
      expect(state?.pendingStarvationDueAt).toBe(secondEvent.dueAt);
    });

    it('stopping: net Food recovering after the kill leaves no follow-up tick', async () => {
      const { accountId, cookie } = await createGuestSession();
      const level = farmLevelCovering(4 * WEAK_UPKEEP);
      const buildings: BuildingLevels = [
        { type: 'commandCenter', level: 1 },
        { type: 'greenhouseFarm', level },
      ];
      const headroom = calcNetFoodPerHour(config, buildings, []);
      const troopCount = Math.ceil(headroom / WEAK_UPKEEP) + 10;
      const settlementId = await starvingSettlement(accountId, {
        buildings,
        food: 0,
        troops: [{ unitType: WEAK, count: troopCount }],
      });

      await getState(settlementId, cookie);
      await runStarvationTick(settlementId);

      // `status: 'due'` — the processed tick itself legitimately stays in the collection
      // with `status: 'done'` (events are marked done, never deleted, `SchedulerService`);
      // "no follow-up" means no *pending* one, not an empty collection.
      const events = await eventModel.find({
        type: 'starvationTick',
        'payload.settlementId': settlementId,
        status: 'due',
      });
      expect(events).toHaveLength(0);
      const state = await settlementModel.findById(settlementId);
      expect(state?.pendingStarvationEventId).toBeNull();
      expect(state?.pendingStarvationDueAt).toBeNull();
    });

    it('idempotency: replaying the same starvationTick event kills nothing the second time', async () => {
      const { accountId, cookie } = await createGuestSession();
      const level = farmLevelCovering(4 * WEAK_UPKEEP);
      const buildings: BuildingLevels = [
        { type: 'commandCenter', level: 1 },
        { type: 'greenhouseFarm', level },
      ];
      const headroom = calcNetFoodPerHour(config, buildings, []);
      const troopCount = Math.ceil(headroom / WEAK_UPKEEP) + 10;
      const settlementId = await starvingSettlement(accountId, {
        buildings,
        food: 0,
        troops: [{ unitType: WEAK, count: troopCount }],
      });

      await getState(settlementId, cookie);
      const events = await eventModel.find({
        type: 'starvationTick',
        'payload.settlementId': settlementId,
      });
      expect(events).toHaveLength(1);
      const event = events[0];
      if (!event) throw new Error('unreachable');
      const confirmedEvent = event;

      async function replay(): Promise<void> {
        const session = await connection.startSession();
        try {
          await session.withTransaction(async () => {
            await starvationTickHandler.handle(confirmedEvent, session);
          });
        } finally {
          await session.endSession();
        }
      }

      await replay();
      const afterFirst = await settlementModel.findById(settlementId);
      const survivorsAfterFirst = afterFirst?.troops.find((t) => t.unitType === WEAK)?.count ?? 0;
      expect(survivorsAfterFirst).toBeGreaterThan(0);
      expect(survivorsAfterFirst).toBeLessThan(troopCount);
      expect(afterFirst?.lastStarvationTickAt).toBe(confirmedEvent.dueAt);
      const reportsAfterFirst = await reportModel.find({ accountId, type: 'starvation' });
      expect(reportsAfterFirst).toHaveLength(1);
      expect(afterFirst?.pendingStarvationEventId).toBeNull();
      // No *new* follow-up event was scheduled — resolved. Excludes `confirmedEvent` itself
      // by id (not by `status: 'due'`, unlike the scheduler-driven tests above): this test
      // calls `handle` directly, bypassing `SchedulerService.dispatch`, so nothing ever marks
      // the original event `done` — it legitimately stays `due` forever in this test's own
      // Mongo state, which is exactly why the id exclusion (not a status filter) is the right
      // way to ask "was a *new* one created".
      const newEventsAfterFirst = await eventModel.find({
        type: 'starvationTick',
        'payload.settlementId': settlementId,
        _id: { $ne: confirmedEvent._id },
      });
      expect(newEventsAfterFirst).toHaveLength(0);

      await replay();
      const afterSecond = await settlementModel.findById(settlementId);
      expect(afterSecond?.troops.find((t) => t.unitType === WEAK)?.count ?? 0).toBe(
        survivorsAfterFirst,
      );
      const reportsAfterSecond = await reportModel.find({ accountId, type: 'starvation' });
      expect(reportsAfterSecond).toHaveLength(1); // still one — the replay wrote no second report
      expect(afterSecond?.pendingStarvationEventId).toBeNull();
      const newEventsAfterSecond = await eventModel.find({
        type: 'starvationTick',
        'payload.settlementId': settlementId,
        _id: { $ne: confirmedEvent._id },
      });
      expect(newEventsAfterSecond).toHaveLength(0);
    });
  });
});
