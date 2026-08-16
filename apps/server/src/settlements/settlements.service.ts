import { randomUUID } from 'node:crypto';

import type { GameConfig, Resources } from '@last-signal/game-core';
import {
  RESOURCE_KINDS,
  addResources,
  calcBuildCost,
  calcBuildTimeMs,
  calcInfluence,
  calcStorageCaps,
  canAfford,
  missingPrerequisites,
  settleResources,
  settlementsAllowed,
  subtractResources,
  wouldStarveSettlement,
} from '@last-signal/game-core';
import { Inject, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Connection, Model } from 'mongoose';
import { Types } from 'mongoose';

import { isDuplicateKeyError } from '../database/mongo-errors.util';
import { PlacementService } from '../placement/placement.service';
import { PlacementExhaustedError } from '../placement/placement.errors';
import { EventSchedulerService } from '../scheduler/event-scheduler.service';
import type { SettlementDocument } from '../schemas/settlement.schema';
import { Settlement } from '../schemas/settlement.schema';
import { promoteWaitingItems, toPlainQueueItem } from './build-queue.util';
import { GAME_CONFIG } from '../game-config/game-config.tokens';
import {
  ACTIVE_BUILD_SLOTS,
  BUILD_COMPLETE_EVENT_TYPE,
  MAX_COMMAND_ATTEMPTS,
  MAX_CREATE_SETTLEMENT_ATTEMPTS,
  STARTING_RESOURCES,
  WAITING_QUEUE_SLOTS,
} from './settlements.constants';
import {
  BuildCommandError,
  CommandConflictRetryExhaustedError,
  SettlementLimitReachedError,
  SettlementNotFoundError,
  VersionConflictError,
} from './settlements.errors';
import { currentLevelOf, isBuildingType, toBuildingLevels } from './settlements.util';
import type { SettlementStateView } from './settlements.view';
import { buildSettlementStateView } from './settlements.view';

// Every component of `cost` that `available` falls short of, keyed by resource kind —
// the `missing` param on `errors.build.insufficientResources`.
function shortfall(available: Resources, cost: Resources): Partial<Resources> {
  const missing: Partial<Resources> = {};
  for (const kind of RESOURCE_KINDS) {
    if (available[kind] < cost[kind]) {
      missing[kind] = cost[kind] - available[kind];
    }
  }
  return missing;
}

// Every component of `cost` that exceeds `caps` — the `exceeds` param on
// `errors.build.exceedsStorage`.
function overCap(cost: Resources, caps: Resources): Partial<Resources> {
  const exceeds: Partial<Resources> = {};
  for (const kind of RESOURCE_KINDS) {
    if (cost[kind] > caps[kind]) {
      exceeds[kind] = cost[kind] - caps[kind];
    }
  }
  return exceeds;
}

// Implements the build command flow end to end (§6, §11, §15 of the M1 design record):
// settling resources, enqueueing/cancelling a build under the version-guard concurrency
// playbook, and the read-side state view. See the concurrency-playbook comment on
// `runCommand` for the retry pattern every method here follows.
@Injectable()
export class SettlementsService {
  constructor(
    @InjectModel(Settlement.name) private readonly settlementModel: Model<SettlementDocument>,
    @InjectConnection() private readonly connection: Connection,
    @Inject(EventSchedulerService) private readonly eventScheduler: EventSchedulerService,
    @Inject(GAME_CONFIG) private readonly config: GameConfig,
    @Inject(ACTIVE_BUILD_SLOTS) private readonly activeBuildSlots: number,
    @Inject(PlacementService) private readonly placementService: PlacementService,
  ) {}

  async getSettlementState(
    settlementId: string,
    accountId: Types.ObjectId,
    now: number,
  ): Promise<SettlementStateView> {
    this.assertValidId(settlementId);
    return this.runCommand(async (session) => {
      const settled = await this.settleSettlementDoc(settlementId, accountId, now, session);
      return buildSettlementStateView(this.config, settled, now);
    });
  }

