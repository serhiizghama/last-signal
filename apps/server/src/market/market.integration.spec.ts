import { randomUUID } from 'node:crypto';

import type { GameConfig, Resources } from '@last-signal/game-core';
import {
  DEFAULT_CONFIG,
  calcStorageCaps,
  chebyshevDistance,
  exchangeOutput,
  merchantSpeed,
  merchantsFromMarketLevel,
  merchantsNeededFor,
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
import { MovementArriveHandler } from '../movements/handlers/movement-arrive.handler';
import { MovementReturnHandler } from '../movements/handlers/movement-return.handler';
import type { AccountDocument, Faction } from '../schemas/account.schema';
import { Account, FACTIONS } from '../schemas/account.schema';
import type { GameEventDocument } from '../schemas/event.schema';
import { GameEvent } from '../schemas/event.schema';
import type { MarketExchangeDocument } from '../schemas/market-exchange.schema';
import { MarketExchange } from '../schemas/market-exchange.schema';
import type { MovementDocument } from '../schemas/movement.schema';
import { Movement } from '../schemas/movement.schema';
import type { ReportDocument } from '../schemas/report.schema';
import { Report } from '../schemas/report.schema';
import type { SettlementDocument } from '../schemas/settlement.schema';
import { Settlement } from '../schemas/settlement.schema';
import type { TradeOfferDocument } from '../schemas/trade-offer.schema';
import { TradeOffer } from '../schemas/trade-offer.schema';
import { SchedulerService } from '../scheduler/scheduler.service';
import { MarketExchangeHandler } from './handlers/market-exchange.handler';
import { TradeOfferExpireHandler } from './handlers/trade-offer-expire.handler';

// Follows the exact convention `movements.integration.spec.ts` established for M3c/M3d.1
// (boot the whole `AppModule` against a `MongoMemoryReplSet`, `SCHEDULER_ENABLED=false` +
// manual `runOnce()` to force scheduled events deterministically) rather than inventing a
// new one. Scope: the offer board (post, list, cancel, lazy expiry, M3d.2) AND — as of
// M3d.3 — acceptance, the two `trade` movements it spawns, and their arrival/return through
// the real scheduler. The world exchange (M3d.4) still has no surface here to test.
describe('Market (integration)', () => {
  let app: INestApplication;
  let replSet: MongoMemoryReplSet;
  let moduleRef: TestingModule;
  let connection: Connection;
  let accountModel: Model<AccountDocument>;
  let settlementModel: Model<SettlementDocument>;
  let tradeOfferModel: Model<TradeOfferDocument>;
  let movementModel: Model<MovementDocument>;
  let reportModel: Model<ReportDocument>;
  let eventModel: Model<GameEventDocument>;
  let marketExchangeModel: Model<MarketExchangeDocument>;
  let schedulerService: SchedulerService;
  let tradeOfferExpireHandler: TradeOfferExpireHandler;
  let movementArriveHandler: MovementArriveHandler;
  let movementReturnHandler: MovementReturnHandler;
  let marketExchangeHandler: MarketExchangeHandler;

  const config: GameConfig = DEFAULT_CONFIG;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    process.env['MONGODB_URI'] = replSet.getUri('last-signal-market-test');
    // The real 1s timer would race this suite's manual `runOnce()` calls.
    process.env['SCHEDULER_ENABLED'] = 'false';
    // NPC seeding is covered by its own suite — off here so it never contends with this
    // file's own settlement fixtures.
    process.env['WORLD_NPC_COUNT'] = '0';

    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    // Explicit IPv4-bound single listener — avoids ephemeral-port collisions with other
    // local processes; see `accounts.integration.spec.ts`'s beforeAll for why this matters.
    // A recent fix made the suite reliable — do not simplify this back to `app.init()` alone.
    await app.listen(0, '127.0.0.1');

    connection = moduleRef.get(getConnectionToken());
    accountModel = moduleRef.get(getModelToken(Account.name));
    settlementModel = moduleRef.get(getModelToken(Settlement.name));
    tradeOfferModel = moduleRef.get(getModelToken(TradeOffer.name));
    movementModel = moduleRef.get(getModelToken(Movement.name));
    reportModel = moduleRef.get(getModelToken(Report.name));
    eventModel = moduleRef.get(getModelToken(GameEvent.name));
    marketExchangeModel = moduleRef.get(getModelToken(MarketExchange.name));
    schedulerService = moduleRef.get(SchedulerService);
    tradeOfferExpireHandler = moduleRef.get(TradeOfferExpireHandler);
    movementArriveHandler = moduleRef.get(MovementArriveHandler);
    movementReturnHandler = moduleRef.get(MovementReturnHandler);
    marketExchangeHandler = moduleRef.get(MarketExchangeHandler);
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
      tradeOfferModel.deleteMany({}),
      movementModel.deleteMany({}),
      reportModel.deleteMany({}),
      eventModel.deleteMany({}),
      marketExchangeModel.deleteMany({}),
    ]);
  });

  interface GuestSession {
    accountId: Types.ObjectId;
    cookie: string[];
  }

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

  // A settlement-fixture counter, so every `registerFaction` call gets a unique display name
  // — `AccountsService.register` enforces name uniqueness, and every test in this file runs
  // against the same shared `accounts` collection until `afterEach` clears it. Mirrors
  // `settlements.integration.spec.ts`'s own `registeredNameCounter`/`registerFaction`.
  let registeredNameCounter = 0;

  async function registerFaction(cookie: string[], faction: Faction): Promise<void> {
    registeredNameCounter += 1;
    const response = await request(app.getHttpServer())
      .post('/api/accounts/register')
      .set('Cookie', cookie)
      .send({ name: `Trader-${registeredNameCounter}`, faction });
    expect(response.status).toBe(200);
  }

  // Deliberately NOT "abundant" in the `movements.integration.spec.ts` sense (that suite's
  // own `ABUNDANT_RESOURCES` is 1,000,000 — comfortably affordable for a battle/training
  // fixture that never credits the SAME resource back onto the SAME settlement afterward).
  // Every offer this suite cancels/expires refunds straight back onto the origin settlement's
  // own storage, which is capped at `config.storage.generalBase`/`foodBase` (draft 4000) with
  // no Warehouse/Cold Storage built — a seed value at or above that cap would make every
  // "did the refund actually land" assertion below collide with the clamp this feature is
  // also independently testing on purpose (see the dedicated "clamps the refund" test, which
  // sets its own near-cap fixture deliberately). 3000 stays under the default cap while
  // comfortably covering every amount this suite posts (up to 2000, the ratio-boundary
  // fixture's `giveAmountAtUpper`).
  const PLENTY_RESOURCES: Resources = {
    scrap: 3_000,
    fuel: 3_000,
    electronics: 3_000,
    food: 3_000,
  };

  interface SeedSettlementOptions {
    buildings?: Array<{ type: string; level: number }>;
    resources?: Resources;
  }

  // Seeds a settlement directly via Mongoose at a fixed, caller-chosen coordinate — the
  // `movements.integration.spec.ts` convention (`seedSettlementAt`), applied here. Defaults
  // to a settlement with a Market at level 1 (every market test needs one; the `noMarket`
  // rejection test is the one place that overrides `buildings` to omit it).
  //
  // `x`/`y` wrap across the whole 61x61 grid (`GRID_MIN..GRID_MAX`) rather than walking a
  // single diagonal (`(n, -n)`, which runs out of room after only 61 settlements): M3d.3's own
  // `describe('accept', ...)` block alone seeds two or three settlements per test across a
  // dozen-plus tests, comfortably exceeding that diagonal's length within one file. The 2D
  // wrap gives 61*61 unique coordinates — every test in this suite combined never comes close
  // — and stays injective for any realistic counter range, so two calls never collide with
  // each other (the only collision this suite must avoid; `WORLD_NPC_COUNT=0` means there is
  // nothing else on the grid to collide with).
  let settlementCoordCounter = 0;
  const GRID_SPAN = 61; // GRID_MAX - GRID_MIN + 1, mirrors `grid.constants.ts`'s own 61x61.

  async function seedMarketSettlement(
    accountId: Types.ObjectId,
    options: SeedSettlementOptions = {},
  ): Promise<SettlementDocument> {
    settlementCoordCounter += 1;
    const buildingsInput = options.buildings ?? [
      { type: 'commandCenter', level: 1 },
      { type: 'market', level: 1 },
    ];
    return settlementModel.create({
      accountId,
      name: 'Test Settlement',
      x: (settlementCoordCounter % GRID_SPAN) - 30,
      y: (Math.floor(settlementCoordCounter / GRID_SPAN) % GRID_SPAN) - 30,
      buildings: buildingsInput.map((b, i) => ({
        id: randomUUID(),
        type: b.type,
        level: b.level,
        slot: i,
      })),
      resources: { values: options.resources ?? PLENTY_RESOURCES, lastCalcAt: Date.now() },
      buildQueue: [],
      troops: [],
      trainingQueue: [],
      version: 0,
    });
  }

  function postCreateOffer(cookie: string[], body: Record<string, unknown>) {
    return request(app.getHttpServer()).post('/api/market/offers').set('Cookie', cookie).send(body);
  }

  function getOffers(cookie: string[]) {
    return request(app.getHttpServer()).get('/api/market/offers').set('Cookie', cookie);
  }

  function postCancelOffer(cookie: string[], offerId: string) {
    return request(app.getHttpServer())
      .post(`/api/market/offers/${offerId}/cancel`)
      .set('Cookie', cookie);
  }

  // Forces the pending `tradeOfferExpire` event due and runs the scheduler once — the same
  // determinism trick `movements.integration.spec.ts`'s `forceArrive` uses.
  async function forceExpire(offerId: string): Promise<void> {
    await eventModel.updateOne(
      { type: 'tradeOfferExpire', 'payload.offerId': offerId },
      { $set: { dueAt: Date.now() - 1_000 } },
    );
    await schedulerService.runOnce();
  }

  function postAcceptOffer(cookie: string[], offerId: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post(`/api/market/offers/${offerId}/accept`)
      .set('Cookie', cookie)
      .send(body);
  }

  function postExchange(cookie: string[], body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/api/market/exchange')
      .set('Cookie', cookie)
      .send(body);
  }

  // Forces the pending `marketExchange` event due and runs the scheduler once — the same
  // determinism trick as `forceExpire` above, applied to M3d.4's own scheduled completion.
  async function forceExchangeComplete(exchangeId: string): Promise<void> {
    await eventModel.updateOne(
      { type: 'marketExchange', 'payload.exchangeId': exchangeId },
      { $set: { dueAt: Date.now() - 1_000 } },
    );
    await schedulerService.runOnce();
  }

  // Forces a `trade` movement's pending `movementArrive` event due and runs the scheduler
  // once — the exact `movements.integration.spec.ts` convention (`forceArrive`), reused here
  // rather than reinvented, including its own `departAt` backdate: `MovementArriveHandler`
  // computes the follow-up `movementReturn`'s `dueAt` as `computeReturnAt(departAt,
  // event.dueAt)`, and a `departAt` left at "just now" could otherwise land that return event
  // in the past too, letting `runOnce()`'s claim loop dispatch it in the very same pass.
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

  async function forceReturn(movementId: string): Promise<void> {
    await eventModel.updateOne(
      { type: 'movementReturn', 'payload.movementId': movementId },
      { $set: { dueAt: Date.now() - 1_000 } },
    );
    await schedulerService.runOnce();
  }

  async function makeTraderWithMarket(
    faction: Faction,
    options: SeedSettlementOptions = {},
  ): Promise<{ session: GuestSession; settlement: SettlementDocument }> {
    const session = await createGuestSession();
    await registerFaction(session.cookie, faction);
    const settlement = await seedMarketSettlement(session.accountId, options);
    return { session, settlement };
  }

  it('acceptance: a legal offer deducts resources at creation, computes merchantsNeeded from game-core, and schedules its expiry', async () => {
    const { session, settlement } = await makeTraderWithMarket('raiders');
    const now = Date.now();

    const response = await postCreateOffer(session.cookie, {
      fromSettlementId: String(settlement._id),
      give: { resource: 'scrap', amount: 1000 },
      want: { resource: 'fuel', amount: 1000 },
    });
    expect(response.status).toBe(201);
    expect(response.body.status).toBe('open');
    expect(response.body.give).toEqual({ resource: 'scrap', amount: 1000 });
    expect(response.body.want).toEqual({ resource: 'fuel', amount: 1000 });

    const expectedMerchants = merchantsNeededFor(config, 'raiders', 1000);
    expect(response.body.merchantsNeeded).toBe(expectedMerchants);
    expect(response.body.expiresAt).toBeGreaterThanOrEqual(now + config.market.offerTtlMs - 1_000);
    expect(response.body.expiresAt).toBeLessThanOrEqual(now + config.market.offerTtlMs + 5_000);

    // Deducted from the settlement immediately.
    const settlementAfter = await settlementModel.findById(settlement._id);
    expect(settlementAfter?.resources.values.scrap).toBeCloseTo(PLENTY_RESOURCES.scrap - 1000, 6);

    // Nothing else was touched — `busyMerchants` stays 0 (owner decision E: an open offer
    // reserves no merchants).
    expect(settlementAfter?.busyMerchants).toBe(0);

    const offerId = response.body.id as string;
    const expireEvent = await eventModel.findOne({
      type: 'tradeOfferExpire',
      'payload.offerId': offerId,
    });
    expect(expireEvent).not.toBeNull();
    expect(expireEvent?.status).toBe('due');
    expect(expireEvent?.dueAt).toBe(response.body.expiresAt);

    const offerDoc = await tradeOfferModel.findById(offerId);
    expect(offerDoc?.expireEventId?.toString()).toBe(String(expireEvent?._id));
  });

  describe('validation: every rejection path has its own stable key and changes nothing', () => {
    async function expectRejectedAndUnchanged(
      cookie: string[],
      settlementId: Types.ObjectId,
      body: Record<string, unknown>,
      expectedKey: string,
    ): Promise<void> {
      const before = await settlementModel.findById(settlementId);
      const offerCountBefore = await tradeOfferModel.countDocuments({});

      const response = await postCreateOffer(cookie, {
        fromSettlementId: String(settlementId),
        ...body,
      });
      expect(response.status).toBe(400);
      expect(response.body.error.key).toBe(expectedKey);

      const after = await settlementModel.findById(settlementId);
      expect(after?.resources.values).toEqual(before?.resources.values);
      expect(await tradeOfferModel.countDocuments({})).toBe(offerCountBefore);
    }

    it('no Market building at all -> errors.market.noMarket', async () => {
      const { session, settlement } = await makeTraderWithMarket('raiders', {
        buildings: [{ type: 'commandCenter', level: 1 }],
      });
      await expectRejectedAndUnchanged(
        session.cookie,
        settlement._id,
        { give: { resource: 'scrap', amount: 100 }, want: { resource: 'fuel', amount: 100 } },
        'errors.market.noMarket',
      );
    });

    it('a guest account with no faction -> errors.market.noFaction', async () => {
      const guest = await createGuestSession();
      const settlement = await seedMarketSettlement(guest.accountId);
      await expectRejectedAndUnchanged(
        guest.cookie,
        settlement._id,
        { give: { resource: 'scrap', amount: 100 }, want: { resource: 'fuel', amount: 100 } },
        'errors.market.noFaction',
      );
    });

    it('an unknown give resource -> errors.market.unknownResource', async () => {
      const { session, settlement } = await makeTraderWithMarket('raiders');
      await expectRejectedAndUnchanged(
        session.cookie,
        settlement._id,
        { give: { resource: 'plutonium', amount: 100 }, want: { resource: 'fuel', amount: 100 } },
        'errors.market.unknownResource',
      );
    });

    it('an unknown want resource -> errors.market.unknownResource', async () => {
      const { session, settlement } = await makeTraderWithMarket('raiders');
      await expectRejectedAndUnchanged(
        session.cookie,
        settlement._id,
        { give: { resource: 'scrap', amount: 100 }, want: { resource: 'plutonium', amount: 100 } },
        'errors.market.unknownResource',
      );
    });

    it('give and want name the same resource -> errors.market.sameResource', async () => {
      const { session, settlement } = await makeTraderWithMarket('raiders');
      await expectRejectedAndUnchanged(
        session.cookie,
        settlement._id,
        { give: { resource: 'scrap', amount: 100 }, want: { resource: 'scrap', amount: 200 } },
        'errors.market.sameResource',
      );
    });

    it('a zero give amount -> errors.market.invalidAmount', async () => {
      const { session, settlement } = await makeTraderWithMarket('raiders');
      await expectRejectedAndUnchanged(
        session.cookie,
        settlement._id,
        { give: { resource: 'scrap', amount: 0 }, want: { resource: 'fuel', amount: 100 } },
        'errors.market.invalidAmount',
      );
    });

    it('a fractional want amount -> errors.market.invalidAmount', async () => {
      const { session, settlement } = await makeTraderWithMarket('raiders');
      await expectRejectedAndUnchanged(
        session.cookie,
        settlement._id,
        { give: { resource: 'scrap', amount: 100 }, want: { resource: 'fuel', amount: 12.5 } },
        'errors.market.invalidAmount',
      );
    });

    it('a negative give amount -> errors.market.invalidAmount', async () => {
      const { session, settlement } = await makeTraderWithMarket('raiders');
      await expectRejectedAndUnchanged(
        session.cookie,
        settlement._id,
        { give: { resource: 'scrap', amount: -50 }, want: { resource: 'fuel', amount: 100 } },
        'errors.market.invalidAmount',
      );
    });

    it('insufficient resources -> errors.market.insufficientResources', async () => {
      const { session, settlement } = await makeTraderWithMarket('raiders', {
        resources: { scrap: 50, fuel: 1_000_000, electronics: 1_000_000, food: 1_000_000 },
      });
      await expectRejectedAndUnchanged(
        session.cookie,
        settlement._id,
        { give: { resource: 'scrap', amount: 1000 }, want: { resource: 'fuel', amount: 1000 } },
        'errors.market.insufficientResources',
      );
    });
  });

  describe('the §14 ratio cap, boundaries read from config, never hardcoded', () => {
    // Swapping give/want inverts the ratio exactly (ratio' = 1/ratio) regardless of what
    // `maxOfferRatio`/`valueWeights` happen to be — algebraically true, not a numeric
    // coincidence — so one "exactly at the upper bound" construction gives both boundary
    // fixtures for free by swapping which side is `give` and which is `want`.
    const scrapWeight = config.market.valueWeights.scrap;
    const fuelWeight = config.market.valueWeights.fuel;
    const maxRatio = config.market.maxOfferRatio;
    const wantAmountAtUpper = 1000;
    const wantValueAtUpper = fuelWeight * wantAmountAtUpper;
    const giveAmountAtUpper = (wantValueAtUpper * maxRatio) / scrapWeight;

    it('sanity: the chosen fixture amounts land on an exact integer boundary for the live config', () => {
      // Documents the assumption the four tests below all rely on — if a future config
      // change makes this fail, these fixtures (not the ratio cap itself) need adjusting.
      expect(Number.isInteger(giveAmountAtUpper)).toBe(true);
    });

    it('exactly the upper bound (ratio === maxOfferRatio) is accepted', async () => {
      const { session, settlement } = await makeTraderWithMarket('raiders');
      const response = await postCreateOffer(session.cookie, {
        fromSettlementId: String(settlement._id),
        give: { resource: 'scrap', amount: giveAmountAtUpper },
        want: { resource: 'fuel', amount: wantAmountAtUpper },
      });
      expect(response.status).toBe(201);
    });

    it('just above the upper bound is rejected with ratioOutOfRange, carrying both weighted values', async () => {
      const { session, settlement } = await makeTraderWithMarket('raiders');
      const response = await postCreateOffer(session.cookie, {
        fromSettlementId: String(settlement._id),
        give: { resource: 'scrap', amount: giveAmountAtUpper + 1 },
        want: { resource: 'fuel', amount: wantAmountAtUpper },
      });
      expect(response.status).toBe(400);
      expect(response.body.error.key).toBe('errors.market.ratioOutOfRange');
      expect(response.body.error.params.giveValue).toBe(scrapWeight * (giveAmountAtUpper + 1));
      expect(response.body.error.params.wantValue).toBe(wantValueAtUpper);
      expect(response.body.error.params.maxOfferRatio).toBe(maxRatio);
    });

    it('exactly the lower bound (ratio === 1/maxOfferRatio, via give/want swapped) is accepted', async () => {
      const { session, settlement } = await makeTraderWithMarket('raiders');
      const response = await postCreateOffer(session.cookie, {
        fromSettlementId: String(settlement._id),
        give: { resource: 'fuel', amount: wantAmountAtUpper },
        want: { resource: 'scrap', amount: giveAmountAtUpper },
      });
      expect(response.status).toBe(201);
    });

    it('just below the lower bound is rejected with ratioOutOfRange', async () => {
      const { session, settlement } = await makeTraderWithMarket('raiders');
      const response = await postCreateOffer(session.cookie, {
        fromSettlementId: String(settlement._id),
        give: { resource: 'fuel', amount: wantAmountAtUpper - 1 },
        want: { resource: 'scrap', amount: giveAmountAtUpper },
      });
      expect(response.status).toBe(400);
      expect(response.body.error.key).toBe('errors.market.ratioOutOfRange');
    });
  });

  describe('cancel', () => {
    it('refunds 100% of give.amount, frees nothing else, deletes the pending expire event, and sets a terminal status', async () => {
      const { session, settlement } = await makeTraderWithMarket('raiders');
      const createResponse = await postCreateOffer(session.cookie, {
        fromSettlementId: String(settlement._id),
        give: { resource: 'scrap', amount: 1000 },
        want: { resource: 'fuel', amount: 1000 },
      });
      expect(createResponse.status).toBe(201);
      const offerId = createResponse.body.id as string;
      const afterCreate = await settlementModel.findById(settlement._id);
      expect(afterCreate?.resources.values.scrap).toBeCloseTo(PLENTY_RESOURCES.scrap - 1000, 6);

      const cancelResponse = await postCancelOffer(session.cookie, offerId);
      expect(cancelResponse.status).toBe(200);
      expect(cancelResponse.body.refunded).toBe(1000);
      expect(cancelResponse.body.lost).toBe(0);
      expect(cancelResponse.body.offer.status).toBe('cancelled');

      const afterCancel = await settlementModel.findById(settlement._id);
      expect(afterCancel?.resources.values.scrap).toBeCloseTo(PLENTY_RESOURCES.scrap, 6);
      expect(afterCancel?.busyMerchants).toBe(0);

      const offerDoc = await tradeOfferModel.findById(offerId);
      expect(offerDoc?.status).toBe('cancelled');

      const expireEvent = await eventModel.findOne({
        type: 'tradeOfferExpire',
        'payload.offerId': offerId,
      });
      expect(expireEvent).toBeNull();
    });

    it('clamps the refund to the settlement’s own storage cap and reports the loss', async () => {
      const { session, settlement } = await makeTraderWithMarket('raiders', {
        buildings: [
          { type: 'commandCenter', level: 1 },
          { type: 'market', level: 1 },
        ],
        // No Warehouse -> the general storage cap is exactly `config.storage.generalBase`.
        resources: { scrap: 1_000, fuel: 1_000_000, electronics: 1_000_000, food: 1_000_000 },
      });
      const caps = calcStorageCaps(config, [
        { type: 'commandCenter', level: 1 },
        { type: 'market', level: 1 },
      ]);
      const giveAmount = 1000;

      const createResponse = await postCreateOffer(session.cookie, {
        fromSettlementId: String(settlement._id),
        give: { resource: 'scrap', amount: giveAmount },
        want: { resource: 'fuel', amount: giveAmount },
      });
      expect(createResponse.status).toBe(201);
      const offerId = createResponse.body.id as string;

      // Simulate production having refilled the warehouse to near-full while the offer sat
      // open on the board, leaving only 200 of headroom — directly via Mongoose, the same
      // "seed the exact scenario a test needs" convention `seedSettlementAt` itself uses.
      const headroom = 200;
      await settlementModel.updateOne(
        { _id: settlement._id },
        {
          $set: {
            'resources.values.scrap': caps.scrap - headroom,
            'resources.lastCalcAt': Date.now(),
          },
        },
      );

      const cancelResponse = await postCancelOffer(session.cookie, offerId);
      expect(cancelResponse.status).toBe(200);
      expect(cancelResponse.body.refunded).toBe(headroom);
      expect(cancelResponse.body.lost).toBe(giveAmount - headroom);

      const afterCancel = await settlementModel.findById(settlement._id);
      expect(afterCancel?.resources.values.scrap).toBeCloseTo(caps.scrap, 6);
    });

    it('cancelling twice is rejected the second time with offerNotOpen, no second refund', async () => {
      const { session, settlement } = await makeTraderWithMarket('raiders');
      const createResponse = await postCreateOffer(session.cookie, {
        fromSettlementId: String(settlement._id),
        give: { resource: 'scrap', amount: 1000 },
        want: { resource: 'fuel', amount: 1000 },
      });
      const offerId = createResponse.body.id as string;

      const firstCancel = await postCancelOffer(session.cookie, offerId);
      expect(firstCancel.status).toBe(200);

      const secondCancel = await postCancelOffer(session.cookie, offerId);
      expect(secondCancel.status).toBe(400);
      expect(secondCancel.body.error.key).toBe('errors.market.offerNotOpen');

      const afterBoth = await settlementModel.findById(settlement._id);
      expect(afterBoth?.resources.values.scrap).toBeCloseTo(PLENTY_RESOURCES.scrap, 6);
    });

    it('cancelling someone else’s offer is rejected with offerNotFound (does not leak existence)', async () => {
      const owner = await makeTraderWithMarket('raiders');
      const stranger = await createGuestSession();

      const createResponse = await postCreateOffer(owner.session.cookie, {
        fromSettlementId: String(owner.settlement._id),
        give: { resource: 'scrap', amount: 1000 },
        want: { resource: 'fuel', amount: 1000 },
      });
      const offerId = createResponse.body.id as string;

      const response = await postCancelOffer(stranger.cookie, offerId);
      expect(response.status).toBe(404);
      expect(response.body.error.key).toBe('errors.market.offerNotFound');

      const offerDoc = await tradeOfferModel.findById(offerId);
      expect(offerDoc?.status).toBe('open');
    });

    it('the playbook race: two concurrent cancels of the same offer — exactly one succeeds, the refund lands exactly once', async () => {
      const { session, settlement } = await makeTraderWithMarket('raiders');
      const createResponse = await postCreateOffer(session.cookie, {
        fromSettlementId: String(settlement._id),
        give: { resource: 'scrap', amount: 1000 },
        want: { resource: 'fuel', amount: 1000 },
      });
      const offerId = createResponse.body.id as string;

      const [responseA, responseB] = await Promise.all([
        postCancelOffer(session.cookie, offerId),
        postCancelOffer(session.cookie, offerId),
      ]);

      const statuses = [responseA.status, responseB.status].sort();
      expect(statuses).toEqual([200, 400]);
      const failure = responseA.status === 400 ? responseA : responseB;
      expect(failure.body.error.key).toBe('errors.market.offerNotOpen');

      const afterRace = await settlementModel.findById(settlement._id);
      // Refunded exactly once — never negative, never double-credited.
      expect(afterRace?.resources.values.scrap).toBeCloseTo(PLENTY_RESOURCES.scrap, 6);

      const offerDoc = await tradeOfferModel.findById(offerId);
      expect(offerDoc?.status).toBe('cancelled');
    });
  });

  describe('expiry (§14 48h TTL, owner decision F)', () => {
    it('the expire handler refunds and flips status, driven through the real scheduler', async () => {
      const { session, settlement } = await makeTraderWithMarket('raiders');
      const createResponse = await postCreateOffer(session.cookie, {
        fromSettlementId: String(settlement._id),
        give: { resource: 'scrap', amount: 1000 },
        want: { resource: 'fuel', amount: 1000 },
      });
      const offerId = createResponse.body.id as string;
      const afterCreate = await settlementModel.findById(settlement._id);
      expect(afterCreate?.resources.values.scrap).toBeCloseTo(PLENTY_RESOURCES.scrap - 1000, 6);

      await forceExpire(offerId);

      const offerDoc = await tradeOfferModel.findById(offerId);
      expect(offerDoc?.status).toBe('expired');

      const afterExpire = await settlementModel.findById(settlement._id);
      expect(afterExpire?.resources.values.scrap).toBeCloseTo(PLENTY_RESOURCES.scrap, 6);

      const event = await eventModel.findOne({
        type: 'tradeOfferExpire',
        'payload.offerId': offerId,
      });
      expect(event?.status).toBe('done');
    });

    it('replay safety: handling the same expire event twice refunds exactly once', async () => {
      const { session, settlement } = await makeTraderWithMarket('raiders');
      const createResponse = await postCreateOffer(session.cookie, {
        fromSettlementId: String(settlement._id),
        give: { resource: 'scrap', amount: 1000 },
        want: { resource: 'fuel', amount: 1000 },
      });
      const offerId = createResponse.body.id as string;

      await forceExpire(offerId);
      const event = await eventModel.findOne({
        type: 'tradeOfferExpire',
        'payload.offerId': offerId,
      });
      expect(event).not.toBeNull();
      const afterFirstRun = await settlementModel.findById(settlement._id);
      expect(afterFirstRun?.resources.values.scrap).toBeCloseTo(PLENTY_RESOURCES.scrap, 6);

      // Calls the handler directly a second time against a fresh session/transaction — the
      // exact replay-testing shape `docs/CONCURRENCY_PLAYBOOK.md` §6 prescribes ("call the
      // handler directly twice ... assert the second call is a no-op"), bypassing the
      // scheduler's own claim step since the property under test is the handler's own
      // idempotency, not the claim logic.
      const replaySession = await connection.startSession();
      try {
        await replaySession.withTransaction(async () => {
          await tradeOfferExpireHandler.handle(event!, replaySession);
        });
      } finally {
        await replaySession.endSession();
      }

      const afterReplay = await settlementModel.findById(settlement._id);
      expect(afterReplay?.resources.values.scrap).toBeCloseTo(PLENTY_RESOURCES.scrap, 6);
      expect(afterReplay?.version).toBe(afterFirstRun?.version);

      const offerDoc = await tradeOfferModel.findById(offerId);
      expect(offerDoc?.status).toBe('expired');
    });
  });

  describe('the board', () => {
    it('lists open offers from every account, marks the caller’s own, and excludes cancelled/expired ones', async () => {
      const alice = await makeTraderWithMarket('raiders');
      const bob = await makeTraderWithMarket('engineers');

      const aliceOpen = await postCreateOffer(alice.session.cookie, {
        fromSettlementId: String(alice.settlement._id),
        give: { resource: 'scrap', amount: 1000 },
        want: { resource: 'fuel', amount: 1000 },
      });
      const bobOpen = await postCreateOffer(bob.session.cookie, {
        fromSettlementId: String(bob.settlement._id),
        give: { resource: 'electronics', amount: 100 },
        want: { resource: 'food', amount: 100 },
      });
      const aliceCancelled = await postCreateOffer(alice.session.cookie, {
        fromSettlementId: String(alice.settlement._id),
        give: { resource: 'fuel', amount: 500 },
        want: { resource: 'scrap', amount: 500 },
      });
      await postCancelOffer(alice.session.cookie, aliceCancelled.body.id as string);

      const bobExpired = await postCreateOffer(bob.session.cookie, {
        fromSettlementId: String(bob.settlement._id),
        give: { resource: 'food', amount: 300 },
        want: { resource: 'scrap', amount: 300 },
      });
      await forceExpire(bobExpired.body.id as string);

      const boardForAlice = await getOffers(alice.session.cookie);
      expect(boardForAlice.status).toBe(200);
      const idsOnBoard = (boardForAlice.body.offers as Array<{ id: string }>).map((o) => o.id);
      expect(idsOnBoard).toContain(aliceOpen.body.id);
      expect(idsOnBoard).toContain(bobOpen.body.id);
      expect(idsOnBoard).not.toContain(aliceCancelled.body.id);
      expect(idsOnBoard).not.toContain(bobExpired.body.id);

      const aliceEntry = (boardForAlice.body.offers as Array<{ id: string; mine: boolean }>).find(
        (o) => o.id === aliceOpen.body.id,
      );
      const bobEntry = (boardForAlice.body.offers as Array<{ id: string; mine: boolean }>).find(
        (o) => o.id === bobOpen.body.id,
      );
      expect(aliceEntry?.mine).toBe(true);
      expect(bobEntry?.mine).toBe(false);

      // Origin coordinates + owner name travel with the board entry so the client can show
      // distance/counterparty without a second round trip (§14/M3d.2's own brief).
      const bobEntryFull = (
        boardForAlice.body.offers as Array<{
          id: string;
          origin: { x: number; y: number };
          ownerName: string;
        }>
      ).find((o) => o.id === bobOpen.body.id)!;
      expect(bobEntryFull.origin).toEqual({ x: bob.settlement.x, y: bob.settlement.y });
      expect(typeof bobEntryFull.ownerName).toBe('string');
      expect(bobEntryFull.ownerName.length).toBeGreaterThan(0);
    });
  });

  // A cheap sanity check that every faction in the catalogue can actually post an offer —
  // guards against `errors.market.noFaction` accidentally firing for a real, registered
  // faction (which would mean the controller/service wiring dropped `account.faction`).
  it('every real faction can post an offer (§14 merchant flavour is per-faction, not per-account-shape)', async () => {
    for (const faction of FACTIONS) {
      const { session, settlement } = await makeTraderWithMarket(faction);
      const response = await postCreateOffer(session.cookie, {
        fromSettlementId: String(settlement._id),
        give: { resource: 'scrap', amount: 100 },
        want: { resource: 'fuel', amount: 100 },
      });
      expect(response.status, `faction=${faction}`).toBe(201);
    }
  });

  // M3d.3: accepting an offer, the two `trade` movements it spawns, and their arrival/return
  // through the real scheduler. `raiders` (merchant capacity 1000, speed 12) and `nomads`
  // (capacity 750, speed 24) are used as the offerer/accepter pair throughout this describe
  // block specifically because their DIFFERENT speeds make the two legs' `arriveAt`s provably
  // different whenever a test cares to check — never because the amounts below were tuned to
  // any other faction pairing.
  describe('accept', () => {
    // `give`/`want` chosen so: (a) the §14 ratio cap is comfortably satisfied
    // (`giveValue/wantValue` well inside `[1/maxOfferRatio, maxOfferRatio]`); (b) each side
    // needs EXACTLY 1 merchant (`ceil(amount / capacity)` for both raiders' 1000 and nomads'
    // 750), matching the exactly-1-free-merchant a fresh Market level 1 settlement has, so the
    // "happy path" tests below never accidentally trip `notEnoughMerchants`; (c) both
    // deliveries land comfortably under `PLENTY_RESOURCES`' settlements' default storage cap
    // (`config.storage.generalBase`, no Warehouse built), so the happy-path tests never
    // accidentally trip the storage clamp either — that has its own dedicated test below.
    const GIVE_AMOUNT = 800; // scrap, from the offerer (raiders, capacity 1000)
    const WANT_AMOUNT = 700; // fuel, from the accepter (nomads, capacity 750)

    async function postOfferAndAccept(
      offererFaction: Faction,
      accepterFaction: Faction,
    ): Promise<{
      offerer: { session: GuestSession; settlement: SettlementDocument };
      accepter: { session: GuestSession; settlement: SettlementDocument };
      offerId: string;
      acceptResponse: request.Response;
    }> {
      const offerer = await makeTraderWithMarket(offererFaction);
      const accepter = await makeTraderWithMarket(accepterFaction);
      const createResponse = await postCreateOffer(offerer.session.cookie, {
        fromSettlementId: String(offerer.settlement._id),
        give: { resource: 'scrap', amount: GIVE_AMOUNT },
        want: { resource: 'fuel', amount: WANT_AMOUNT },
      });
      expect(createResponse.status).toBe(201);
      const offerId = createResponse.body.id as string;
      const acceptResponse = await postAcceptOffer(accepter.session.cookie, offerId, {
        fromSettlementId: String(accepter.settlement._id),
      });
      return { offerer, accepter, offerId, acceptResponse };
    }

    it('the §20 acceptance criterion: an accepted offer moves resources in both directions, frees the merchants, travels at each side’s own faction speed, and writes exactly one trade report per party — driven end to end through the real scheduler', async () => {
      const { offerer, accepter, offerId, acceptResponse } = await postOfferAndAccept(
        'raiders',
        'nomads',
      );
      expect(acceptResponse.status).toBe(200);
      expect(acceptResponse.body.offer.status).toBe('accepted');
      const offererToAccepterMovementId = acceptResponse.body.offererToAccepterMovementId as string;
      const accepterToOffererMovementId = acceptResponse.body.accepterToOffererMovementId as string;
      expect(offererToAccepterMovementId).not.toBe(accepterToOffererMovementId);

      // Both movements exist, carry the right cargo/merchants/provenance, in the right
      // direction, and derive `merchantsNeeded` from `game-core` rather than a hardcoded
      // number.
      const expectedOffererMerchants = merchantsNeededFor(config, 'raiders', GIVE_AMOUNT);
      const expectedAccepterMerchants = merchantsNeededFor(config, 'nomads', WANT_AMOUNT);
      expect(expectedOffererMerchants).toBe(1);
      expect(expectedAccepterMerchants).toBe(1);

      const offererLeg = await movementModel.findById(offererToAccepterMovementId);
      expect(offererLeg?.type).toBe('trade');
      expect(offererLeg?.status).toBe('outbound');
      expect(offererLeg?.ownerAccountId.equals(offerer.session.accountId)).toBe(true);
      expect(String(offererLeg?.fromSettlementId)).toBe(String(offerer.settlement._id));
      expect(String(offererLeg?.toSettlementId)).toBe(String(accepter.settlement._id));
      expect(offererLeg?.cargo).toMatchObject({
        scrap: GIVE_AMOUNT,
        fuel: 0,
        electronics: 0,
        food: 0,
      });
      expect(offererLeg?.merchants).toBe(expectedOffererMerchants);
      expect(String(offererLeg?.tradeOfferId)).toBe(offerId);
      expect(offererLeg?.units).toEqual([]);

      const accepterLeg = await movementModel.findById(accepterToOffererMovementId);
      expect(accepterLeg?.type).toBe('trade');
      expect(accepterLeg?.status).toBe('outbound');
      expect(accepterLeg?.ownerAccountId.equals(accepter.session.accountId)).toBe(true);
      expect(String(accepterLeg?.fromSettlementId)).toBe(String(accepter.settlement._id));
      expect(String(accepterLeg?.toSettlementId)).toBe(String(offerer.settlement._id));
      expect(accepterLeg?.cargo).toMatchObject({
        scrap: 0,
        fuel: WANT_AMOUNT,
        electronics: 0,
        food: 0,
      });
      expect(accepterLeg?.merchants).toBe(expectedAccepterMerchants);
      expect(String(accepterLeg?.tradeOfferId)).toBe(offerId);

      // Each leg travels at ITS OWN sender's faction speed (§14) — same distance (Chebyshev
      // is symmetric), different speed, different duration, computed from `game-core`, never
      // hardcoded. Raiders (12) and nomads (24) are different enough that the two `arriveAt`s
      // must differ whenever the distance is nonzero, which two independently-coordinated
      // fixture settlements always are.
      const distance = chebyshevDistance(
        { x: offerer.settlement.x, y: offerer.settlement.y },
        { x: accepter.settlement.x, y: accepter.settlement.y },
      );
      expect(distance).toBeGreaterThan(0);
      const expectedOffererDurationMs = travelTimeMs(
        config,
        distance,
        merchantSpeed(config, 'raiders'),
      );
      const expectedAccepterDurationMs = travelTimeMs(
        config,
        distance,
        merchantSpeed(config, 'nomads'),
      );
      expect(expectedOffererDurationMs).not.toBe(expectedAccepterDurationMs);
      expect(offererLeg!.arriveAt - offererLeg!.departAt).toBe(expectedOffererDurationMs);
      expect(accepterLeg!.arriveAt - accepterLeg!.departAt).toBe(expectedAccepterDurationMs);
      expect(offererLeg!.arriveAt).not.toBe(accepterLeg!.arriveAt);

      // busyMerchants rose by exactly each side's own requirement at acceptance, and the
      // offerer's `give` was NOT deducted a second time (M3d.2 already deducted it at
      // creation) — only the accepter's `want` is deducted here.
      const offererAfterAccept = await settlementModel.findById(offerer.settlement._id);
      const accepterAfterAccept = await settlementModel.findById(accepter.settlement._id);
      expect(offererAfterAccept?.busyMerchants).toBe(expectedOffererMerchants);
      expect(accepterAfterAccept?.busyMerchants).toBe(expectedAccepterMerchants);
      expect(offererAfterAccept?.resources.values.scrap).toBeCloseTo(
        PLENTY_RESOURCES.scrap - GIVE_AMOUNT,
        6,
      );
      expect(accepterAfterAccept?.resources.values.fuel).toBeCloseTo(
        PLENTY_RESOURCES.fuel - WANT_AMOUNT,
        6,
      );

      // The pending `tradeOfferExpire` EVENT is deleted the instant the offer is accepted
      // (owner decision F's double-spend hole, closed at acceptance already — the dedicated
      // test below re-checks this by advancing the scheduler; this is just the immediate
      // fact). The OFFER document's own `expireEventId` field is deliberately left as-is,
      // pointing at a now-deleted event — the same "stale reference on a terminal document"
      // convention `cancelOffer` already established (it doesn't unset the field either):
      // nothing ever reads `expireEventId` again once `status` leaves `'open'`.
      const expireEventGone = await eventModel.findOne({
        type: 'tradeOfferExpire',
        'payload.offerId': offerId,
      });
      expect(expireEventGone).toBeNull();

      // Drive both legs' arrivals through the real scheduler.
      await forceArrive(offererToAccepterMovementId);
      await forceArrive(accepterToOffererMovementId);

      const accepterAfterDelivery = await settlementModel.findById(accepter.settlement._id);
      expect(accepterAfterDelivery?.resources.values.scrap).toBeCloseTo(
        PLENTY_RESOURCES.scrap + GIVE_AMOUNT,
        6,
      );
      const offererAfterDelivery = await settlementModel.findById(offerer.settlement._id);
      expect(offererAfterDelivery?.resources.values.fuel).toBeCloseTo(
        PLENTY_RESOURCES.fuel + WANT_AMOUNT,
        6,
      );
      // Both legs turned around — `cargo` cleared (already delivered), still occupying
      // merchants (not yet freed — that's the return's job, below).
      expect((await movementModel.findById(offererToAccepterMovementId))?.status).toBe('returning');
      expect((await movementModel.findById(offererToAccepterMovementId))?.cargo).toBeUndefined();
      expect((await movementModel.findById(accepterToOffererMovementId))?.status).toBe('returning');
      expect((await movementModel.findById(accepterToOffererMovementId))?.cargo).toBeUndefined();
      expect((await settlementModel.findById(offerer.settlement._id))?.busyMerchants).toBe(
        expectedOffererMerchants,
      );
      expect((await settlementModel.findById(accepter.settlement._id))?.busyMerchants).toBe(
        expectedAccepterMerchants,
      );

      // §15's report allocation: exactly ONE `trade` report per party — never zero, never
      // four — each created by the RECEIVING leg's arrival above.
      expect(await reportModel.countDocuments({ type: 'trade' })).toBe(2);
      const accepterReportAfterArrival = await reportModel.findOne({
        accountId: accepter.session.accountId,
        type: 'trade',
      });
      expect(accepterReportAfterArrival?.payload['tradeOfferId']).toBe(offerId);
      expect(accepterReportAfterArrival?.payload['resourcesDelivered']).toMatchObject({
        scrap: GIVE_AMOUNT,
      });
      expect(accepterReportAfterArrival?.payload['merchantsFreed']).toBe(false);
      const offererReportAfterArrival = await reportModel.findOne({
        accountId: offerer.session.accountId,
        type: 'trade',
      });
      expect(offererReportAfterArrival?.payload['resourcesDelivered']).toMatchObject({
        fuel: WANT_AMOUNT,
      });
      expect(offererReportAfterArrival?.payload['merchantsFreed']).toBe(false);

      // Drive both legs' returns — merchants come home and free up, `status: 'done'`.
      await forceReturn(offererToAccepterMovementId);
      await forceReturn(accepterToOffererMovementId);

      const offererFinal = await settlementModel.findById(offerer.settlement._id);
      const accepterFinal = await settlementModel.findById(accepter.settlement._id);
      // busyMerchants falls back to EXACTLY its prior value (0) on both sides — not merely
      // "lower", exactly back to where it started.
      expect(offererFinal?.busyMerchants).toBe(0);
      expect(accepterFinal?.busyMerchants).toBe(0);
      // The offerer's `scrap` never moved again after the single creation-time deduction —
      // the double-spend this step's own brief calls out as "the single most likely bug".
      expect(offererFinal?.resources.values.scrap).toBeCloseTo(
        PLENTY_RESOURCES.scrap - GIVE_AMOUNT,
        6,
      );
      expect(offererFinal?.resources.values.fuel).toBeCloseTo(
        PLENTY_RESOURCES.fuel + WANT_AMOUNT,
        6,
      );
      expect(accepterFinal?.resources.values.fuel).toBeCloseTo(
        PLENTY_RESOURCES.fuel - WANT_AMOUNT,
        6,
      );
      expect(accepterFinal?.resources.values.scrap).toBeCloseTo(
        PLENTY_RESOURCES.scrap + GIVE_AMOUNT,
        6,
      );

      expect((await movementModel.findById(offererToAccepterMovementId))?.status).toBe('done');
      expect((await movementModel.findById(accepterToOffererMovementId))?.status).toBe('done');

      // Still exactly two reports — the returns UPDATED the two reports the arrivals already
      // created, never minted new ones.
      expect(await reportModel.countDocuments({ type: 'trade' })).toBe(2);
      const accepterReportFinal = await reportModel.findOne({
        accountId: accepter.session.accountId,
        type: 'trade',
      });
      expect(accepterReportFinal?.payload['merchantsFreed']).toBe(true);
      const offererReportFinal = await reportModel.findOne({
        accountId: offerer.session.accountId,
        type: 'trade',
      });
      expect(offererReportFinal?.payload['merchantsFreed']).toBe(true);
    });

    // Shared by every rejection test below: asserts the command changed absolutely nothing —
    // no settlement resources, no busyMerchants, no movement created, and the offer's own
    // status untouched. Mirrors `expectRejectedAndUnchanged`'s convention above, widened to
    // the two-settlement, two-account shape this command has.
    async function expectAcceptRejectedAndUnchanged(
      offererSettlementId: Types.ObjectId,
      accepterSettlementId: Types.ObjectId,
      offerId: string,
      response: request.Response,
      expectedKey: string,
      expectedStatusCode = 400,
    ): Promise<void> {
      expect(response.status).toBe(expectedStatusCode);
      expect(response.body.error.key).toBe(expectedKey);

      const offererAfter = await settlementModel.findById(offererSettlementId);
      const accepterAfter = await settlementModel.findById(accepterSettlementId);
      expect(offererAfter?.busyMerchants).toBe(0);
      expect(accepterAfter?.busyMerchants).toBe(0);
      expect(await movementModel.countDocuments({})).toBe(0);
      const offerDoc = await tradeOfferModel.findById(offerId);
      expect(offerDoc?.status).toBe('open');
    }

    it('accepting your own offer is rejected with ownOffer, no partial writes', async () => {
      const { session, settlement } = await makeTraderWithMarket('raiders');
      const createResponse = await postCreateOffer(session.cookie, {
        fromSettlementId: String(settlement._id),
        give: { resource: 'scrap', amount: GIVE_AMOUNT },
        want: { resource: 'fuel', amount: WANT_AMOUNT },
      });
      const offerId = createResponse.body.id as string;

      // A second settlement of the SAME account — accepting from your own other settlement
      // is still a self-accept (owner decision reasoning is about the ACCOUNT, not the
      // settlement).
      const otherSettlement = await seedMarketSettlement(session.accountId);
      const response = await postAcceptOffer(session.cookie, offerId, {
        fromSettlementId: String(otherSettlement._id),
      });
      await expectAcceptRejectedAndUnchanged(
        settlement._id,
        otherSettlement._id,
        offerId,
        response,
        'errors.market.ownOffer',
      );
    });

    it('accepting a non-open (already accepted) offer is rejected with offerNotOpen', async () => {
      const { offerer, accepter, offerId } = await postOfferAndAccept('raiders', 'nomads');
      const stranger = await makeTraderWithMarket('engineers');

      const response = await postAcceptOffer(stranger.session.cookie, offerId, {
        fromSettlementId: String(stranger.settlement._id),
      });
      expect(response.status).toBe(400);
      expect(response.body.error.key).toBe('errors.market.offerNotOpen');

      // The FIRST acceptance's own effects are untouched by the second, rejected attempt.
      const offererAfter = await settlementModel.findById(offerer.settlement._id);
      const accepterAfter = await settlementModel.findById(accepter.settlement._id);
      expect(offererAfter?.busyMerchants).toBe(merchantsNeededFor(config, 'raiders', GIVE_AMOUNT));
      expect(accepterAfter?.busyMerchants).toBe(merchantsNeededFor(config, 'nomads', WANT_AMOUNT));
      // The stranger never paid anything.
      const strangerAfter = await settlementModel.findById(stranger.settlement._id);
      expect(strangerAfter?.resources.values.fuel).toBeCloseTo(PLENTY_RESOURCES.fuel, 6);
      expect(strangerAfter?.busyMerchants).toBe(0);
    });

    it('insufficient merchants on the OFFERER side is rejected with notEnoughMerchants, no partial writes', async () => {
      const offerer = await makeTraderWithMarket('raiders');
      const accepter = await makeTraderWithMarket('nomads');
      const createResponse = await postCreateOffer(offerer.session.cookie, {
        fromSettlementId: String(offerer.settlement._id),
        give: { resource: 'scrap', amount: GIVE_AMOUNT },
        want: { resource: 'fuel', amount: WANT_AMOUNT },
      });
      const offerId = createResponse.body.id as string;
      // Simulate the offerer's Market level 1 settlement already having its one merchant tied
      // up by some other, earlier accepted trade — directly via Mongoose, the same "seed the
      // exact scenario a test needs" convention the storage-clamp test above already uses.
      await settlementModel.updateOne(
        { _id: offerer.settlement._id },
        { $set: { busyMerchants: 1 } },
      );

      const response = await postAcceptOffer(accepter.session.cookie, offerId, {
        fromSettlementId: String(accepter.settlement._id),
      });
      expect(response.status).toBe(400);
      expect(response.body.error.key).toBe('errors.market.notEnoughMerchants');
      expect(response.body.error.params.side).toBe('offerer');
      expect(response.body.error.params.required).toBe(
        merchantsNeededFor(config, 'raiders', GIVE_AMOUNT),
      );
      expect(response.body.error.params.available).toBe(0);

      const offererAfter = await settlementModel.findById(offerer.settlement._id);
      const accepterAfter = await settlementModel.findById(accepter.settlement._id);
      expect(offererAfter?.busyMerchants).toBe(1); // unchanged — the simulated pre-existing 1
      expect(offererAfter?.resources.values.scrap).toBeCloseTo(
        PLENTY_RESOURCES.scrap - GIVE_AMOUNT,
        6,
      );
      expect(accepterAfter?.busyMerchants).toBe(0);
      expect(accepterAfter?.resources.values.fuel).toBeCloseTo(PLENTY_RESOURCES.fuel, 6);
      expect((await tradeOfferModel.findById(offerId))?.status).toBe('open');
      expect(await movementModel.countDocuments({})).toBe(0);
    });

    it('insufficient merchants on the ACCEPTER side is rejected with notEnoughMerchants, no partial writes', async () => {
      const offerer = await makeTraderWithMarket('raiders');
      const accepter = await makeTraderWithMarket('nomads');
      const createResponse = await postCreateOffer(offerer.session.cookie, {
        fromSettlementId: String(offerer.settlement._id),
        give: { resource: 'scrap', amount: GIVE_AMOUNT },
        want: { resource: 'fuel', amount: WANT_AMOUNT },
      });
      const offerId = createResponse.body.id as string;
      await settlementModel.updateOne(
        { _id: accepter.settlement._id },
        { $set: { busyMerchants: 1 } },
      );

      const response = await postAcceptOffer(accepter.session.cookie, offerId, {
        fromSettlementId: String(accepter.settlement._id),
      });
      expect(response.status).toBe(400);
      expect(response.body.error.key).toBe('errors.market.notEnoughMerchants');
      expect(response.body.error.params.side).toBe('accepter');
      expect(response.body.error.params.required).toBe(
        merchantsNeededFor(config, 'nomads', WANT_AMOUNT),
      );
      expect(response.body.error.params.available).toBe(0);

      const offererAfter = await settlementModel.findById(offerer.settlement._id);
      const accepterAfter = await settlementModel.findById(accepter.settlement._id);
      expect(offererAfter?.busyMerchants).toBe(0);
      expect(accepterAfter?.busyMerchants).toBe(1); // unchanged — the simulated pre-existing 1
      expect(accepterAfter?.resources.values.fuel).toBeCloseTo(PLENTY_RESOURCES.fuel, 6);
      expect((await tradeOfferModel.findById(offerId))?.status).toBe('open');
      expect(await movementModel.countDocuments({})).toBe(0);
    });

    it('an accepter who cannot afford `want` is rejected with insufficientResources, no partial writes', async () => {
      const offerer = await makeTraderWithMarket('raiders');
      const accepter = await makeTraderWithMarket('nomads', {
        resources: { scrap: 3_000, fuel: 50, electronics: 3_000, food: 3_000 },
      });
      const createResponse = await postCreateOffer(offerer.session.cookie, {
        fromSettlementId: String(offerer.settlement._id),
        give: { resource: 'scrap', amount: GIVE_AMOUNT },
        want: { resource: 'fuel', amount: WANT_AMOUNT },
      });
      const offerId = createResponse.body.id as string;

      const response = await postAcceptOffer(accepter.session.cookie, offerId, {
        fromSettlementId: String(accepter.settlement._id),
      });
      expect(response.status).toBe(400);
      expect(response.body.error.key).toBe('errors.market.insufficientResources');
      expect(response.body.error.params.resource).toBe('fuel');
      expect(response.body.error.params.required).toBe(WANT_AMOUNT);
      expect(response.body.error.params.available).toBe(50);

      const offererAfter = await settlementModel.findById(offerer.settlement._id);
      const accepterAfter = await settlementModel.findById(accepter.settlement._id);
      expect(offererAfter?.busyMerchants).toBe(0);
      expect(accepterAfter?.busyMerchants).toBe(0);
      expect(accepterAfter?.resources.values.fuel).toBeCloseTo(50, 6);
      expect((await tradeOfferModel.findById(offerId))?.status).toBe('open');
      expect(await movementModel.countDocuments({})).toBe(0);
    });

    it('the accepted offer’s expire event is gone: advancing the scheduler past the original expiresAt refunds nothing, status stays accepted', async () => {
      const { offerer, offerId } = await postOfferAndAccept('raiders', 'nomads');

      const offererAfterAccept = await settlementModel.findById(offerer.settlement._id);
      const scrapAfterAccept = offererAfterAccept?.resources.values.scrap;

      // The event was already deleted at acceptance (owner decision F's double-spend hole) —
      // confirm it is really gone, then run the scheduler anyway to prove there is nothing
      // left for it to (wrongly) act on.
      const expireEvent = await eventModel.findOne({
        type: 'tradeOfferExpire',
        'payload.offerId': offerId,
      });
      expect(expireEvent).toBeNull();
      await schedulerService.runOnce();

      const offererAfterSchedulerRun = await settlementModel.findById(offerer.settlement._id);
      expect(offererAfterSchedulerRun?.resources.values.scrap).toBeCloseTo(scrapAfterAccept!, 6);
      expect((await tradeOfferModel.findById(offerId))?.status).toBe('accepted');
    });

    it('cargo delivery is clamped to the destination’s storage cap, overflow lost, and the loss is reported', async () => {
      const { accepter, offerId, acceptResponse } = await postOfferAndAccept('raiders', 'nomads');
      const offererToAccepterMovementId = acceptResponse.body.offererToAccepterMovementId as string;

      const caps = calcStorageCaps(config, [
        { type: 'commandCenter', level: 1 },
        { type: 'market', level: 1 },
      ]);
      const headroom = 200;
      expect(headroom).toBeLessThan(GIVE_AMOUNT); // otherwise this test would not actually clamp
      await settlementModel.updateOne(
        { _id: accepter.settlement._id },
        {
          $set: {
            'resources.values.scrap': caps.scrap - headroom,
            'resources.lastCalcAt': Date.now(),
          },
        },
      );

      await forceArrive(offererToAccepterMovementId);

      const accepterAfter = await settlementModel.findById(accepter.settlement._id);
      expect(accepterAfter?.resources.values.scrap).toBeCloseTo(caps.scrap, 6);

      const report = await reportModel.findOne({
        accountId: accepter.session.accountId,
        type: 'trade',
        'payload.tradeOfferId': offerId,
      });
      expect(report?.payload['resourcesDelivered']).toMatchObject({ scrap: headroom });
      expect(report?.payload['resourcesLost']).toMatchObject({ scrap: GIVE_AMOUNT - headroom });
    });

    it('replay safety: running the arrival event twice delivers cargo exactly once', async () => {
      const { accepter, acceptResponse } = await postOfferAndAccept('raiders', 'nomads');
      const offererToAccepterMovementId = acceptResponse.body.offererToAccepterMovementId as string;

      const event = await eventModel.findOne({
        type: 'movementArrive',
        'payload.movementId': offererToAccepterMovementId,
      });
      expect(event).not.toBeNull();
      const confirmedEvent = event!;

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
      const afterFirst = await settlementModel.findById(accepter.settlement._id);
      expect(afterFirst?.resources.values.scrap).toBeCloseTo(
        PLENTY_RESOURCES.scrap + GIVE_AMOUNT,
        6,
      );
      expect((await movementModel.findById(offererToAccepterMovementId))?.status).toBe('returning');
      expect(await reportModel.countDocuments({ type: 'trade' })).toBe(1);

      await replayArrive();
      const afterSecond = await settlementModel.findById(accepter.settlement._id);
      expect(afterSecond?.resources.values.scrap).toBeCloseTo(
        afterFirst!.resources.values.scrap,
        6,
      );
      expect(await reportModel.countDocuments({ type: 'trade' })).toBe(1);
    });

    it('replay safety: running the return event twice frees merchants exactly once', async () => {
      const { offerer, acceptResponse } = await postOfferAndAccept('raiders', 'nomads');
      const offererToAccepterMovementId = acceptResponse.body.offererToAccepterMovementId as string;
      await forceArrive(offererToAccepterMovementId);

      const event = await eventModel.findOne({
        type: 'movementReturn',
        'payload.movementId': offererToAccepterMovementId,
      });
      expect(event).not.toBeNull();
      const confirmedEvent = event!;

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
      const afterFirst = await settlementModel.findById(offerer.settlement._id);
      expect(afterFirst?.busyMerchants).toBe(0);
      expect((await movementModel.findById(offererToAccepterMovementId))?.status).toBe('done');

      await replayReturn();
      const afterSecond = await settlementModel.findById(offerer.settlement._id);
      // Floored at 0, not driven negative by a second, redundant subtraction.
      expect(afterSecond?.busyMerchants).toBe(0);
    });

    it('the playbook race: two accounts accepting the same offer concurrently — exactly one succeeds, merchants and resources move exactly once', async () => {
      const offerer = await makeTraderWithMarket('raiders');
      // Both bob and carol need a faction whose merchant capacity covers `WANT_AMOUNT` in a
      // single merchant (raiders 1000, nomads 750 both do; engineers' 500 would not, which
      // would make an unlucky loser fail on `notEnoughMerchants` instead of `offerNotOpen` —
      // a second, unrelated rejection reason this test must not accidentally introduce).
      const bob = await makeTraderWithMarket('nomads');
      const carol = await makeTraderWithMarket('raiders');
      const createResponse = await postCreateOffer(offerer.session.cookie, {
        fromSettlementId: String(offerer.settlement._id),
        give: { resource: 'scrap', amount: GIVE_AMOUNT },
        want: { resource: 'fuel', amount: WANT_AMOUNT },
      });
      const offerId = createResponse.body.id as string;

      const [responseA, responseB] = await Promise.all([
        postAcceptOffer(bob.session.cookie, offerId, {
          fromSettlementId: String(bob.settlement._id),
        }),
        postAcceptOffer(carol.session.cookie, offerId, {
          fromSettlementId: String(carol.settlement._id),
        }),
      ]);

      const statuses = [responseA.status, responseB.status].sort();
      expect(statuses).toEqual([200, 400]);
      const failure = responseA.status === 400 ? responseA : responseB;
      expect(failure.body.error.key).toBe('errors.market.offerNotOpen');

      // `Promise.all` preserves input order in its output array regardless of which promise
      // actually settles first — `responseA` is always bob's own response, `responseB`
      // always carol's — so `responseA.status === 200` is exactly "bob won", not a guess.
      // Bob (nomads) and carol (engineers) have DIFFERENT merchant capacities, so the
      // winner's expected `busyMerchants` depends on which of the two actually won.
      const bobWon = responseA.status === 200;
      const winnerFaction: Faction = bobWon ? 'nomads' : 'raiders';
      const bobAfter = await settlementModel.findById(bob.settlement._id);
      const carolAfter = await settlementModel.findById(carol.settlement._id);
      const winnerAfter = bobWon ? bobAfter : carolAfter;
      const loserAfter = bobWon ? carolAfter : bobAfter;
      expect(winnerAfter?.busyMerchants).toBe(
        merchantsNeededFor(config, winnerFaction, WANT_AMOUNT),
      );
      expect(winnerAfter?.resources.values.fuel).toBeCloseTo(
        PLENTY_RESOURCES.fuel - WANT_AMOUNT,
        6,
      );
      expect(loserAfter?.busyMerchants).toBe(0);
      expect(loserAfter?.resources.values.fuel).toBeCloseTo(PLENTY_RESOURCES.fuel, 6);

      // The offerer's own side moved exactly once, regardless of who won.
      const offererAfter = await settlementModel.findById(offerer.settlement._id);
      expect(offererAfter?.busyMerchants).toBe(merchantsNeededFor(config, 'raiders', GIVE_AMOUNT));
      expect(await movementModel.countDocuments({})).toBe(2);
      expect((await tradeOfferModel.findById(offerId))?.status).toBe('accepted');
    });
  });

  // M3d.4: the world exchange (§14) — a faceless, counterparty-free conversion. Deliberately
  // NOT a movement (§14: "nothing travels on the map"); every test below drives it through
  // `POST /api/market/exchange` and the real scheduler (`forceExchangeComplete`), the same
  // `MongoMemoryReplSet` + `SCHEDULER_ENABLED=false` + manual `runOnce()` convention this whole
  // file already established for the offer board and trade acceptance above.
  describe('exchange (§14, M3d.4 — the world exchange)', () => {
    it('the §20 acceptance criterion: the exchange converts at exactly the configured spread — resources deducted and merchants occupied at start, output credited and merchants freed on completion, every number matching game-core', async () => {
      const { session, settlement } = await makeTraderWithMarket('raiders');
      const amount = 800; // raiders capacity 1000 -> exactly 1 merchant needed
      const now = Date.now();

      const response = await postExchange(session.cookie, {
        fromSettlementId: String(settlement._id),
        from: 'scrap',
        to: 'fuel',
        amount,
      });
      expect(response.status).toBe(201);
      expect(response.body.status).toBe('pending');
      expect(response.body.amount).toBe(amount);
      expect(response.body.from).toBe('scrap');
      expect(response.body.to).toBe('fuel');

      const expectedOutput = exchangeOutput(config, 'scrap', 'fuel', amount);
      expect(response.body.output).toBeCloseTo(expectedOutput, 9);
      const expectedMerchants = merchantsNeededFor(config, 'raiders', amount);
      expect(response.body.merchantsOccupied).toBe(expectedMerchants);
      expect(response.body.completesAt).toBeGreaterThanOrEqual(
        now + config.market.exchangeTripMs - 1_000,
      );
      expect(response.body.completesAt).toBeLessThanOrEqual(
        now + config.market.exchangeTripMs + 5_000,
      );

      // Deducted from `from`, merchants occupied — both immediately, at start.
      const afterStart = await settlementModel.findById(settlement._id);
      expect(afterStart?.resources.values.scrap).toBeCloseTo(PLENTY_RESOURCES.scrap - amount, 6);
      expect(afterStart?.resources.values.fuel).toBeCloseTo(PLENTY_RESOURCES.fuel, 6);
      expect(afterStart?.busyMerchants).toBe(expectedMerchants);

      const exchangeId = response.body.id as string;
      const completeEvent = await eventModel.findOne({
        type: 'marketExchange',
        'payload.exchangeId': exchangeId,
      });
      expect(completeEvent).not.toBeNull();
      expect(completeEvent?.status).toBe('due');
      expect(completeEvent?.dueAt).toBe(response.body.completesAt);

      const exchangeDoc = await marketExchangeModel.findById(exchangeId);
      expect(exchangeDoc?.status).toBe('pending');
      expect(exchangeDoc?.completeEventId?.toString()).toBe(String(completeEvent?._id));
      expect(exchangeDoc?.merchantsOccupied).toBe(expectedMerchants);
      expect(exchangeDoc?.output).toBeCloseTo(expectedOutput, 9);

      // Drive the completion through the real scheduler.
      await forceExchangeComplete(exchangeId);

      const afterComplete = await settlementModel.findById(settlement._id);
      expect(afterComplete?.resources.values.fuel).toBeCloseTo(
        PLENTY_RESOURCES.fuel + expectedOutput,
        6,
      );
      // The `from` deduction happened once, at start — completion never touches it again.
      expect(afterComplete?.resources.values.scrap).toBeCloseTo(PLENTY_RESOURCES.scrap - amount, 6);
      expect(afterComplete?.busyMerchants).toBe(0);

      expect((await marketExchangeModel.findById(exchangeId))?.status).toBe('completed');
      expect((await eventModel.findById(completeEvent?._id))?.status).toBe('done');
    });

    describe('validation: every rejection path has its own stable key and changes nothing', () => {
      async function expectExchangeRejectedAndUnchanged(
        cookie: string[],
        settlementId: Types.ObjectId,
        body: Record<string, unknown>,
        expectedKey: string,
      ): Promise<void> {
        const before = await settlementModel.findById(settlementId);
        const exchangeCountBefore = await marketExchangeModel.countDocuments({});

        const response = await postExchange(cookie, {
          fromSettlementId: String(settlementId),
          ...body,
        });
        expect(response.status).toBe(400);
        expect(response.body.error.key).toBe(expectedKey);

        const after = await settlementModel.findById(settlementId);
        expect(after?.resources.values).toEqual(before?.resources.values);
        expect(after?.busyMerchants).toBe(before?.busyMerchants);
        expect(await marketExchangeModel.countDocuments({})).toBe(exchangeCountBefore);
      }

      it('no Market building at all -> errors.market.noMarket', async () => {
        const { session, settlement } = await makeTraderWithMarket('raiders', {
          buildings: [{ type: 'commandCenter', level: 1 }],
        });
        await expectExchangeRejectedAndUnchanged(
          session.cookie,
          settlement._id,
          { from: 'scrap', to: 'fuel', amount: 100 },
          'errors.market.noMarket',
        );
      });

      it('a guest account with no faction -> errors.market.noFaction', async () => {
        const guest = await createGuestSession();
        const settlement = await seedMarketSettlement(guest.accountId);
        await expectExchangeRejectedAndUnchanged(
          guest.cookie,
          settlement._id,
          { from: 'scrap', to: 'fuel', amount: 100 },
          'errors.market.noFaction',
        );
      });

      it('an unknown `from` resource -> errors.market.unknownResource', async () => {
        const { session, settlement } = await makeTraderWithMarket('raiders');
        await expectExchangeRejectedAndUnchanged(
          session.cookie,
          settlement._id,
          { from: 'plutonium', to: 'fuel', amount: 100 },
          'errors.market.unknownResource',
        );
      });

      it('an unknown `to` resource -> errors.market.unknownResource', async () => {
        const { session, settlement } = await makeTraderWithMarket('raiders');
        await expectExchangeRejectedAndUnchanged(
          session.cookie,
          settlement._id,
          { from: 'scrap', to: 'plutonium', amount: 100 },
          'errors.market.unknownResource',
        );
      });

      it('`from` and `to` name the same resource -> errors.market.sameResource', async () => {
        const { session, settlement } = await makeTraderWithMarket('raiders');
        await expectExchangeRejectedAndUnchanged(
          session.cookie,
          settlement._id,
          { from: 'scrap', to: 'scrap', amount: 100 },
          'errors.market.sameResource',
        );
      });

      it('a zero amount -> errors.market.invalidAmount', async () => {
        const { session, settlement } = await makeTraderWithMarket('raiders');
        await expectExchangeRejectedAndUnchanged(
          session.cookie,
          settlement._id,
          { from: 'scrap', to: 'fuel', amount: 0 },
          'errors.market.invalidAmount',
        );
      });

      it('a fractional amount -> errors.market.invalidAmount', async () => {
        const { session, settlement } = await makeTraderWithMarket('raiders');
        await expectExchangeRejectedAndUnchanged(
          session.cookie,
          settlement._id,
          { from: 'scrap', to: 'fuel', amount: 12.5 },
          'errors.market.invalidAmount',
        );
      });

      it('a negative amount -> errors.market.invalidAmount', async () => {
        const { session, settlement } = await makeTraderWithMarket('raiders');
        await expectExchangeRejectedAndUnchanged(
          session.cookie,
          settlement._id,
          { from: 'scrap', to: 'fuel', amount: -50 },
          'errors.market.invalidAmount',
        );
      });

      it('insufficient resources -> errors.market.insufficientResources', async () => {
        const { session, settlement } = await makeTraderWithMarket('raiders', {
          resources: { scrap: 50, fuel: 1_000_000, electronics: 1_000_000, food: 1_000_000 },
        });
        await expectExchangeRejectedAndUnchanged(
          session.cookie,
          settlement._id,
          { from: 'scrap', to: 'fuel', amount: 1000 },
          'errors.market.insufficientResources',
        );
      });

      it('not enough merchants (all already busy) -> errors.market.notEnoughMerchants, no partial writes', async () => {
        const { session, settlement } = await makeTraderWithMarket('raiders');
        // Market level 1 -> exactly 1 total merchant (`merchantsFromMarketLevel`); simulate it
        // already tied up by some other, earlier exchange/accepted trade.
        await settlementModel.updateOne({ _id: settlement._id }, { $set: { busyMerchants: 1 } });

        const response = await postExchange(session.cookie, {
          fromSettlementId: String(settlement._id),
          from: 'scrap',
          to: 'fuel',
          amount: 100,
        });
        expect(response.status).toBe(400);
        expect(response.body.error.key).toBe('errors.market.notEnoughMerchants');
        expect(response.body.error.params.required).toBe(
          merchantsNeededFor(config, 'raiders', 100),
        );
        expect(response.body.error.params.available).toBe(0);

        const after = await settlementModel.findById(settlement._id);
        expect(after?.resources.values.scrap).toBeCloseTo(PLENTY_RESOURCES.scrap, 6);
        expect(after?.busyMerchants).toBe(1); // unchanged — the simulated pre-existing 1
        expect(await marketExchangeModel.countDocuments({})).toBe(0);
      });
    });

    it('output is clamped to the destination’s storage cap, overflow lost', async () => {
      const { session, settlement } = await makeTraderWithMarket('raiders');
      const amount = 800;
      const expectedOutput = exchangeOutput(config, 'scrap', 'fuel', amount);
      const caps = calcStorageCaps(config, [
        { type: 'commandCenter', level: 1 },
        { type: 'market', level: 1 },
      ]);
      const headroom = expectedOutput / 2;
      expect(headroom).toBeGreaterThan(0);
      expect(headroom).toBeLessThan(expectedOutput); // otherwise this test would not actually clamp

      const response = await postExchange(session.cookie, {
        fromSettlementId: String(settlement._id),
        from: 'scrap',
        to: 'fuel',
        amount,
      });
      expect(response.status).toBe(201);
      const exchangeId = response.body.id as string;

      // Simulate production having refilled the warehouse to near-full while the exchange was
      // in flight, leaving only `headroom` of headroom — the same "seed the exact scenario a
      // test needs" convention the offer-cancel clamp test above already uses.
      await settlementModel.updateOne(
        { _id: settlement._id },
        {
          $set: {
            'resources.values.fuel': caps.fuel - headroom,
            'resources.lastCalcAt': Date.now(),
          },
        },
      );

      await forceExchangeComplete(exchangeId);

      const after = await settlementModel.findById(settlement._id);
      expect(after?.resources.values.fuel).toBeCloseTo(caps.fuel, 6);
      // Merchants are freed regardless of the clamp — the clamp only affects the resource
      // credit, never the merchant accounting.
      expect(after?.busyMerchants).toBe(0);
    });

    it('replay safety: running the completion event twice credits exactly once', async () => {
      const { session, settlement } = await makeTraderWithMarket('raiders');
      const amount = 800;
      const response = await postExchange(session.cookie, {
        fromSettlementId: String(settlement._id),
        from: 'scrap',
        to: 'fuel',
        amount,
      });
      const exchangeId = response.body.id as string;

      await forceExchangeComplete(exchangeId);
      const event = await eventModel.findOne({
        type: 'marketExchange',
        'payload.exchangeId': exchangeId,
      });
      expect(event).not.toBeNull();
      const confirmedEvent = event!;

      const afterFirst = await settlementModel.findById(settlement._id);
      expect(afterFirst?.busyMerchants).toBe(0);

      // Calls the handler directly a second time against a fresh session/transaction — the
      // exact replay-testing shape `docs/CONCURRENCY_PLAYBOOK.md` §6 prescribes, the same
      // pattern the `tradeOfferExpire`/`movementArrive`/`movementReturn` replay tests above
      // already use.
      const replaySession = await connection.startSession();
      try {
        await replaySession.withTransaction(async () => {
          await marketExchangeHandler.handle(confirmedEvent, replaySession);
        });
      } finally {
        await replaySession.endSession();
      }

      const afterReplay = await settlementModel.findById(settlement._id);
      expect(afterReplay?.resources.values.fuel).toBeCloseTo(afterFirst!.resources.values.fuel, 6);
      expect(afterReplay?.busyMerchants).toBe(0);
      expect(afterReplay?.version).toBe(afterFirst?.version);

      expect((await marketExchangeModel.findById(exchangeId))?.status).toBe('completed');
    });

    it('the playbook race: two concurrent exchanges from one settlement with only enough merchants for one — exactly one succeeds, busyMerchants never exceeds the total and never goes negative', async () => {
      const { session, settlement } = await makeTraderWithMarket('raiders');
      // Market level 1 -> exactly 1 total merchant; each request below needs exactly 1
      // (`merchantsNeededFor(config, 'raiders', 500)` fits in a single 1000-capacity
      // merchant), so at most one of the two concurrent requests can possibly succeed.
      const amount = 500;
      expect(merchantsNeededFor(config, 'raiders', amount)).toBe(1);
      expect(merchantsFromMarketLevel(config, 1)).toBe(1);

      const [responseA, responseB] = await Promise.all([
        postExchange(session.cookie, {
          fromSettlementId: String(settlement._id),
          from: 'scrap',
          to: 'fuel',
          amount,
        }),
        postExchange(session.cookie, {
          fromSettlementId: String(settlement._id),
          from: 'scrap',
          to: 'fuel',
          amount,
        }),
      ]);

      const statuses = [responseA.status, responseB.status].sort();
      expect(statuses).toEqual([201, 400]);
      const failure = responseA.status === 400 ? responseA : responseB;
      expect(failure.body.error.key).toBe('errors.market.notEnoughMerchants');

      const after = await settlementModel.findById(settlement._id);
      // Never exceeds the total (1), never negative — exactly the one winner's occupation.
      expect(after?.busyMerchants).toBe(1);
      // Deducted exactly once — the loser never touched `scrap`.
      expect(after?.resources.values.scrap).toBeCloseTo(PLENTY_RESOURCES.scrap - amount, 6);
      expect(await marketExchangeModel.countDocuments({})).toBe(1);
    });

    it('a round trip A -> B -> A leaves the player strictly poorer (the anti-abuse property), through the real API end to end', async () => {
      const { session, settlement } = await makeTraderWithMarket('raiders');
      const amount = 800; // scrap -> electronics, needs exactly 1 merchant (capacity 1000)
      expect(merchantsNeededFor(config, 'raiders', amount)).toBe(1);

      const firstLeg = await postExchange(session.cookie, {
        fromSettlementId: String(settlement._id),
        from: 'scrap',
        to: 'electronics',
        amount,
      });
      expect(firstLeg.status).toBe(201);
      const firstExchangeId = firstLeg.body.id as string;
      const electronicsGained = firstLeg.body.output as number;
      expect(electronicsGained).toBeGreaterThan(0);

      await forceExchangeComplete(firstExchangeId);
      const afterFirstLeg = await settlementModel.findById(settlement._id);
      // Merchants freed before starting the second leg — otherwise this settlement's single
      // Market-level-1 merchant could never fund a second exchange at all.
      expect(afterFirstLeg?.busyMerchants).toBe(0);
      expect(afterFirstLeg?.resources.values.electronics).toBeCloseTo(
        PLENTY_RESOURCES.electronics + electronicsGained,
        6,
      );

      // Convert the entire gained Electronics straight back to Scrap — a whole-number amount,
      // the same integer discipline every amount in this suite follows (§14/M3d.2's technical
      // decision on player-typed quantities).
      const secondAmount = Math.floor(electronicsGained);
      expect(secondAmount).toBeGreaterThan(0);
      expect(merchantsNeededFor(config, 'raiders', secondAmount)).toBe(1);

      const secondLeg = await postExchange(session.cookie, {
        fromSettlementId: String(settlement._id),
        from: 'electronics',
        to: 'scrap',
        amount: secondAmount,
      });
      expect(secondLeg.status).toBe(201);
      const secondExchangeId = secondLeg.body.id as string;
      const scrapReturned = secondLeg.body.output as number;

      await forceExchangeComplete(secondExchangeId);
      const final = await settlementModel.findById(settlement._id);
      expect(final?.busyMerchants).toBe(0);

      // The whole round trip strictly lost value: what came back is less than what was spent,
      // for any `exchangeSpread > 0` — §14's whole anti-abuse argument (`exchangeOutput`'s own
      // unit test proves this algebraically; this proves it through the real API/scheduler).
      expect(scrapReturned).toBeLessThan(amount);
      expect(final?.resources.values.scrap).toBeCloseTo(
        PLENTY_RESOURCES.scrap - amount + scrapReturned,
        6,
      );
      expect(final?.resources.values.scrap).toBeLessThan(PLENTY_RESOURCES.scrap);
      // Electronics round-tripped back to its exact starting balance — the loss shows up
      // entirely on the Scrap side, confirming this is a value loss, not resources vanishing
      // from an unrelated ledger entry.
      expect(final?.resources.values.electronics).toBeCloseTo(PLENTY_RESOURCES.electronics, 6);
    });
  });
});
