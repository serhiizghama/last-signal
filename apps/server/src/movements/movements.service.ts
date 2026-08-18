import type { GameConfig, TroopCounts } from '@last-signal/game-core';
import {
  chebyshevDistance,
  isBeginnerProtected,
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
import type { AccountDocument } from '../schemas/account.schema';
import { Account } from '../schemas/account.schema';
import type { MovementDocument } from '../schemas/movement.schema';
import {
  Movement,
  MOVEMENT_TYPE_ASSAULT,
  MOVEMENT_TYPE_RAID,
  MOVEMENT_TYPE_SCOUT,
  MOVEMENT_TYPE_SUPPORT,
} from '../schemas/movement.schema';
import type { SettlementDocument } from '../schemas/settlement.schema';
import { Settlement } from '../schemas/settlement.schema';
import { SettlementNotFoundError } from '../settlements/settlements.errors';
import { SettlementsService } from '../settlements/settlements.service';
import { isBuildingType, toTroopCounts } from '../settlements/settlements.util';
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
import {
  computeReturnAt,
  isSendableMovementType,
  isUnitType,
  mergeUnitCounts,
  sumAttackPoints,
} from './movements.util';
import type { UnitCountEntry } from './movements.util';
import type { MovementView } from './movements.view';
import { toMovementView } from './movements.view';

// Implements the `sendMovement`/`cancelMovement`/`listMine` command flow end to end (M2b.3,
// widened in M3c.3 from scout-only to `scout`/`raid`/`assault`/`support` —
// `docs/M3_DESIGN_DECISIONS.md` §9), following the concurrency playbook's recipe verbatim —
// see `docs/CONCURRENCY_PLAYBOOK.md` and `SettlementsService.startBuild`/`.trainUnits` for
// the reference shape this mirrors.
@Injectable()
export class MovementsService {
  constructor(
    @InjectModel(Movement.name) private readonly movementModel: Model<MovementDocument>,
    @InjectModel(Settlement.name) private readonly settlementModel: Model<SettlementDocument>,
    // Beginner protection (§11): reads the *target's* owner to reject a movement at a still-
    // protected account, and reads/writes the *caller's* own account to lift protection early
    // on their first raid/assault at another account. See both call sites' own comments.
    @InjectModel(Account.name) private readonly accountModel: Model<AccountDocument>,
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
  // the normalized list (unit identity/role, attack power, siege target — all cheap, config-
  // only checks); then troop availability, which needs `settled.troops` and so is
  // deliberately last among the unit-list checks — mirrors `trainUnits`'s own "affordability
  // last" ordering; target resolution (plus the target-owner protection check, which needs
  // the target resolved first) last of all, since it's the only check that needs a second
  // collection read; the beginner-protection *lift* (§11) runs after that, since it only
  // applies once the target is known to belong to another account.
  async sendMovement(
    fromSettlementId: string,
    accountId: Types.ObjectId,
    type: string,
    target: { x: number; y: number },
    unitsInput: ReadonlyArray<UnitCountEntry>,
    now: number,
    siegeTargetInput?: string,
  ): Promise<MovementView> {
    this.assertValidSettlementId(fromSettlementId);

    // M3c widens the send command from scout-only to four types (§9) — validated here, not
    // in the DTO (§15: the service owns i18n-keyed rejections), so a client sending an
    // unrecognised `type` gets a stable key instead of silently being coerced to something
    // else. `settle`/`trade` reach the schema (M3c.2 widened `MovementType` for storage) but
    // have no send path yet — M3d owns them — so they fall through to the same rejection as
    // any other unrecognised string. `movementType` is a fresh `const` (not a re-narrowing of
    // the `string`-typed `type` parameter) so the narrowed `SendableMovementType` is the
    // variable's actual static type and survives unchanged into the closure below.
    if (!isSendableMovementType(type)) {
      throw new MovementCommandError('errors.movement.unknownType', { type });
    }
    const movementType = type;

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
      // (which reads every entry's speed unconditionally) or a combat/loot formula
      // (`docs/M2_DESIGN_DECISIONS.md` §6 said so for scouts; §9 carries the same rule
      // forward for every type) — and merge duplicate `unitType` entries (the client sending
      // the same type twice isn't an error, just a redundant encoding of the same intent).
      const merged = mergeUnitCounts(unitsInput.filter((u) => u.count > 0));
      if (merged.length === 0) {
        throw new MovementCommandError('errors.movement.emptyUnits');
      }

      // 4. Unit identity + per-type role legality (§9/§1/§8), one pass over every entry:
      //   - catalogue existence first — an unrecognised `unitType` can't be role-checked, and
      //     for `scout` this is (as before M3c) indistinguishable from "not a scout".
      //   - `scout` requires every entry to have `role === 'scout'` — unchanged from M2/M3a,
      //     including for a wildlife/settler entry (impossible in practice, since neither is
      //     ever in a settlement's `troops`, but a non-scout role is rejected here first
      //     either way — the dedicated `unitNotAllowed` check below is therefore only ever
      //     actually reached by `raid`/`assault`/`support`).
      //   - wildlife is never player-ownable and Settlers are the `settle` movement's payload
      //     (§13) — barred from every type this step handles.
      //   - `raid`/`assault` never carry scouts (§9/§1) — scouts don't fight in a regular
      //     battle; `scout` and `support` both allow them (that's the whole point of
      //     `scout`, and §8 is explicit that stationed scouts count for defence).
      //   - siege units may only ever go out on an `assault` (§9/§7) — covers `scout` (in
      //     practice, already excluded above by the scout-only rule) and `support` in one
      //     check.
      // `hasSiegeUnit` is accumulated in the same pass so the checks below that need it
      // don't re-walk `merged` a second time. `atkPts` (needed by step 5) is computed
      // separately by `sumAttackPoints` — a small pure helper, not inlined here, purely so
      // the `noAttackPower` rejection it drives has direct unit-test coverage (see that
      // function's own comment in `movements.util.ts` for why).
      let hasSiegeUnit = false;
      for (const { unitType } of merged) {
        if (!isUnitType(unitType)) {
          throw movementType === MOVEMENT_TYPE_SCOUT
            ? new MovementCommandError('errors.movement.notScout', { unitType })
            : new MovementCommandError('errors.movement.unknownUnitType', { unitType });
        }
        const role = this.config.units[unitType].role;

        if (movementType === MOVEMENT_TYPE_SCOUT && role !== 'scout') {
          throw new MovementCommandError('errors.movement.notScout', { unitType });
        }
        if (role === 'wildlife' || role === 'settler') {
          throw new MovementCommandError('errors.movement.unitNotAllowed', { unitType, role });
        }
        if (
          (movementType === MOVEMENT_TYPE_RAID || movementType === MOVEMENT_TYPE_ASSAULT) &&
          role === 'scout'
        ) {
          throw new MovementCommandError('errors.movement.scoutsInArmy', { unitType });
        }
        if (role === 'siege') {
          if (movementType !== MOVEMENT_TYPE_ASSAULT) {
            throw new MovementCommandError('errors.movement.siegeOnlyOnAssault', { unitType });
          }
          hasSiegeUnit = true;
        }
      }

      // 5. A raid/assault army must actually be able to fight (§9) — a pure-defence stack has
      // no such requirement, which is the entire point of `support`. Unreachable through
      // today's real catalogue (every non-scout/wildlife/settler unit has `attack > 0` — see
      // `sumAttackPoints`'s own comment in `movements.util.ts`, which exists so this rejection
      // still has direct unit-test coverage); kept as a real runtime guard regardless, since a
      // future 0-attack combat unit must not silently slip a toothless army through.
      if (movementType === MOVEMENT_TYPE_RAID || movementType === MOVEMENT_TYPE_ASSAULT) {
        const atkPts = sumAttackPoints(this.config, merged);
        if (atkPts <= 0) {
          throw new MovementCommandError('errors.movement.noAttackPower');
        }
      }

      // 6. `siegeTarget` (§7): a plain optional string on the DTO, validated here rather than
      // there (§15). Only meaningful on an `assault` carrying siege units — validated
      // regardless of whether siege units are present (a malformed order is still a malformed
      // order), but only ever *persisted* when there's an actual siege pass to aim it at.
      let siegeTarget: string | undefined;
      if (siegeTargetInput !== undefined) {
        if (movementType !== MOVEMENT_TYPE_ASSAULT) {
          throw new MovementCommandError('errors.movement.siegeTargetNotAllowed');
        }
        if (siegeTargetInput !== 'wall' && !isBuildingType(siegeTargetInput)) {
          throw new MovementCommandError('errors.movement.invalidSiegeTarget', {
            siegeTarget: siegeTargetInput,
          });
        }
        siegeTarget = siegeTargetInput;
      }
      if (movementType === MOVEMENT_TYPE_ASSAULT && hasSiegeUnit && siegeTarget === undefined) {
        // The siege target is the attacker's decision (§7) — never defaulted to `'wall'`.
        throw new MovementCommandError('errors.movement.siegeTargetRequired');
      }
      if (!hasSiegeUnit) {
        // A valid `siegeTarget` on an assault with no siege units is accepted (there's
        // nothing wrong with the order), but there is no siege pass at arrival to aim it at
        // (`resolveSiegePass` only ever runs against surviving siege units) — so it is not
        // persisted, rather than being stored as dead, never-read data on the movement.
        siegeTarget = undefined;
      }

      // 7. Troop availability — needs `origin.troops`, the most expensive state to have
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

      // 8. Resolve the target: a real settlement — oases become targetable in a later step
      // (§10), left as a target type this command doesn't produce yet rather than implemented
      // here. Own-settlement targeting is barred for `scout`/`raid`/`assault` (self-scouting/
      // self-raiding is meaningless, and a raid needs a foreign victim) but explicitly allowed
      // for `support` (§8: garrisoning your own settlement is the ordinary case, not an edge
      // case). Looked up by coordinate inside the same session/transaction as everything else.
      const targetDoc = await this.settlementModel.findOne({ x: target.x, y: target.y }, null, {
        session,
      });
      if (!targetDoc) {
        throw new MovementCommandError('errors.movement.targetNotSettlement', target);
      }
      const isOwnTarget = targetDoc.accountId.equals(accountId);
      if (movementType !== MOVEMENT_TYPE_SUPPORT && isOwnTarget) {
        throw new MovementCommandError('errors.movement.targetIsOwnSettlement', {
          settlementId: String(targetDoc._id),
        });
      }

      // Beginner protection (§11): no foreign movement — scout included — may target a
      // still-protected account's settlements. Skipped entirely when the target is the
      // caller's own settlement (the only way `isOwnTarget` can be true here, since
      // scout/raid/assault already rejected one above) — a `support` to your own settlement
      // can't be blocked by your own protection.
      if (!isOwnTarget) {
        const targetOwner = await this.accountModel.findById(targetDoc.accountId, null, {
          session,
        });
        if (targetOwner && isBeginnerProtected(targetOwner.protectedUntil, now)) {
          throw new MovementCommandError('errors.movement.targetProtected', {
            settlementId: String(targetDoc._id),
          });
        }
      }

      // Protection lift (§11): sending your own first `raid`/`assault` at another account's
      // settlement ends your own beginner protection early — set to `now`, not `$unset`, so
      // the instant it lifted stays on the record (`isBeginnerProtected` already treats
      // `now === protectedUntil` as expired). Deliberately *not* `scout` or `support`: M2c's
      // onboarding loop is "train a scout, send it", and a rule that strips a brand-new
      // player's protection for following the tutorial would be a trap, not a feature.
      // `isOwnTarget` is guaranteed false whenever this runs (scout/raid/assault already
      // rejected an own-settlement target above), so every raid/assault reaching here is
      // necessarily "at another account's settlement".
      if (movementType === MOVEMENT_TYPE_RAID || movementType === MOVEMENT_TYPE_ASSAULT) {
        const callerAccount = await this.accountModel.findById(accountId, null, { session });
        if (callerAccount && isBeginnerProtected(callerAccount.protectedUntil, now)) {
          await this.accountModel.updateOne(
            { _id: accountId },
            { $set: { protectedUntil: now } },
            { session },
          );
        }
      }

      // Travel time (§0): Chebyshev distance, slowest unit in the marching army decides.
      // `merged` is narrowed to `TroopCounts` by the `isUnitType`/role checks above.
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
            type: movementType,
            fromSettlementId: origin._id,
            toSettlementId: targetDoc._id,
            target,
            units: merged,
            // Only ever set when meaningful (assault + siege units present, see step 6 above)
            // — spread so an `undefined` value never lands in the `$set`-equivalent create
            // payload as an explicit key.
            ...(siegeTarget !== undefined ? { siegeTarget } : {}),
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
