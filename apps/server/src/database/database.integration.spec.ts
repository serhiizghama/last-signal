import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Connection, Model } from 'mongoose';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { AccountDocument } from '../schemas/account.schema';
import { Account, AccountSchema } from '../schemas/account.schema';
import type { GameEventDocument } from '../schemas/event.schema';
import { GameEvent, GameEventSchema } from '../schemas/event.schema';
import type { SettlementDocument } from '../schemas/settlement.schema';
import { Settlement, SettlementSchema } from '../schemas/settlement.schema';
import type { WorldDocument } from '../schemas/world.schema';
import { World, WorldSchema } from '../schemas/world.schema';

// Proves the M1 schemas actually work against a real MongoDB replica set
// (transactions, unique indexes, defaults, float precision) — not just that
// they compile. `MongoMemoryReplSet` keeps this hermetic: no Docker needed
// for the test suite, only for local dev runtime (see docker-compose.yml).
describe('Database (integration)', () => {
  let replSet: MongoMemoryReplSet;
  let moduleRef: TestingModule;
  let connection: Connection;
  let accountModel: Model<AccountDocument>;
  let settlementModel: Model<SettlementDocument>;
  let eventModel: Model<GameEventDocument>;
  let worldModel: Model<WorldDocument>;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const uri = replSet.getUri('last-signal-db-test');

    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: Account.name, schema: AccountSchema },
          { name: Settlement.name, schema: SettlementSchema },
          { name: GameEvent.name, schema: GameEventSchema },
          { name: World.name, schema: WorldSchema },
        ]),
      ],
    }).compile();

    connection = moduleRef.get(getConnectionToken());
    accountModel = moduleRef.get(getModelToken(Account.name));
    settlementModel = moduleRef.get(getModelToken(Settlement.name));
    eventModel = moduleRef.get(getModelToken(GameEvent.name));
    worldModel = moduleRef.get(getModelToken(World.name));

    // Build every index (including the unique {x, y} compound one) before
    // any test relies on it — `create()` alone doesn't guarantee this.
    await Promise.all([
      accountModel.syncIndexes(),
      settlementModel.syncIndexes(),
      eventModel.syncIndexes(),
      worldModel.syncIndexes(),
    ]);
  }, 60_000);

  afterAll(async () => {
    await moduleRef.close();
    await replSet.stop();
  }, 60_000);

  afterEach(async () => {
    await Promise.all([
      accountModel.deleteMany({}),
      settlementModel.deleteMany({}),
      eventModel.deleteMany({}),
      worldModel.deleteMany({}),
    ]);
  });

  it('brings up the connection and registers every M1 model', () => {
    expect(connection.readyState).toBe(1);
    expect(accountModel).toBeDefined();
    expect(settlementModel).toBeDefined();
    expect(eventModel).toBeDefined();
    expect(worldModel).toBeDefined();
  });

  it('commits a multi-document transaction across two collections', async () => {
    const accountId = new Types.ObjectId();
    const session = await connection.startSession();

    try {
      await session.withTransaction(async () => {
        await accountModel.create([{ _id: accountId, name: 'Alice', isGuest: true }], { session });
        await settlementModel.create([{ accountId, name: 'Alpha Base', x: 1, y: 1 }], { session });
      });
    } finally {
      await session.endSession();
    }

    const account = await accountModel.findById(accountId);
    const settlement = await settlementModel.findOne({ accountId });
    expect(account).not.toBeNull();
    expect(settlement).not.toBeNull();
  });

  it('aborts a transaction cleanly, persisting neither write', async () => {
    const accountId = new Types.ObjectId();
    const session = await connection.startSession();

    await expect(
      session.withTransaction(async () => {
        await accountModel.create([{ _id: accountId, name: 'Bob', isGuest: true }], { session });
        await settlementModel.create([{ accountId, name: 'Doomed Base', x: 2, y: 2 }], { session });
        throw new Error('deliberate abort');
      }),
    ).rejects.toThrow('deliberate abort');
    await session.endSession();

    const account = await accountModel.findById(accountId);
    const settlement = await settlementModel.findOne({ accountId });
    expect(account).toBeNull();
    expect(settlement).toBeNull();
  });

  it('rejects a duplicate {x, y} tile with a duplicate-key error', async () => {
    const accountId = new Types.ObjectId();
    await settlementModel.create({ accountId, name: 'First', x: 5, y: 5 });

    await expect(
      settlementModel.create({ accountId, name: 'Second', x: 5, y: 5 }),
    ).rejects.toMatchObject({
      code: 11000,
    });
  });

  it('round-trips an events document with schema defaults applied', async () => {
    const created = await eventModel.create({
      type: 'buildComplete',
      dueAt: Date.now(),
      payload: { settlementId: 'abc' },
    });

    expect(created.status).toBe('due');
    expect(created.attempts).toBe(0);
    expect(created.payloadVersion).toBe(1);
    expect(typeof created.createdAt).toBe('number');

    const reloaded = await eventModel.findById(created._id);
    expect(reloaded?.status).toBe('due');
    expect(reloaded?.attempts).toBe(0);
    expect(reloaded?.payloadVersion).toBe(1);
  });

  it('round-trips a settlement with nested resource floats preserved exactly', async () => {
    const accountId = new Types.ObjectId();
    const created = await settlementModel.create({
      accountId,
      name: 'Float Base',
      x: 10,
      y: 10,
      resources: {
        values: { scrap: 123.456, fuel: 0.1, electronics: 7.89, food: 42 },
        lastCalcAt: Date.now(),
      },
    });

    const reloaded = await settlementModel.findById(created._id);
    expect(reloaded?.resources.values.scrap).toBe(123.456);
    expect(reloaded?.resources.values.fuel).toBe(0.1);
    expect(reloaded?.resources.values.electronics).toBe(7.89);
    expect(reloaded?.resources.values.food).toBe(42);
  });
});
