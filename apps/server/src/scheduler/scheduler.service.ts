import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { Connection, Model } from 'mongoose';

import type { GameEventDocument } from '../schemas/event.schema';
import { GameEvent } from '../schemas/event.schema';
import { EventHandlerRegistry } from './event-handler.registry';
import {
  DEFAULT_LEASE_TIMEOUT_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_SCHEDULER_ENABLED,
  SCHEDULER_ENABLED_KEY,
  SCHEDULER_LEASE_TIMEOUT_MS_KEY,
  SCHEDULER_MAX_ATTEMPTS_KEY,
  SCHEDULER_POLL_INTERVAL_MS_KEY,
} from './scheduler.constants';

// Backoff is capped so a persistently-failing handler still gets retried at
// a bounded cadence rather than being pushed arbitrarily far into the future.
const MAX_BACKOFF_MS = 30_000;

// The event worker: a small in-process loop, not a new service. Every tick
// it (1) sweeps stuck `processing` events back to `due`, then (2) claims and
// dispatches due events one at a time, strictly in `dueAt` order, until none
// remain. See the design record's "Scheduler failure semantics" and
// "Concurrency playbook" sections — this class is the implementation of both.
@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);

  private readonly enabled: boolean;
  private readonly pollIntervalMs: number;
  private readonly leaseTimeoutMs: number;
  private readonly maxAttempts: number;

  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  private tickPromise: Promise<void> | undefined;

  constructor(
    @InjectModel(GameEvent.name) private readonly eventModel: Model<GameEventDocument>,
    @InjectConnection() private readonly connection: Connection,
    @Inject(EventHandlerRegistry) private readonly registry: EventHandlerRegistry,
    @Inject(ConfigService) configService: ConfigService,
  ) {
    this.enabled =
      configService.get<string>(SCHEDULER_ENABLED_KEY, String(DEFAULT_SCHEDULER_ENABLED)) !==
      'false';
    this.pollIntervalMs = Number(
      configService.get<string>(SCHEDULER_POLL_INTERVAL_MS_KEY, String(DEFAULT_POLL_INTERVAL_MS)),
    );
    this.leaseTimeoutMs = Number(
      configService.get<string>(SCHEDULER_LEASE_TIMEOUT_MS_KEY, String(DEFAULT_LEASE_TIMEOUT_MS)),
    );
    this.maxAttempts = Number(
      configService.get<string>(SCHEDULER_MAX_ATTEMPTS_KEY, String(DEFAULT_MAX_ATTEMPTS)),
    );
  }

  onModuleInit(): void {
    // SCHEDULER_ENABLED=false lets a test (or a one-off tool) construct the
    // app without the background loop fighting its own manual `runOnce()`
    // calls, or without needing a live Mongo connection to close cleanly.
    if (!this.enabled) {
      return;
    }
    this.scheduleNextTick();
  }

  // Stops cleanly: cancels the pending timer and awaits any tick already in
  // flight so nothing is left running (and no handle left open) once this
  // resolves — required for Nest's `app.close()` / Vitest teardown to exit
  // on their own.
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.tickPromise) {
      await this.tickPromise;
    }
  }

  private scheduleNextTick(): void {
    const timer = setTimeout(() => {
      this.tickPromise = this.runOnce()
        .catch((error: unknown) => {
          this.logger.error(
            'Scheduler tick failed',
            error instanceof Error ? error.stack : String(error),
          );
        })
        .finally(() => {
          this.tickPromise = undefined;
          if (!this.stopped) {
            this.scheduleNextTick();
          }
        });
    }, this.pollIntervalMs);
    // Never keeps the process alive on its own — only in-flight work does.
    timer.unref();
    this.timer = timer;
  }

  // The unit of work driven by the timer loop, and also the deterministic
  // hook tests call directly instead of waiting on the real 1s timer.
  async runOnce(): Promise<void> {
    await this.sweepExpiredLeases();
    for (;;) {
      const claimed = await this.claimNextDueEvent();
      if (!claimed) {
        return;
      }
      await this.dispatch(claimed);
    }
  }

  // Returns `processing` events whose lease has expired back to `due`,
  // preserving their original `dueAt` so replay order is unaffected — a
  // crashed worker's claim must not let its work get lost or reordered.
  private async sweepExpiredLeases(): Promise<void> {
    const staleBefore = Date.now() - this.leaseTimeoutMs;
    const result = await this.eventModel.updateMany(
      { status: 'processing', processingStartedAt: { $lte: staleBefore } },
      { $set: { status: 'due' }, $unset: { processingStartedAt: '' } },
    );
    if (result.modifiedCount > 0) {
      this.logger.warn(`Lease sweep returned ${result.modifiedCount} stuck event(s) to 'due'`);
    }
  }

  // Atomic claim: an event already `processing` (by this worker's own
  // unfinished lease, or — if a second process ever exists — another one)
  // simply doesn't match the `status: 'due'` filter, so it can't be claimed
  // twice. `findOneAndUpdate` performs the match-and-update as one atomic
  // operation, which is what makes claiming safe under concurrency at all.
  private async claimNextDueEvent(): Promise<GameEventDocument | null> {
    const now = Date.now();
    return this.eventModel.findOneAndUpdate(
      { status: 'due', dueAt: { $lte: now } },
      { $set: { status: 'processing', processingStartedAt: now } },
      { sort: { dueAt: 1 }, returnDocument: 'after' },
    );
  }

  private async dispatch(event: GameEventDocument): Promise<void> {
    const handler = this.registry.get(event.type);
    if (!handler) {
      await this.failUndeliverable(event, `No handler registered for event type "${event.type}"`);
      return;
    }
    if (!handler.supportedPayloadVersions.includes(event.payloadVersion)) {
      await this.failUndeliverable(
        event,
        `Handler for type "${event.type}" does not support payloadVersion ${event.payloadVersion} ` +
          `(supports: ${handler.supportedPayloadVersions.join(', ')})`,
      );
      return;
    }

    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        await handler.handle(event, session);
        // The handler's effects and this `done` mark commit — or, if either
        // throws, roll back — together, in the same transaction.
        await this.eventModel.updateOne(
          { _id: event._id },
          { $set: { status: 'done' }, $unset: { processingStartedAt: '' } },
          { session },
        );
      });
    } catch (error) {
      // Deliberately written outside the aborted transaction: the retry
      // bookkeeping (attempts/lastError/status) must survive even though the
      // handler's own writes just rolled back.
      await this.recordFailure(event, error);
    } finally {
      await session.endSession();
    }
  }

  // A structurally undeliverable event (unknown type, or a payload version
  // no registered handler understands) goes straight to `failed`. Retrying
  // can't fix either condition, so retrying would just be an infinite loop.
  private async failUndeliverable(event: GameEventDocument, message: string): Promise<void> {
    await this.eventModel.updateOne(
      { _id: event._id },
      {
        $set: { status: 'failed', lastError: message, attempts: event.attempts + 1 },
        $unset: { processingStartedAt: '' },
      },
    );
    this.logger.warn(`Event ${String(event._id)} (${event.type}) marked failed: ${message}`);
  }

  private async recordFailure(event: GameEventDocument, error: unknown): Promise<void> {
    const attempts = event.attempts + 1;
    const lastError = error instanceof Error ? error.message : String(error);

    if (attempts >= this.maxAttempts) {
      await this.eventModel.updateOne(
        { _id: event._id },
        { $set: { status: 'failed', attempts, lastError }, $unset: { processingStartedAt: '' } },
      );
      this.logger.error(
        `Event ${String(event._id)} (${event.type}) failed after ${attempts} attempts: ${lastError}`,
      );
      return;
    }

    const dueAt = Date.now() + this.computeBackoffMs(attempts);
    await this.eventModel.updateOne(
      { _id: event._id },
      { $set: { status: 'due', attempts, lastError, dueAt }, $unset: { processingStartedAt: '' } },
    );
    this.logger.warn(
      `Event ${String(event._id)} (${event.type}) attempt ${attempts} failed, retrying at ` +
        `${new Date(dueAt).toISOString()}: ${lastError}`,
    );
  }

  // Exponential, seeded by the poll interval: 1x, 2x, 4x, ... capped at
  // MAX_BACKOFF_MS, so retries land on a later tick rather than being
  // reclaimed instantly in the same sweep.
  private computeBackoffMs(attempts: number): number {
    return Math.min(this.pollIntervalMs * 2 ** (attempts - 1), MAX_BACKOFF_MS);
  }
}
