import { DEFAULT_CONFIG, generateOases } from '@last-signal/game-core';
import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Model } from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../app.module';
import type { OasisDocument } from '../schemas/oasis.schema';
import { Oasis } from '../schemas/oasis.schema';
import type { WorldDocument } from '../schemas/world.schema';
import { World } from '../schemas/world.schema';
import { WorldService } from './world.service';

// Tiles sort deterministically so two coordinate lists (actual vs. expected, or before vs.
// after a regenerate) can be compared as sets without caring about insertion/query order.
function byCoordinate(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return a.x - b.x || a.y - b.y;
}

// World bootstrap + the `oases` collection (M2a.3, `docs/M2_DESIGN_DECISIONS.md` §2, §12)
// against a real MongoDB replica set — same boot pattern as
// `settlements/settlement-creation.integration.spec.ts`: the whole `AppModule`, driven over
// HTTP with `supertest` for the dev endpoint and directly through the injected `WorldService`
// for bootstrap semantics that have no HTTP surface of their own.
describe('World bootstrap + oases (integration)', () => {
  let app: INestApplication;
  let replSet: MongoMemoryReplSet;
  let worldService: WorldService;
  let worldModel: Model<WorldDocument>;
  let oasisModel: Model<OasisDocument>;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    process.env['MONGODB_URI'] = replSet.getUri('last-signal-world-test');
    // NPC seeding is covered by its own suite (`npc/npc-seeder.integration.spec.ts`) — off
    // here so `app.init()`'s bootstrap stays fast and this file's oasis/world assertions
    // aren't sharing the database with 135 NPC accounts.
    process.env['WORLD_NPC_COUNT'] = '0';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    // `WorldService.onModuleInit` bootstraps the world as part of this call, against the
    // still-empty database above — exactly the "fresh dev/prod boot self-heals" path.
    await app.init();

    worldService = moduleRef.get(WorldService);
    worldModel = moduleRef.get(getModelToken(World.name));
    oasisModel = moduleRef.get(getModelToken(Oasis.name));
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await replSet.stop();
    delete process.env['MONGODB_URI'];
    delete process.env['WORLD_NPC_COUNT'];
  }, 60_000);

  afterEach(() => {
    delete process.env['NODE_ENV'];
  });

  it('booting against an empty DB leaves exactly one world document: a seed, round 1, act 1, no Source placed', async () => {
    const worlds = await worldModel.find({});
    expect(worlds).toHaveLength(1);

    const world = worlds[0]!;
    expect(typeof world.seed).toBe('string');
    expect(world.seed.length).toBeGreaterThan(0);
    expect(world.roundNumber).toBe(1);
    expect(world.act).toBe(1);
    expect(world.source.holderSide).toBeNull();
    expect(world.source.holderSince).toBeNull();
    expect(world.timeline).toEqual([]);
  });

  it('places exactly 24 oases matching generateOases(config, seed) for the stored seed', async () => {
    const world = await worldModel.findOne({});
    const expectedTiles = generateOases(DEFAULT_CONFIG, world!.seed);
    // Sanity: the default config's draft numbers (24 count, minDistance 5, edgeMargin 2 on a
    // radius-30 grid) are feasible, so this should never fall short of the target count.
    expect(expectedTiles).toHaveLength(24);

    const oases = await oasisModel.find({});
    expect(oases).toHaveLength(expectedTiles.length);
    expect(oases.every((oasis) => oasis.type === 'farm')).toBe(true);

    const actual = oases.map((oasis) => ({ x: oasis.x, y: oasis.y })).sort(byCoordinate);
    const expected = [...expectedTiles].sort(byCoordinate);
    expect(actual).toEqual(expected);
  });

  it('calling bootstrap again is a no-op: same seed, still one world document, still 24 oases', async () => {
    const before = await worldModel.findOne({});

    const result = await worldService.bootstrap(Date.now());
    expect(result.seed).toBe(before!.seed);

    const worlds = await worldModel.find({});
    expect(worlds).toHaveLength(1);
    expect(worlds[0]!.seed).toBe(before!.seed);

    const oases = await oasisModel.find({});
    expect(oases).toHaveLength(24);
  });

  it('two concurrent bootstrap calls against an empty DB produce exactly one world document and 24 oases, and neither throws', async () => {
    // Simulates the race this test targets: two callers both observing "no world yet".
    await worldModel.deleteMany({});
    await oasisModel.deleteMany({});

    const [resultA, resultB] = await Promise.all([
      worldService.bootstrap(Date.now()),
      worldService.bootstrap(Date.now()),
    ]);

    expect(resultA.seed).toBe(resultB.seed);

    const worlds = await worldModel.find({});
    expect(worlds).toHaveLength(1);
    expect(worlds[0]!.seed).toBe(resultA.seed);

    const oases = await oasisModel.find({});
    expect(oases).toHaveLength(24);
  });

  it('the dev regenerate endpoint produces a different seed and oasis set, and 404s once NODE_ENV=production', async () => {
    const before = await worldModel.findOne({});
    const beforeOases = (await oasisModel.find({}))
      .map((oasis) => ({ x: oasis.x, y: oasis.y }))
      .sort(byCoordinate);

    const response = await request(app.getHttpServer()).post('/api/dev/world/regenerate').send({});

    expect(response.status).toBe(201);
    expect(typeof response.body.seed).toBe('string');
    expect(response.body.seed).not.toBe(before!.seed);
    expect(response.body.oasisCount).toBe(24);

    const worlds = await worldModel.find({});
    expect(worlds).toHaveLength(1);
    expect(worlds[0]!.seed).toBe(response.body.seed);

    const afterOases = (await oasisModel.find({}))
      .map((oasis) => ({ x: oasis.x, y: oasis.y }))
      .sort(byCoordinate);
    expect(afterOases).toHaveLength(24);
    // Overwhelmingly likely to differ from a different random seed — not a mathematical
    // guarantee, but the same standard other stochastic checks in this suite rely on.
    expect(afterOases).not.toEqual(beforeOases);

    process.env['NODE_ENV'] = 'production';
    const prodResponse = await request(app.getHttpServer())
      .post('/api/dev/world/regenerate')
      .send({});
    expect(prodResponse.status).toBe(404);
  });
});
