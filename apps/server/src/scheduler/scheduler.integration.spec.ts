import { ConfigModule } from '@nestjs/config';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Connection, Model } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { GameEventDocument } from '../schemas/event.schema';
import { GameEvent } from '../schemas/event.schema';
import { EventHandlerRegistry } from './event-handler.registry';
import { EventSchedulerService } from './event-scheduler.service';
import { SchedulerModule } from './scheduler.module';
import { SchedulerService } from './scheduler.service';
import { RecordingEventHandler } from './test/recording-event.handler';

// Proves the scheduler engine end-to-end against a real MongoDB replica set
// (MongoMemoryReplSet, same pattern as database.integration.spec.ts). Time is
// driven deterministically throughout: tests call `schedulerService.runOnce()`
// directly instead of waiting on the real 1s timer, and "time passing" (for
// retry backoff / lease expiry) is simulated by writing timestamps straight
// into the document rather than sleeping on the wall clock.
describe('Scheduler (integration)', () => {
  let replSet: MongoMemoryReplSet;
  let moduleRef: TestingModule;
  let connection: Connection;
  let eventModel: Model<GameEventDocument>;
  let registry: EventHandlerRegistry;
  let schedulerService: SchedulerService;
  let eventSchedulerService: EventSchedulerService;
  let recordingHandler: RecordingEventHandler;

  const DEFAULT_LEASE_TIMEOUT_MS = 60_000;
  const DEFAULT_MAX_ATTEMPTS = 3;

  const overdue = (msAgo = 1_000): number => Date.now() - msAgo;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    process.env['MONGODB_URI'] = replSet.getUri('last-signal-scheduler-test');
    // The auto-timer would otherwise race with this suite's manual
    // `runOnce()` calls against the same events.
    process.env['SCHEDULER_ENABLED'] = 'false';

    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), SchedulerModule],
    }).compile();

    connection = moduleRef.get(getConnectionToken());
    eventModel = moduleRef.get(getModelToken(GameEvent.name));
    registry = moduleRef.get(EventHandlerRegistry);
    schedulerService = moduleRef.get(SchedulerService);
    eventSchedulerService = moduleRef.get(EventSchedulerService);

    await eventModel.syncIndexes();

    recordingHandler = new RecordingEventHandler(connection);
    registry.register(recordingHandler);
  }, 60_000);

  afterAll(async () => {
    await moduleRef.close();
    await replSet.stop();
    delete process.env['MONGODB_URI'];
    delete process.env['SCHEDULER_ENABLED'];
  }, 60_000);

  beforeEach(() => {
    recordingHandler.reset();
  });

  afterEach(async () => {
    await Promise.all([
      eventModel.deleteMany({}),
      connection.collection('scheduler-test-effects').deleteMany({}),
    ]);
  });

  async function effectCountFor(eventId: unknown): Promise<number> {
    return connection.collection('scheduler-test-effects').countDocuments({ eventId });
  }

  it('claims a due event, runs the handler, and marks it done with effects persisted', async () => {
    const event = await eventSchedulerService.scheduleEvent({
      type: 'testRecord',
      dueAt: overdue(),
      payload: { foo: 'bar' },
    });

    await schedulerService.runOnce();

    const reloaded = await eventModel.findById(event._id);
    expect(reloaded?.status).toBe('done');
    expect(reloaded?.processingStartedAt).toBeUndefined();
    expect(recordingHandler.handledEventIds).toEqual([String(event._id)]);
    expect(await effectCountFor(event._id)).toBe(1);
  });

  it('does not claim an event whose dueAt is in the future', async () => {
    const event = await eventSchedulerService.scheduleEvent({
      type: 'testRecord',
      dueAt: Date.now() + 60_000,
      payload: {},
    });

    await schedulerService.runOnce();

    const reloaded = await eventModel.findById(event._id);
    expect(reloaded?.status).toBe('due');
    expect(recordingHandler.handledEventIds).toEqual([]);
  });

  it('processes overdue events strictly in dueAt order, not insertion order', async () => {
    const base = overdue(10_000);
    // Inserted out of dueAt order on purpose.
    const second = await eventSchedulerService.scheduleEvent({
      type: 'testRecord',
      dueAt: base + 20,
      payload: { label: 'second' },
    });
    const first = await eventSchedulerService.scheduleEvent({
      type: 'testRecord',
      dueAt: base,
      payload: { label: 'first' },
    });
    const third = await eventSchedulerService.scheduleEvent({
      type: 'testRecord',
      dueAt: base + 40,
      payload: { label: 'third' },
    });

    await schedulerService.runOnce();

    expect(recordingHandler.handledEventIds).toEqual([
      String(first._id),
      String(second._id),
      String(third._id),
    ]);
  });

  it('leaves no partial write behind when a handler writes then throws', async () => {
    recordingHandler.failNextAttempts(1);
    const event = await eventSchedulerService.scheduleEvent({
      type: 'testRecord',
      dueAt: overdue(),
      payload: {},
    });

    await schedulerService.runOnce();

    expect(await effectCountFor(event._id)).toBe(0);
    expect(recordingHandler.handledEventIds).toEqual([]);
    const reloaded = await eventModel.findById(event._id);
    expect(reloaded?.status).toBe('due');
    expect(reloaded?.attempts).toBe(1);
    expect(reloaded?.lastError).toContain('deliberate test failure');
  });

  it('retries a throwing handler up to maxAttempts, then dead-letters it and stops retrying', async () => {
    recordingHandler.failNextAttempts(DEFAULT_MAX_ATTEMPTS + 2);
    const event = await eventSchedulerService.scheduleEvent({
      type: 'testRecord',
      dueAt: overdue(),
      payload: {},
    });

    for (let attempt = 1; attempt <= DEFAULT_MAX_ATTEMPTS; attempt += 1) {
      await schedulerService.runOnce();
      const reloaded = await eventModel.findById(event._id);
      expect(reloaded?.attempts).toBe(attempt);
      expect(reloaded?.lastError).toContain('deliberate test failure');

      if (attempt < DEFAULT_MAX_ATTEMPTS) {
        expect(reloaded?.status).toBe('due');
        // Simulate the backoff window having elapsed, deterministically —
        // no real sleep.
        await eventModel.updateOne({ _id: event._id }, { $set: { dueAt: overdue() } });
      } else {
        expect(reloaded?.status).toBe('failed');
      }
    }

    // Not retried afterward, even once due again.
    await eventModel.updateOne({ _id: event._id }, { $set: { dueAt: overdue() } });
    await schedulerService.runOnce();
    const finalState = await eventModel.findById(event._id);
    expect(finalState?.status).toBe('failed');
    expect(finalState?.attempts).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(recordingHandler.handledEventIds).toEqual([]);
    expect(await effectCountFor(event._id)).toBe(0);
  });

  it('does not claim an event that is already processing', async () => {
    const event = await eventSchedulerService.scheduleEvent({
      type: 'testRecord',
      dueAt: overdue(),
      payload: {},
    });
    const leaseStart = Date.now();
    await eventModel.updateOne(
      { _id: event._id },
      { $set: { status: 'processing', processingStartedAt: leaseStart } },
    );

    await schedulerService.runOnce();

    const reloaded = await eventModel.findById(event._id);
    expect(reloaded?.status).toBe('processing');
    expect(reloaded?.processingStartedAt).toBe(leaseStart);
    expect(recordingHandler.handledEventIds).toEqual([]);
  });

  it('sweeps an expired processing lease back to due and then processes it normally', async () => {
    const event = await eventSchedulerService.scheduleEvent({
      type: 'testRecord',
      dueAt: overdue(),
      payload: {},
    });
    await eventModel.updateOne(
      { _id: event._id },
      {
        $set: {
          status: 'processing',
          processingStartedAt: Date.now() - DEFAULT_LEASE_TIMEOUT_MS - 5_000,
        },
      },
    );

    await schedulerService.runOnce();

    const reloaded = await eventModel.findById(event._id);
    expect(reloaded?.status).toBe('done');
    expect(recordingHandler.handledEventIds).toEqual([String(event._id)]);
  });

  it('fails an event with an unknown type without retrying', async () => {
    const created = await eventModel.create({
      type: 'thisTypeDoesNotExist',
      dueAt: overdue(),
      payload: {},
    });

    await schedulerService.runOnce();

    let reloaded = await eventModel.findById(created._id);
    expect(reloaded?.status).toBe('failed');
    expect(reloaded?.lastError).toContain('No handler registered');
    expect(reloaded?.attempts).toBe(1);

    // Still due (in the past) but already failed — must not be reprocessed.
    await schedulerService.runOnce();
    reloaded = await eventModel.findById(created._id);
    expect(reloaded?.status).toBe('failed');
    expect(reloaded?.attempts).toBe(1);
  });

  it('fails an event with an unsupported payloadVersion without retrying', async () => {
    const event = await eventSchedulerService.scheduleEvent({
      type: 'testRecord',
      dueAt: overdue(),
      payload: {},
      payloadVersion: 99,
    });

    await schedulerService.runOnce();

    const reloaded = await eventModel.findById(event._id);
    expect(reloaded?.status).toBe('failed');
    expect(reloaded?.lastError).toContain('payloadVersion');
    expect(recordingHandler.handledEventIds).toEqual([]);
  });

  it('does not persist a scheduled event if the surrounding transaction aborts', async () => {
    const session = await connection.startSession();
    let createdId: unknown;

    await expect(
      session.withTransaction(async () => {
        const created = await eventSchedulerService.scheduleEvent(
          { type: 'testRecord', dueAt: overdue(), payload: {} },
          session,
        );
        createdId = created._id;
        throw new Error('deliberate abort');
      }),
    ).rejects.toThrow('deliberate abort');
    await session.endSession();

    const found = await eventModel.findById(createdId as string);
    expect(found).toBeNull();
  });
});
