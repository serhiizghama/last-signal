import { randomUUID } from 'node:crypto';

import type { BuildingLevels, BuildingType, GameConfig, Resources } from '@last-signal/game-core';
import {
  BUILDING_TYPES,
  DEFAULT_CONFIG,
  HOUR_MS,
  RESOURCE_KINDS,
  calcBuildCost,
  calcNetRates,
  wouldStarveSettlement,
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
import { Settlement } from '../schemas/settlement.schema';
import type { SettlementDocument } from '../schemas/settlement.schema';
import { SchedulerService } from '../scheduler/scheduler.service';
import { BuildCompleteHandler } from './handlers/build-complete.handler';
import { ACTIVE_BUILD_SLOTS, WAITING_QUEUE_SLOTS } from './settlements.constants';

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
  let schedulerService: SchedulerService;
  let buildCompleteHandler: BuildCompleteHandler;
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

    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();

    connection = moduleRef.get(getConnectionToken());
    accountModel = moduleRef.get(getModelToken(Account.name));
    settlementModel = moduleRef.get(getModelToken(Settlement.name));
    eventModel = moduleRef.get(getModelToken(GameEvent.name));
    schedulerService = moduleRef.get(SchedulerService);
    buildCompleteHandler = moduleRef.get(BuildCompleteHandler);
    activeBuildSlots = moduleRef.get(ACTIVE_BUILD_SLOTS);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await replSet.stop();
    delete process.env['MONGODB_URI'];
    delete process.env['SCHEDULER_ENABLED'];
  }, 60_000);

  afterEach(async () => {
    await Promise.all([
      accountModel.deleteMany({}),
      settlementModel.deleteMany({}),
      eventModel.deleteMany({}),
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
});
