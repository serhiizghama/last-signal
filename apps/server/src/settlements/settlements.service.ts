import { randomUUID } from 'node:crypto';

import type { GameConfig, Resources } from '@last-signal/game-core';
import {
  RESOURCE_KINDS,
  addResources,
  calcBuildCost,
  calcBuildTimeMs,
  calcInfluence,
  calcStorageCaps,
  calcTrainCost,
  calcTrainTimeMs,
  canAfford,
  missingPrerequisites,
  scoutUnitForFaction,
  settleResources,
  settlementsAllowed,
  subtractResources,
  wouldStarveSettlement,
  wouldStarveWithTroops,
} from '@last-signal/game-core';
import { Inject, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Connection, Model } from 'mongoose';
import { Types } from 'mongoose';

import { isDuplicateKeyError } from '../database/mongo-errors.util';
import { PlacementService } from '../placement/placement.service';
import { PlacementExhaustedError } from '../placement/placement.errors';
import { EventSchedulerService } from '../scheduler/event-scheduler.service';
import type { Faction } from '../schemas/account.schema';
import type { SettlementDocument } from '../schemas/settlement.schema';
import { Settlement } from '../schemas/settlement.schema';
import { promoteWaitingItems, toPlainQueueItem } from './build-queue.util';
import { GAME_CONFIG } from '../game-config/game-config.tokens';
import {
  ACTIVE_BUILD_SLOTS,
  BUILD_COMPLETE_EVENT_TYPE,
  MAX_ACTIVE_TRAINING_ORDERS,
  MAX_COMMAND_ATTEMPTS,
  MAX_CREATE_SETTLEMENT_ATTEMPTS,
  MAX_TRAIN_COUNT,
  STARTING_RESOURCES,
  TRAINING_COMPLETE_EVENT_TYPE,
  WAITING_QUEUE_SLOTS,
} from './settlements.constants';
import {
  BuildCommandError,
  CommandConflictRetryExhaustedError,
  SettlementLimitReachedError,
  SettlementNotFoundError,
  TrainCommandError,
  VersionConflictError,
} from './settlements.errors';
import {
  currentLevelOf,
  isBuildingType,
  isUnitType,
  toBuildingLevels,
  toTroopCounts,
} from './settlements.util';
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

      // Real troops, not the implicit `[]` default — a settlement with scouts already
      // eating into net Food must not be able to start a build that pushes it negative
      // just because the build gate "forgot" upkeep exists (M2b §7 correctness fix).
      const troops = toTroopCounts(settled.troops);
      if (wouldStarveSettlement(this.config, buildings, type, targetLevel, troops)) {
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

  // The `trainScouts` command (M2b.2, `docs/M2_DESIGN_DECISIONS.md` §7), playbook recipe:
  // settle first, validate via `game-core`, deduct the whole batch's cost at enqueue,
  // version-guarded write, schedule the first `trainingComplete` event same-session. `faction`
  // comes from the caller's own `AccountDocument` (the controller passes `account.faction`
  // straight through) rather than this method re-reading the account — the ownership choke
  // point already lives in `settleSettlementDoc` for the settlement side, and there is no
  // second document to version-guard here for the account (faction is chosen once at
  // registration and never changes, §13 of the M1 record).
  //
  // Validation order (deliberate, not incidental — see each check's own comment): pure
  // input-shape / account-identity checks first, since they need no settlement state and
  // should fail fast and identically regardless of what the settlement looks like; then
  // settlement-state checks from cheapest/most-fundamental to most-expensive, affordability
  // last (mirrors `startBuild`'s own affordability-last ordering, and needs the exact `cost`
  // this order would spend anyway).
  async trainScouts(
    settlementId: string,
    accountId: Types.ObjectId,
    faction: Faction | undefined,
    unitType: string,
    count: number,
    now: number,
  ): Promise<SettlementStateView> {
    this.assertValidId(settlementId);
    return this.runCommand(async (session) => {
      const settled = await this.settleSettlementDoc(settlementId, accountId, now, session);

      // 1. Is this even a real unit type? Mirrors `startBuild`'s `isBuildingType` check —
      // the cheapest possible rejection, no faction/settlement state needed at all.
      if (!isUnitType(unitType)) {
        throw new TrainCommandError('errors.training.unknownType', { unitType });
      }

      // 2. Does the account even have a faction? A guest that never registered has none
      // (orchestrator decision 3) — reject rather than defaulting to one, since there is no
      // principled "default faction" to pick.
      if (!faction) {
        throw new TrainCommandError('errors.training.noFaction');
      }

      // 3. Is the requested unit actually this faction's own scout? (orchestrator decision
      // 4) Every faction has exactly one scout (`scoutUnitForFaction` throws only on an
      // unknown faction, which `isFaction` at registration already rules out).
      const scout = scoutUnitForFaction(this.config, faction);
      if (unitType !== scout.type) {
        throw new TrainCommandError('errors.training.wrongFaction', {
          unitType,
          faction,
          expected: scout.type,
        });
      }

      // 4. Is `count` a sane batch size? Checked once we know *what* is being trained, so a
      // player seeing this error already knows the unit type was accepted and only the
      // quantity is the problem.
      if (!Number.isInteger(count) || count <= 0 || count > MAX_TRAIN_COUNT) {
        throw new TrainCommandError('errors.training.invalidCount', {
          count,
          max: MAX_TRAIN_COUNT,
        });
      }

      const buildings = toBuildingLevels(settled.buildings);

      // 5. Structural capability: no Barracks, no training, ever — independent of anything
      // transient (queue state, resources).
      if (currentLevelOf(buildings, 'barracks') < 1) {
        throw new TrainCommandError('errors.training.noBarracks');
      }

      // 6. Transient state: one active order at a time (orchestrator decision 1,
      // `MAX_ACTIVE_TRAINING_ORDERS`).
      if (settled.trainingQueue.length >= MAX_ACTIVE_TRAINING_ORDERS) {
        throw new TrainCommandError('errors.training.queueBusy');
      }

      // 7. The Food gate: the *whole batch*, on top of troops already at home — same
      // absolute-gate shape as the build gate (§7, M1 §4).
      const existingTroops = toTroopCounts(settled.troops);
      const addedTroops = [{ unitType, count }];
      if (wouldStarveWithTroops(this.config, buildings, existingTroops, addedTroops)) {
        throw new TrainCommandError('errors.training.wouldStarve', { unitType, count });
      }

      // 8. Affordability last — needs the exact cost, which every earlier check was cheaper
      // to compute without.
      const cost = calcTrainCost(this.config, unitType, count);
      if (!canAfford(settled.resources.values, cost)) {
        throw new TrainCommandError('errors.training.insufficientResources', {
          missing: shortfall(settled.resources.values, cost),
        });
      }

      const newValues = subtractResources(settled.resources.values, cost);
      const unitTrainTimeMs = calcTrainTimeMs(this.config, unitType);
      const orderId = randomUUID();
      const nextCompletesAt = now + unitTrainTimeMs;

      // Schedules the *first* unit's completion only — chained one-at-a-time delivery (§7):
      // `TrainingCompleteHandler` schedules unit 2..N itself as each prior one lands.
      const event = await this.eventScheduler.scheduleEvent(
        {
          type: TRAINING_COMPLETE_EVENT_TYPE,
          dueAt: nextCompletesAt,
          payload: { settlementId, orderId, remainingCountAtSchedule: count },
        },
        session,
      );

      const updated = await this.settlementModel.findOneAndUpdate(
        { _id: settlementId, version: settled.version },
        {
          $set: { 'resources.values': newValues, version: settled.version + 1 },
          $push: {
            trainingQueue: {
              id: orderId,
              unitType,
              totalCount: count,
              remainingCount: count,
              unitTrainTimeMs,
              startedAt: now,
              nextCompletesAt,
              cost,
              eventId: event._id as Types.ObjectId,
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

  // Creates the calling account's first (in v1, effectively only) settlement: places it via
  // `PlacementService`'s center-out expanding annulus policy
  // (`docs/M2_DESIGN_DECISIONS.md` §3), seeds it with a level-1 Command Center and the
  // starting resource stock, and refuses a second settlement once the account already owns
  // as many as its Influence allows.
  //
  // Not built on top of `runCommand`/version-guarded `findOneAndUpdate` like every other
  // command here — there is no existing document to version-guard yet, this one *creates*
  // it. Instead it follows the same shape `DevSeedController` already established for
  // "create, and on an {x,y} collision retry with a fresh candidate": a bounded loop, each
  // attempt its own fresh transaction (a transaction that errors mid-way must be entirely
  // re-run, not resumed).
  async createSettlement(
    accountId: Types.ObjectId,
    settlementName: string,
    now: number,
  ): Promise<SettlementStateView> {
    for (let attempt = 1; attempt <= MAX_CREATE_SETTLEMENT_ATTEMPTS; attempt += 1) {
      // Drawn fresh every attempt, deliberately before the transaction starts:
      // `PlacementService.findTile` re-reads live settlement/oasis state and draws via the
      // injected RNG on every call (never memoized), so simply calling it again on the next
      // loop iteration already guarantees a new candidate — a retry must never silently
      // reuse the exact candidate that just collided. This is the same requirement M1b's
      // counter-based policy had (see that policy's own now-deleted `nextCounter` comment),
      // just satisfied differently: there, an atomic DB counter had to survive the aborted
      // transaction's rollback; here, `findTile` is a fresh, non-memoized read-and-draw with
      // no state of its own to roll back.
      const { x, y } = await this.placementService.findTile();

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
        // The candidate tile collided with the unique `{x,y}` index — the real TOCTOU race
        // two concurrent placements can hit (each computed legality against a settlement
        // snapshot that didn't yet include the other's about-to-commit tile). The index is
        // the final authority for exactly this case (`docs/M2_DESIGN_DECISIONS.md` §3);
        // advance to a fresh candidate on the next loop iteration.
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

  // The settle-and-persist core (concurrency playbook §11): materialises lazy resource
  // accrual on an already-loaded document up to `now`, persisting the result under the same
  // version-guard as every other mutation. Skips the write entirely when no time has passed
  // since the last settle (e.g. two commands landing in the same millisecond) — nothing to
  // persist, and it avoids a pointless version bump/contention point.
  //
  // Ownership-free and id-free by design (M2b.3 split — see `settleSettlementDoc` and
  // `settleSettlementDocUnchecked` below for the two id-lookup entry points built on top of
  // this): the one and only settle implementation, so neither entry point can silently drift
  // from the other.
  private async settleDoc(
    doc: SettlementDocument,
    now: number,
    session: ClientSession,
  ): Promise<SettlementDocument> {
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
      // Troop Food upkeep applies from the moment scouts are credited (M2b §7) — omitting
      // this would silently understate upkeep and let Food accrue as if the settlement had
      // no troops at all.
      toTroopCounts(doc.troops),
    );

    const updated = await this.settlementModel.findOneAndUpdate(
      { _id: doc._id, version: doc.version },
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

  // The ownership-checked entry point: every public command method in this class funnels
  // through here first (unchanged from before the M2b.3 split below), so "does this
  // settlement belong to the calling account" is enforced exactly once. A settlement that
  // exists but belongs to someone else is reported identically to one that doesn't exist at
  // all (same error, same 404) — deliberately not a 403, so a probe against another
  // account's settlement id can't distinguish "wrong owner" from "no such settlement". Not
  // `private` (only) any more: also called directly by `MovementsService.sendScouts` for the
  // *origin* settlement, which needs the exact same ownership check this class already
  // enforces for every other command — see that method's own comment.
  async settleSettlementDoc(
    settlementId: string,
    accountId: Types.ObjectId,
    now: number,
    session: ClientSession,
  ): Promise<SettlementDocument> {
    const doc = await this.settlementModel.findById(settlementId, null, { session });
    if (!doc || !doc.accountId.equals(accountId)) {
      throw new SettlementNotFoundError(settlementId);
    }
    return this.settleDoc(doc, now, session);
  }

  // The ownership-free entry point (M2b.3, "the settle seam"): looks a settlement up by id
  // alone, with no notion of "the calling account" at all — for the one cross-account flow
  // that needs it, `MovementArriveHandler` settling a scouting *target's* resources so the
  // intel snapshot is exact (`docs/M2_DESIGN_DECISIONS.md` §8: "the target's resources must
  // be settled inside the same transaction as the arrival"). There is no account to check
  // ownership against here by construction — the caller isn't acting on the target's behalf,
  // it's resolving what a third party's scouts observed there — so this deliberately has no
  // ownership check to weaken; every player-facing command still goes exclusively through
  // `settleSettlementDoc` above, unchanged.
  //
  // Returns `null` instead of throwing when the id doesn't resolve to a real settlement:
  // unlike every ownership-checked command (where "not found" is a client mistake worth a
  // 404), a missing target here is §6's own defended-but-impossible edge case ("target
  // settlement missing at arrival"), which the caller turns into a "target not found" report,
  // not an HTTP error — there is no HTTP request in flight for a scheduler-driven handler to
  // fail.
  async settleSettlementDocUnchecked(
    settlementId: string,
    now: number,
    session: ClientSession,
  ): Promise<SettlementDocument | null> {
    const doc = await this.settlementModel.findById(settlementId, null, { session });
    if (!doc) {
      return null;
    }
    return this.settleDoc(doc, now, session);
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