  async startBuild(
    settlementId: string,
    accountId: Types.ObjectId,
    type: string,
    now: number,
  ): Promise<SettlementStateView> {
    this.assertValidId(settlementId);
    return this.runCommand(async (session) => {
      const settled = await this.settleSettlementDoc(settlementId, accountId, now, session);

      if (!isBuildingType(type)) {
        throw new BuildCommandError('errors.build.unknownType', { type });
      }

      const buildings = toBuildingLevels(settled.buildings);
      const def = this.config.buildings[type];
      const currentLevel = currentLevelOf(buildings, type);
      const queuedCount = settled.buildQueue.filter((item) => item.type === type).length;
      const targetLevel = currentLevel + queuedCount + 1;

      if (targetLevel > def.maxLevel) {
        throw new BuildCommandError('errors.build.maxLevelReached', {
          type,
          targetLevel,
          maxLevel: def.maxLevel,
        });
      }

      const missing = missingPrerequisites(this.config, buildings, type);
      if (missing.length > 0) {
        throw new BuildCommandError('errors.build.prerequisitesNotMet', { type, missing });
      }

      const queueCapacity = this.activeBuildSlots + WAITING_QUEUE_SLOTS;
      if (settled.buildQueue.length >= queueCapacity) {
        throw new BuildCommandError('errors.build.queueFull', {
          capacity: queueCapacity,
          current: settled.buildQueue.length,
        });
      }

      if (wouldStarveSettlement(this.config, buildings, type, targetLevel)) {
        throw new BuildCommandError('errors.build.wouldStarve', { type, targetLevel });
      }

      const cost = calcBuildCost(this.config, type, targetLevel);
      const caps = calcStorageCaps(this.config, buildings);
      const exceeds = overCap(cost, caps);
      if (Object.keys(exceeds).length > 0) {
        throw new BuildCommandError('errors.build.exceedsStorage', { type, cost, exceeds });
      }

      if (!canAfford(settled.resources.values, cost)) {
        throw new BuildCommandError('errors.build.insufficientResources', {
          missing: shortfall(settled.resources.values, cost),
        });
      }

      const newValues = subtractResources(settled.resources.values, cost);
      const activeCount = settled.buildQueue.filter((item) => item.startedAt !== null).length;
      const becomesActive = activeCount < this.activeBuildSlots;

      const queueItemId = randomUUID();
      let startedAt: number | null = null;
      let completesAt: number | null = null;
      let eventId: Types.ObjectId | undefined;

      if (becomesActive) {
        const commandCenterLevel = currentLevelOf(buildings, 'commandCenter');
        const buildTimeMs = calcBuildTimeMs(this.config, type, targetLevel, commandCenterLevel);
        startedAt = now;
        completesAt = now + buildTimeMs;
        const event = await this.eventScheduler.scheduleEvent(
          {
            type: BUILD_COMPLETE_EVENT_TYPE,
            dueAt: completesAt,
            payload: { settlementId, queueItemId },
          },
          session,
        );
        eventId = event._id as Types.ObjectId;
      }

      const updated = await this.settlementModel.findOneAndUpdate(
        { _id: settlementId, version: settled.version },
        {
          $set: { 'resources.values': newValues, version: settled.version + 1 },
          $push: {
            buildQueue: {
              id: queueItemId,
              type,
              targetLevel,
              cost,
              enqueuedAt: now,
              startedAt,
              completesAt,
              eventId,
            },
          },
        },
        { session, returnDocument: 'after' },
      );
      if (!updated) {
        throw new VersionConflictError();
      }

      return buildSettlementStateView(this.config, updated, now);
    });
  }

  async cancelBuild(
    settlementId: string,
    accountId: Types.ObjectId,
    queueItemId: string,
    now: number,
  ): Promise<SettlementStateView> {
    this.assertValidId(settlementId);
    return this.runCommand(async (session) => {
      const settled = await this.settleSettlementDoc(settlementId, accountId, now, session);

      const item = settled.buildQueue.find((i) => i.id === queueItemId);
      if (!item) {
        throw new BuildCommandError('errors.build.queueItemNotFound', { queueItemId });
      }

      const refundedValues = addResources(settled.resources.values, item.cost);
      // Normalised to plain objects immediately — this array is headed for a `$set`, and a
      // raw Mongoose subdocument written back wholesale (or spread) drags its internal
      // bookkeeping along with it (see `toPlainQueueItem`'s comment).
      let remainingQueue = settled.buildQueue
        .filter((i) => i.id !== queueItemId)
        .map(toPlainQueueItem);

      if (item.eventId) {
        await this.eventScheduler.cancelEvent(item.eventId, session);
      }

      const buildings = toBuildingLevels(settled.buildings);
      const commandCenterLevel = currentLevelOf(buildings, 'commandCenter');
      const activeCount = remainingQueue.filter((i) => i.startedAt !== null).length;
      const slotsToFill = this.activeBuildSlots - activeCount;

      if (slotsToFill > 0) {
        remainingQueue = await promoteWaitingItems(
          remainingQueue,
          slotsToFill,
          commandCenterLevel,
          this.config,
          this.eventScheduler,
          settlementId,
          now,
          session,
        );
      }

      const updated = await this.settlementModel.findOneAndUpdate(
        { _id: settlementId, version: settled.version },
        {
          $set: {
            'resources.values': refundedValues,
            buildQueue: remainingQueue,
            version: settled.version + 1,
          },
        },
        { session, returnDocument: 'after' },
      );
      if (!updated) {
        throw new VersionConflictError();
      }

      return buildSettlementStateView(this.config, updated, now);
    });
  }

