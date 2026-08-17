import type { GameConfig, TroopCounts } from '@last-signal/game-core';
import {
  chebyshevDistance,
  slowestTroopSpeed,
  travelTimeMs,
  unionTroops,
} from '@last-signal/game-core';
import { Inject, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Connection, Model } from 'mongoose';
import { Types } from 'mongoose';

import { GAME_CONFIG } from '../game-config/game-config.tokens';
import { EventSchedulerService } from '../scheduler/event-scheduler.service';
import type { MovementDocument } from '../schemas/movement.schema';
import { Movement, MOVEMENT_TYPE_SCOUT } from '../schemas/movement.schema';
import type { SettlementDocument } from '../schemas/settlement.schema';
import { Settlement } from '../schemas/settlement.schema';
import { SettlementNotFoundError } from '../settlements/settlements.errors';
import { SettlementsService } from '../settlements/settlements.service';
import { toTroopCounts } from '../settlements/settlements.util';
import {
  MAX_COMMAND_ATTEMPTS,
  MOVEMENT_ARRIVE_EVENT_TYPE,
  MOVEMENT_RETURN_EVENT_TYPE,
} from './movements.constants';
import {
  CommandConflictRetryExhaustedError,
  MovementCommandError,
  MovementNotFoundError,
  VersionConflictError,
} from './movements.errors';
import { computeReturnAt, isUnitType, mergeUnitCounts } from './movements.util';
import type { UnitCountEntry } from './movements.util';
import type { MovementView } from './movements.view';
import { toMovementView } from './movements.view';

// Implements the `sendScouts`/`cancelMovement`/`listMine` command flow end to end (M2b.3,
// `docs/M2_DESIGN_DECISIONS.md` §6), following the concurrency playbook's recipe verbatim —
// see `docs/CONCURRENCY_PLAYBOOK.md` and `SettlementsService.startBuild`/`.trainUnits` for
// the reference shape this mirrors.
@Injectable()
export class MovementsService {
  constructor(
    @InjectModel(Movement.name) private readonly movementModel: Model<MovementDocument>,
    @InjectModel(Settlement.name) private readonly settlementModel: Model<SettlementDocument>,
    @InjectConnection() private readonly connection: Connection,
    @Inject(EventSchedulerService) private readonly eventScheduler: EventSchedulerService,
    @Inject(GAME_CONFIG) private readonly config: GameConfig,
    // The settle seam (M2b.3): `sendScouts` needs the *origin* settlement settled and
    // ownership-checked — exactly what `SettlementsService.settleSettlementDoc` already does
    // for every other command, reused here rather than reimplemented. See that method's own
    // comment, and `MovementArriveHandler`'s use of the ownership-free sibling for the
    // defender side of the same seam.
    @Inject(SettlementsService) private readonly settlementsService: SettlementsService,
  ) {}