  // Creates the calling account's first (in v1, effectively only) settlement: places it via
  // `PlacementService`'s deterministic outer-ring rule, seeds it with a level-1 Command
  // Center and the starting resource stock, and refuses a second settlement once the
  // account already owns as many as its Influence allows.
  //
  // Not built on top of `runCommand`/version-guarded `findOneAndUpdate` like every other
  // command here — there is no existing document to version-guard yet, this one *creates*
  // it. Instead it follows the same shape `DevSeedController` already established for
  // "create, and on an {x,y} collision retry with a fresh candidate": a bounded loop, each
  // attempt its own fresh transaction (a transaction that errors mid-way must be entirely
  // re-run, not resumed — see `PlacementService.nextCounter`'s comment on why the counter
  // bump itself deliberately sits *outside* this transaction).
  async createSettlement(
    accountId: Types.ObjectId,
    settlementName: string,
    now: number,
  ): Promise<SettlementStateView> {
    for (let attempt = 1; attempt <= MAX_CREATE_SETTLEMENT_ATTEMPTS; attempt += 1) {
      const counter = await this.placementService.nextCounter();
      const { x, y } = this.placementService.pickTile(counter);

      const session = await this.connection.startSession();
      try {
        let result: SettlementStateView | undefined;
        await session.withTransaction(async () => {
          // Real Influence, not a hardcoded `1`: `calcInfluence` over the account's
          // existing settlements, fed into `settlementsAllowed` (§7). For a brand-new
          // account this is trivially 0 existing settlements / 0 Influence /
          // `settlementsAllowed(config, 0) === 1` — i.e. "first settlement always
          // allowed" — but the same code already generalises to M2's Influence-gated
          // 2nd/3rd settlement founding once that flow exists, with no change here.
          //
          // Residual known gap (documented, not closed, in M1b): two concurrent
          // "create my first settlement" calls for the same brand-new account could both
          // read `existingSettlements.length === 0` before either commits and both
          // succeed, since nothing here creates a write conflict between them the way the
          // `{x,y}` unique index does for placement. Closing this would need its own
          // uniqueness constraint (e.g. a per-account "settlement slot" reservation doc)
          // — left for the owner to decide is worth adding, since it requires a
          // deliberate double-submit to trigger.
          const existingSettlements = await this.settlementModel
            .find({ accountId }, 'buildings')
            .session(session);
          const influence = calcInfluence(
            this.config,
            existingSettlements.map((s) => toBuildingLevels(s.buildings)),
          );
          const allowed = settlementsAllowed(this.config, influence);
          if (existingSettlements.length >= allowed) {
            throw new SettlementLimitReachedError();
          }

          const [created] = await this.settlementModel.create(
            [
              {
                accountId,
                name: settlementName,
                x,
                y,
                buildings: [{ id: randomUUID(), type: 'commandCenter', level: 1, slot: 0 }],
                resources: { values: { ...STARTING_RESOURCES }, lastCalcAt: now },
                buildQueue: [],
                version: 0,
              },
            ],
            { session },
          );
          if (!created) {
            throw new Error('SettlementsService: settlement creation returned no document');
          }
          result = buildSettlementStateView(this.config, created, now);
        });
        return result as SettlementStateView;
      } catch (error) {
        if (error instanceof SettlementLimitReachedError) {
          throw error;
        }
        if (!isDuplicateKeyError(error)) {
          throw error;
        }
        // The candidate tile collided with the unique `{x,y}` index — that index is the
        // ultimate authority (see `PlacementService`'s comment); advance to the next
        // candidate on the next loop iteration.
      } finally {
        await session.endSession();
      }
    }
    throw new PlacementExhaustedError();
  }

  // The caller's settlements (in v1, at most one — see `createSettlement`). Reuses
  // `getSettlementState` per id so the same settle-and-ownership-check path backs both the
  // single-settlement read and this list, rather than a second, parallel implementation.
  async listSettlements(accountId: Types.ObjectId, now: number): Promise<SettlementStateView[]> {
    const docs = await this.settlementModel.find({ accountId }, '_id');
    const views: SettlementStateView[] = [];
    for (const doc of docs) {
      views.push(await this.getSettlementState(String(doc._id), accountId, now));
    }
    return views;
  }

  // The one canonical "settle" step (concurrency playbook §11): materialises lazy resource
  // accrual at the start of every command, persisting the result under the same
  // version-guard as every other mutation. Skips the write entirely when no time has passed
  // since the last settle (e.g. two commands landing in the same millisecond) — nothing to
  // persist, and it avoids a pointless version bump/contention point.
  //
  // Also the ownership-check choke point: every public command method funnels through here
  // first, so "does this settlement belong to the calling account" is enforced exactly
  // once. A settlement that exists but belongs to someone else is reported identically to
  // one that doesn't exist at all (same error, same 404) — deliberately not a 403, so a
  // probe against another account's settlement id can't distinguish "wrong owner" from
  // "no such settlement".
  private async settleSettlementDoc(
    settlementId: string,
    accountId: Types.ObjectId,
    now: number,
    session: ClientSession,
  ): Promise<SettlementDocument> {
    const doc = await this.settlementModel.findById(settlementId, null, { session });
    if (!doc || !doc.accountId.equals(accountId)) {
      throw new SettlementNotFoundError(settlementId);
    }

    const elapsedMs = now - doc.resources.lastCalcAt;
    if (elapsedMs <= 0) {
      return doc;
    }

    const buildings = toBuildingLevels(doc.buildings);
    const settled = settleResources(
      this.config,
      buildings,
      { values: doc.resources.values, lastCalcAt: doc.resources.lastCalcAt },
      now,
    );

    const updated = await this.settlementModel.findOneAndUpdate(
      { _id: settlementId, version: doc.version },
      {
        $set: {
          'resources.values': settled.values,
          'resources.lastCalcAt': settled.lastCalcAt,
          version: doc.version + 1,
        },
      },
      { session, returnDocument: 'after' },
    );
    if (!updated) {
      throw new VersionConflictError();
    }
    return updated;
  }

  private assertValidId(settlementId: string): void {
    if (!Types.ObjectId.isValid(settlementId)) {
      throw new SettlementNotFoundError(settlementId);
    }
  }

  // The concurrency-playbook command runner (§11): every command runs inside its own
  // transaction; a `VersionConflictError` from a version-guarded write means another
  // command raced this one and won, so the whole command — including its reads and
  // validation, not just the final write — retries from scratch against fresh state, up to
  // `MAX_COMMAND_ATTEMPTS` times. Any other thrown error (a validation failure, "not
  // found") is not a race and propagates immediately, unretried.
  //
  // Note this is a second, outer layer on top of the MongoDB driver's own
  // `session.withTransaction` retry of `TransientTransactionError`s (real storage-engine
  // write conflicts between two concurrent transactions) — that layer handles the case
  // where two transactions physically collide on the same document. This layer handles the
  // logical case: a `findOneAndUpdate` filtered on a specific `version` simply matching no
  // document, which is not itself a transient/retryable driver error.
  private async runCommand<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= MAX_COMMAND_ATTEMPTS; attempt += 1) {
      const session = await this.connection.startSession();
      try {
        let result: T | undefined;
        await session.withTransaction(async () => {
          result = await fn(session);
        });
        return result as T;
      } catch (error) {
        if (!(error instanceof VersionConflictError)) {
          throw error;
        }
        // Falls through to the next attempt unless this was the last one.
      } finally {
        await session.endSession();
      }
    }
    throw new CommandConflictRetryExhaustedError();
  }
}