  // Validation order (deliberate, not incidental — see each check's own comment): the
  // ownership-checked settle happens first because it's structurally unavoidable (playbook
  // step 2, and it's also the 404 for an unknown/foreign origin settlement); then the
  // cheapest, state-independent shape checks (empty list, malformed counts); then
  // normalization (strip zero counts, merge duplicate types) *before* the checks that need
  // the normalized list (unit identity, then troop availability, which needs `settled.troops`
  // and so is deliberately last among the unit-list checks — mirrors `trainUnits`'s own
  // "affordability last" ordering); target resolution last of all, since it's the only check
  // that needs a second collection read.
  async sendScouts(
    fromSettlementId: string,
    accountId: Types.ObjectId,
    type: string,
    target: { x: number; y: number },
    unitsInput: ReadonlyArray<UnitCountEntry>,
    now: number,
  ): Promise<MovementView> {
    this.assertValidSettlementId(fromSettlementId);

    // M2 ships exactly one movement type (§6) — validated here, not in the DTO (§15: the
    // service owns i18n-keyed rejections), so a client sending an unrecognised `type` gets a
    // stable key instead of silently being coerced to 'scout'.
    if (type !== MOVEMENT_TYPE_SCOUT) {
      throw new MovementCommandError('errors.movement.unknownType', { type });
    }

    return this.runCommand(async (session) => {
      const origin = await this.settlementsService.settleSettlementDoc(
        fromSettlementId,
        accountId,
        now,
        session,
      );

      // 1. Cheapest, most structural check: is there anything to send at all?
      if (unitsInput.length === 0) {
        throw new MovementCommandError('errors.movement.emptyUnits');
      }

      // 2. Shape-validate every raw entry's `count` before any merging/stripping — a
      // malformed count (negative, fractional) is rejected on its own terms rather than
      // silently absorbed into a later step.
      for (const { unitType, count } of unitsInput) {
        if (!Number.isInteger(count) || count < 0) {
          throw new MovementCommandError('errors.movement.invalidCount', { unitType, count });
        }
      }

      // 3. Strip zero counts — a `{count: 0}` entry must never reach `slowestTroopSpeed`
      // (which reads every entry's speed unconditionally) or `resolveScoutCombat`
      // (`docs/M2_DESIGN_DECISIONS.md` §6 says so explicitly) — and merge duplicate
      // `unitType` entries (the client sending the same type twice isn't an error, just a
      // redundant encoding of the same intent).
      const merged = mergeUnitCounts(unitsInput.filter((u) => u.count > 0));
      if (merged.length === 0) {
        throw new MovementCommandError('errors.movement.emptyUnits');
      }

      // 4. Every entry must be a real *scout* unit type. Every catalogued unit type happens
      // to be a scout in M2 (`isUnitType`/`role === 'scout'` coincide today — the same
      // coincidence `isScoutDetected`'s own comment in `game-core` calls out), but the role
      // check stays explicit so M3's dozen non-scout unit types don't silently become
      // sendable here the moment they're added to the catalogue.
      for (const { unitType } of merged) {
        if (!isUnitType(unitType) || this.config.units[unitType].role !== 'scout') {
          throw new MovementCommandError('errors.movement.notScout', { unitType });
        }
      }

      // 5. Troop availability — needs `origin.troops`, the most expensive state to have
      // fetched only to then reject the command on cheaper grounds, so it runs last among
      // the unit-list checks.
      const homeTroops = toTroopCounts(origin.troops);
      for (const { unitType, count } of merged) {
        const available = homeTroops.find((t) => t.unitType === unitType)?.count ?? 0;
        if (count > available) {
          throw new MovementCommandError('errors.movement.insufficientTroops', {
            unitType,
            available,
            requested: count,
          });
        }
      }

      // 6. Resolve the target: a real settlement (§6: scout targets are settlements only —
      // oases are out of scope for M2), and not one of the caller's own (self-scouting is
      // meaningless — the caller already knows their own base). Looked up by coordinate
      // inside the same session/transaction as everything else.
      const targetDoc = await this.settlementModel.findOne({ x: target.x, y: target.y }, null, {
        session,
      });
      if (!targetDoc) {
        throw new MovementCommandError('errors.movement.targetNotSettlement', target);
      }
      if (targetDoc.accountId.equals(accountId)) {
        throw new MovementCommandError('errors.movement.targetIsOwnSettlement', {
          settlementId: String(targetDoc._id),
        });
      }

      // Travel time (§0): Chebyshev distance, slowest unit in the marching army decides.
      // `merged` is narrowed to `TroopCounts` by the `isUnitType`/role check just above.
      const distance = chebyshevDistance({ x: origin.x, y: origin.y }, target);
      const speed = slowestTroopSpeed(this.config, merged as TroopCounts);
      const durationMs = travelTimeMs(this.config, distance, speed);
      const arriveAt = now + durationMs;

      // Deduct the marching units from home troops, dropping any entry that hits exactly
      // zero rather than leaving `{count: 0}` dead weight behind.
      const newTroops = homeTroops
        .map((t) => {
          const sent = merged.find((m) => m.unitType === t.unitType)?.count ?? 0;
          return { unitType: t.unitType, count: t.count - sent };
        })
        .filter((t) => t.count > 0);

      // ...and credit the exact same units into `awayTroops` (M3a.4, §3): they leave
      // `troops` and become "in transit", which still eats this settlement's Food
      // (`upkeepTroopsOf`) — the fix for the pre-M3 exploit where marching an army out
      // silently dropped its upkeep to zero. One write, same version guard, same
      // transaction as everything else below.
      const newAwayTroops = unionTroops(toTroopCounts(origin.awayTroops), merged as TroopCounts);

      // Pre-generated so the `movementArrive` event's payload can reference the movement by
      // id before the movement document itself is inserted — mirrors `startBuild`'s
      // `queueItemId = randomUUID()` pattern, just with a real `ObjectId` since `movements`
      // uses Mongo's own id rather than an application-assigned one.
      const movementId = new Types.ObjectId();
      const arriveEvent = await this.eventScheduler.scheduleEvent(
        {
          type: MOVEMENT_ARRIVE_EVENT_TYPE,
          dueAt: arriveAt,
          payload: { movementId: String(movementId) },
        },
        session,
      );

      const [movement] = await this.movementModel.create(
        [
          {
            _id: movementId,
            ownerAccountId: accountId,
            type: MOVEMENT_TYPE_SCOUT,
            fromSettlementId: origin._id,
            toSettlementId: targetDoc._id,
            target,
            units: merged,
            survivors: [],
            departAt: now,
            arriveAt,
            returnAt: null,
            status: 'outbound',
            arriveEventId: arriveEvent._id,
            version: 0,
          },
        ],
        { session },
      );
      if (!movement) {
        throw new Error('MovementsService: movement creation returned no document');
      }

      const updatedOrigin = await this.settlementModel.findOneAndUpdate(
        { _id: origin._id, version: origin.version },
        { $set: { troops: newTroops, awayTroops: newAwayTroops, version: origin.version + 1 } },
        { session },
      );
      if (!updatedOrigin) {
        throw new VersionConflictError();
      }

      return toMovementView(movement, now);
    });
  }

  // No `awayTroops` change needed here (M3a.4, §3): a recalled movement is still in transit
  // — it just turns around — so it keeps eating this settlement's Food exactly as it did a
  // moment ago. `awayTroops` only changes when units actually leave transit: home (return),
  // dead (arrival losses/wipe), or eventually hosted elsewhere (support, M3c).
  async cancelMovement(
    movementId: string,
    accountId: Types.ObjectId,
    now: number,
  ): Promise<MovementView> {
    this.assertValidMovementId(movementId);
    return this.runCommand(async (session) => {
      const movement = await this.movementModel.findById(movementId, null, { session });
      // Same "don't leak existence" convention as `SettlementsService.settleSettlementDoc`:
      // a movement that exists but belongs to someone else is reported identically to one
      // that doesn't exist at all.
      if (!movement || !movement.ownerAccountId.equals(accountId)) {
        throw new MovementNotFoundError(movementId);
      }
      if (movement.status !== 'outbound') {
        throw new MovementCommandError('errors.movement.notCancellable', {
          status: movement.status,
        });
      }

      const elapsedMs = now - movement.departAt;
      if (elapsedMs > this.config.movement.cancelWindowMs) {
        throw new MovementCommandError('errors.movement.cancelWindowExpired', {
          elapsedMs,
          windowMs: this.config.movement.cancelWindowMs,
        });
      }

      if (movement.arriveEventId) {
        await this.eventScheduler.cancelEvent(movement.arriveEventId, session);
      }

      // Return timing per `computeReturnAt`'s own comment: turning around after `elapsedMs`
      // of outbound travel takes exactly `elapsedMs` again to retrace, landing survivors home
      // at `departAt + 2 * elapsedMs`.
      const returnAt = computeReturnAt(movement.departAt, now);
      const returnEvent = await this.eventScheduler.scheduleEvent(
        {
          type: MOVEMENT_RETURN_EVENT_TYPE,
          dueAt: returnAt,
          payload: { movementId: String(movement._id) },
        },
        session,
      );

      const updated = await this.movementModel.findOneAndUpdate(
        { _id: movement._id, version: movement.version },
        {
          $set: {
            status: 'returning',
            // Nothing died — the scouts never engaged (they were recalled before arrival).
            survivors: movement.units.map((u) => ({ unitType: u.unitType, count: u.count })),
            returnAt,
            returnEventId: returnEvent._id,
            version: movement.version + 1,
          },
        },
        { session, returnDocument: 'after' },
      );
      if (!updated) {
        throw new VersionConflictError();
      }

      return toMovementView(updated, now);
    });
  }

  // The caller's own movements (§6: "no incoming-movement visibility in M2" — this never
  // returns anyone else's). Typed view, server time included, so the client can run
  // countdowns against `arriveAt`/`returnAt` — same convention as
  // `SettlementsService.listSettlements`/`buildSettlementStateView`.
  async listMine(accountId: Types.ObjectId, now: number): Promise<MovementView[]> {
    const docs = await this.movementModel.find({ ownerAccountId: accountId }).sort({
      departAt: -1,
    });
    return docs.map((doc) => toMovementView(doc, now));
  }

  private assertValidSettlementId(settlementId: string): void {
    if (!Types.ObjectId.isValid(settlementId)) {
      throw new SettlementNotFoundError(settlementId);
    }
  }

  private assertValidMovementId(movementId: string): void {
    if (!Types.ObjectId.isValid(movementId)) {
      throw new MovementNotFoundError(movementId);
    }
  }

  // The concurrency-playbook command runner — mirrors
  // `SettlementsService.runCommand` exactly (see that method's own comment for the two-layer
  // retry rationale): every command runs inside its own transaction; a `VersionConflictError`
  // means another command raced this one and won, so the whole command retries from scratch
  // against fresh state, up to `MAX_COMMAND_ATTEMPTS` times. Any other thrown error is not a
  // race and propagates immediately, unretried.
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
