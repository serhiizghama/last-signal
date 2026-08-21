import type { GameConfig, TroopCounts } from '@last-signal/game-core';
import {
  calcInfluence,
  chebyshevDistance,
  incomingDetailTier,
  isBeginnerProtected,
  settlementsAllowed,
  slowestTroopSpeed,
  travelTimeMs,
  unionTroops,
} from '@last-signal/game-core';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Connection, Model } from 'mongoose';
import { Types } from 'mongoose';

import { GAME_CONFIG } from '../game-config/game-config.tokens';
import { NotificationsService } from '../notifications/notifications.service';
import { OasisService } from '../oasis/oasis.service';
import { PlacementService } from '../placement/placement.service';
import { EventSchedulerService } from '../scheduler/event-scheduler.service';
import type { AccountDocument } from '../schemas/account.schema';
import { Account } from '../schemas/account.schema';
import type { MovementDocument } from '../schemas/movement.schema';
import {
  Movement,
  MOVEMENT_TYPE_ASSAULT,
  MOVEMENT_TYPE_RAID,
  MOVEMENT_TYPE_SCOUT,
  MOVEMENT_TYPE_SETTLE,
  MOVEMENT_TYPE_SUPPORT,
} from '../schemas/movement.schema';
import { NOTIFICATION_KIND_INCOMING_ATTACK } from '../schemas/notification.schema';
import type { SettlementDocument } from '../schemas/settlement.schema';
import { Settlement } from '../schemas/settlement.schema';
import { SettlementNotFoundError } from '../settlements/settlements.errors';
import { SettlementsService } from '../settlements/settlements.service';
import {
  currentLevelOf,
  isBuildingType,
  toBuildingLevels,
  toTroopCounts,
} from '../settlements/settlements.util';
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
  toPlainUnitCounts,
} from './movements.util';
import type { UnitCountEntry } from './movements.util';
import type { IncomingMovementsView, IncomingMovementView, MovementView } from './movements.view';
import { toIncomingMovementView, toMovementView } from './movements.view';

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
    // The M3c.7a target-resolution seam (§9/§10): `findByCoords` is how step 8 below learns
    // "no settlement at (x, y) — is there an oasis there instead". See `OasisService`'s own
    // comment for why this coordinate lookup deliberately does not settle the oasis.
    @Inject(OasisService) private readonly oasisService: OasisService,
    // The M3d.1 target-resolution seam (§9/§13): once step 8 below has ruled out both a
    // settlement and an oasis at the target tile, a `settle` movement still needs to know
    // whether the bare tile itself is legal to found on — `isTileSettleable` answers exactly
    // that, reusing `isSettleable` the same way `PlacementService.findTile` already does for
    // a randomly-drawn candidate. See that method's own comment for why the two share one
    // legality helper.
    @Inject(PlacementService) private readonly placementService: PlacementService,
    // The §16 `incomingAttack` trigger (§12): enqueued below, at the same send site the WS
    // event fires from, once the target and its owner are known.
    @Inject(NotificationsService) private readonly notificationsService: NotificationsService,
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

    // M3c widened the send command from scout-only to four types (§9); M3d.1 adds `settle`
    // as the fifth. Validated here, not in the DTO (§15: the service owns i18n-keyed
    // rejections), so a client sending an unrecognised `type` gets a stable key instead of
    // silently being coerced to something else. `trade` reached the schema (M3c.2 widened
    // `MovementType` for storage) but has no send path yet — the Market is a later M3d step
    // — so it falls through to the same rejection as any other unrecognised string.
    // `movementType` is a fresh `const` (not a re-narrowing of the `string`-typed `type`
    // parameter) so the narrowed `SendableMovementType` is the variable's actual static type
    // and survives unchanged into the closure below.
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
      //   - wildlife is never player-ownable, barred from every type. Settlers are the
      //     `settle` movement's own payload (§13) — barred from every *other* type (they
      //     never fight and never carry loot/support), but a `settle` army is, by
      //     definition, made of nothing else, so the bar is lifted for that one type here;
      //     step 4.5 below enforces the actual composition rule for it instead.
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
        if (role === 'wildlife' || (role === 'settler' && movementType !== MOVEMENT_TYPE_SETTLE)) {
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

      // 4.5. A `settle` army must be *exactly* `config.settle.settlersRequired` Settlers and
      // nothing else (§13, owner decision 3) — step 4 above only lifted the general
      // "Settlers can't march" bar for this type, it never validated the actual count/purity
      // of the army. `supplied` reports the Settler count specifically (not the army's total
      // unit count): the "wrong count" and "extra unit types present" cases are both real
      // rejections here, but the number a player actually wants echoed back is "how many
      // Settlers did I send", since the client already knows what else it packed in.
      if (movementType === MOVEMENT_TYPE_SETTLE) {
        const settlersRequired = this.config.settle.settlersRequired;
        const settlerCount = merged.find((u) => u.unitType === 'settler')?.count ?? 0;
        const hasNonSettlerUnits = merged.some((u) => u.unitType !== 'settler');
        if (hasNonSettlerUnits || settlerCount !== settlersRequired) {
          throw new MovementCommandError('errors.movement.settleRequiresSettlers', {
            required: settlersRequired,
            supplied: settlerCount,
          });
        }
      }

      // 4.6. The Influence gate (§13): "the gate is checked twice" — here, at send, and again
      // at arrival (`SettleArrivalResolver`, since the world can change while the convoy
      // travels). Reuses the exact functions `SettlementsService.createSettlement` uses for
      // the identical gate on a *first-class* settlement-creation command — see that method's
      // own comment — rather than restating the formula here. `origin.accountId` (not the
      // `accountId` parameter) would read identically, since a settlement's own account is
      // never different from its ownership-checked caller by the time this runs; `accountId`
      // is used for symmetry with every other query in this method that reads "the caller's
      // own X".
      if (movementType === MOVEMENT_TYPE_SETTLE) {
        const accountSettlements = await this.settlementModel.find({ accountId }, 'buildings', {
          session,
        });
        const influence = calcInfluence(
          this.config,
          accountSettlements.map((s) => toBuildingLevels(s.buildings)),
        );
        const allowed = settlementsAllowed(this.config, influence);
        if (accountSettlements.length >= allowed) {
          throw new MovementCommandError('errors.movement.settlementLimitReached');
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

      // 8. Resolve the target (§9/§10/§13): a real settlement, a farm oasis (M3c.7a), or —
      // new in M3d.1 — a bare, empty-but-legal tile (`settle` only). Looked up by coordinate
      // inside the same session/transaction as everything else; a settlement match always
      // wins over an oasis one whenever both could theoretically apply, though in practice
      // they never can — `Settlement` and `Oasis` each enforce their own unique `{x, y}`
      // index (see either schema's own comment), so no tile ever holds both, and "check
      // settlement first, oasis second" can never silently prefer the wrong one.
      //
      // `toSettlementId`/`toOasisId` — **at most one** ever set, never both, the schema's own
      // documented invariant (`Movement.toSettlementId`'s comment) — are decided once in this
      // branch and read only by the movement-creation `$set` far below. A `settle` movement
      // leaves both unset: its target tile has no document to reference yet (only
      // `SettleArrivalResolver`, on success, ever creates one). Every check *before* this
      // point (unit legality, army composition/Influence, troop availability, siege target)
      // already applies identically regardless of which kind of target this movement ends up
      // with, which is exactly why the branch starts this late and not any earlier.
      const settlementTarget = await this.settlementModel.findOne(
        { x: target.x, y: target.y },
        null,
        { session },
      );

      let toSettlementId: Types.ObjectId | undefined;
      let toOasisId: Types.ObjectId | undefined;
      // Captured alongside the two ids above, from the same lookup the beginner-protection
      // check below already performs — reused by the `incomingAttack` notification site
      // further down (§12/§16) rather than re-fetched a second time. Stays `null` for an
      // oasis target (no owner to notify) and for a `support`/own-settlement target (the
      // notification site below only ever reads it for a hostile raid/assault).
      let targetOwnerAccount: AccountDocument | null = null;

      if (settlementTarget) {
        // A `settle` convoy targeting an occupied tile is rejected outright, before any of
        // the settlement-target machinery below (own-target, protection, the lift) even runs
        // — none of that is meaningful for `settle`, which isn't hostile, isn't support, and
        // has no notion of "your own settlement" as a legal target either (§13: the target is
        // always a bare tile, never an existing settlement, not even the caller's own).
        if (movementType === MOVEMENT_TYPE_SETTLE) {
          throw new MovementCommandError('errors.movement.tileOccupied', target);
        }

        // Own-settlement targeting is barred for `scout`/`raid`/`assault` (self-scouting/
        // self-raiding is meaningless, and a raid needs a foreign victim) but explicitly
        // allowed for `support` (§8: garrisoning your own settlement is the ordinary case,
        // not an edge case).
        const isOwnTarget = settlementTarget.accountId.equals(accountId);
        if (movementType !== MOVEMENT_TYPE_SUPPORT && isOwnTarget) {
          throw new MovementCommandError('errors.movement.targetIsOwnSettlement', {
            settlementId: String(settlementTarget._id),
          });
        }

        // Support to the settlement it was sent FROM (M3c.6, orchestrator decision — not a
        // design change): a zero-distance no-op that would make the arrival resolver write
        // the same settlement document twice in one transaction (once as host, once as
        // origin) — structurally unsafe under §18's ascending-`_id` two-document write
        // discipline, which assumes the pair is two distinct documents. §8's "your own or
        // anyone else's" is about supporting your OTHER settlements (multiple settlements
        // per account, gated by Influence, §7/§13) — that case is `isOwnTarget` above and
        // stays allowed; only the literal same-document target is rejected here.
        if (movementType === MOVEMENT_TYPE_SUPPORT && settlementTarget._id.equals(origin._id)) {
          throw new MovementCommandError('errors.movement.targetIsOrigin', {
            settlementId: String(settlementTarget._id),
          });
        }

        // Beginner protection (§11): no foreign movement — scout included — may target a
        // still-protected account's settlements. Skipped entirely when the target is the
        // caller's own settlement (the only way `isOwnTarget` can be true here, since
        // scout/raid/assault already rejected one above) — a `support` to your own
        // settlement can't be blocked by your own protection. An oasis target (the `else`
        // branch below) has no owner to protect at all — §10/§11 — so this whole check is
        // structurally settlement-only, not merely skipped for one.
        if (!isOwnTarget) {
          const targetOwner = await this.accountModel.findById(settlementTarget.accountId, null, {
            session,
          });
          if (targetOwner && isBeginnerProtected(targetOwner.protectedUntil, now)) {
            throw new MovementCommandError('errors.movement.targetProtected', {
              settlementId: String(settlementTarget._id),
            });
          }
          targetOwnerAccount = targetOwner;
        }

        // Protection lift (§11): sending your own first `raid`/`assault` at another
        // account's settlement ends your own beginner protection early — set to `now`, not
        // `$unset`, so the instant it lifted stays on the record (`isBeginnerProtected`
        // already treats `now === protectedUntil` as expired). Deliberately *not* `scout` or
        // `support`: M2c's onboarding loop is "train a scout, send it", and a rule that
        // strips a brand-new player's protection for following the tutorial would be a
        // trap, not a feature. `isOwnTarget` is guaranteed false whenever this runs
        // (scout/raid/assault already rejected an own-settlement target above), so every
        // raid/assault reaching here is necessarily "at another account's settlement".
        //
        // Deliberately confined to the settlement branch: §11 is explicit that "raiding an
        // **oasis** does not break it" (the asymmetry exists so oases can serve as the
        // intended risk-free training ground the onboarding loop needs — see the design
        // record's own rationale). An oasis raid/assault must reach the travel-time/write
        // code below having never touched `protectedUntil` at all, not merely skip a
        // same-shaped lift check — which is exactly what living inside this `if
        // (settlementTarget)` block, rather than a separate `if (!isOasisTarget)` guard,
        // guarantees structurally.
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

        toSettlementId = settlementTarget._id;
      } else {
        const oasisTarget = await this.oasisService.findByCoords(target.x, target.y, session);

        if (oasisTarget) {
          // Same reasoning as the settlement-occupied rejection above, applied to the other
          // kind of thing that can already occupy a tile (§13: "the tile must hold no
          // settlement and no oasis").
          if (movementType === MOVEMENT_TYPE_SETTLE) {
            throw new MovementCommandError('errors.movement.tileOccupied', target);
          }

          // §8: "Support cannot be sent to an oasis — nothing to hold" (there is no
          // settlement document at the far end for a stationed contingent to attach to, and
          // no owner to garrison it for).
          if (movementType === MOVEMENT_TYPE_SUPPORT) {
            throw new MovementCommandError('errors.movement.supportNotToOasis', target);
          }

          // Everything §11 does for a settlement target — the own-target/`targetIsOrigin`
          // checks, the protected-owner rejection, and the protection *lift* — is
          // deliberately absent here: an oasis has no owning account (§10: "still not
          // annexable... no ownership field"), so there is no `isOwnTarget` to compute, no
          // protected owner to look up, and (see the comment on the lift block above) no way
          // for a raid/assault at an oasis to ever touch the caller's own `protectedUntil`
          // either.
          //
          // Siege validation (§7, step 6 above) is untouched for an oasis target on purpose,
          // and deliberately not re-checked or re-gated here: §10 describes an oasis battle
          // as "a normal battle with `wallLevel = 0` and no siege pass", which is a fact
          // about how M3c.7b's arrival resolver resolves the battle, not about what a legal
          // *send* looks like. Step 6 already validated `siegeTarget` as a property of the
          // movement *type* (`assault` + siege units requires one), independent of what kind
          // of tile it is aimed at, and that validation stands regardless: an assault
          // carrying siege units at an oasis still requires and stores a `siegeTarget`,
          // M3c.7b's resolver simply never runs a siege pass against it or reads the field.
          // Inventing a new oasis-specific siege rejection here would contradict §10's own
          // framing of an oasis battle as an ordinary battle with one stat forced to zero.
          toOasisId = oasisTarget._id;
        } else if (movementType === MOVEMENT_TYPE_SETTLE) {
          // The tile holds neither a settlement nor an oasis (§13) — the one case where a
          // `settle` movement is actually legal. Whether it's ALSO legal in every other
          // sense (on-grid, non-toxic terrain, Chebyshev distance from every existing
          // settlement) is `isSettleable`'s own question, verbatim — reused via
          // `PlacementService.isTileSettleable` rather than restated here, so a `settle`
          // send and `PlacementService.findTile`'s own random-candidate draw can never
          // silently disagree about what "legal" means (see that method's own comment).
          // `toSettlementId`/`toOasisId` are both left `undefined`: there is nothing to
          // reference yet, per the invariant comment on `toSettlementId` above.
          const legal = await this.placementService.isTileSettleable(target, session);
          if (!legal) {
            throw new MovementCommandError('errors.movement.tileNotSettleable', target);
          }
        } else {
          throw new MovementCommandError('errors.movement.targetNotSettlement', target);
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
            // Exactly one of these two is ever set (§9/§10's xor invariant — see
            // `Movement.toSettlementId`'s own schema comment) — spread the same way
            // `siegeTarget` below is, so the one that's `undefined` never lands in the
            // create payload as an explicit key.
            ...(toSettlementId !== undefined ? { toSettlementId } : {}),
            ...(toOasisId !== undefined ? { toOasisId } : {}),
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

      // §12/§16's `incomingAttack` trigger — M3c.8 deliberately left this wiring to M3e (the
      // comment this replaces), so it landed as one piece with the notification outbox, the
      // provider interface and the in-app/WS delivery path (§16, §20) rather than half of it
      // here and half competing with M3e's own design. There is no *separate* WS emit at this
      // send site: the outbox row enqueued below is what the in-app provider eventually
      // pushes through `RealtimeGateway` (`InAppNotificationProvider`, drained by
      // `NotificationDispatchHandler`) — exactly the same decoupled "write now, deliver on the
      // next drain tick" shape every other §16 trigger uses, not a special case for this one.
      //
      // Gated to a hostile movement at a real settlement: `targetOwnerAccount` is only ever
      // set for a settlement target the caller doesn't own (see its own declaration above),
      // which already rules out `support` (never hostile — see below) and a `settle`/own-
      // settlement target. `movementType` further narrows to `raid`/`assault` — `scout` is
      // excluded structurally (M2 §8's rule, kept: "a scout you can see coming is not a
      // scout" — a scout must produce neither a notification nor a WS event, ever, at any
      // Radio Tower level, and this check is what guarantees it: scout never reaches an
      // enqueue call at all, not merely a suppressed one).
      //
      // **Support is deliberately excluded, not merely un-gated for.** §16 names exactly six
      // kinds and `incomingAttack` is one of them — support is help, not an attack (§8), and
      // inbound support is already always fully visible via the *pull* side
      // (`GET /api/movements/incoming` forces `detailTier: 'full'` for it) with no tier
      // ambiguity a push notification would need to resolve. Manufacturing an "incoming
      // attack" notification for a non-attack would misname the one kind §16 actually defines
      // for this trigger; there being no dedicated "incoming support" kind in §16's list is
      // this design's own answer to "none at all", not an oversight.
      if (
        (movementType === MOVEMENT_TYPE_RAID || movementType === MOVEMENT_TYPE_ASSAULT) &&
        settlementTarget &&
        targetOwnerAccount
      ) {
        // The exact tier-gated shaping `GET /api/movements/incoming` serves (M3c.8) — reused
        // verbatim via `incomingDetailTier` + `toIncomingMovementView`, never reimplemented,
        // so this notification's payload and a defender's own pull-side view of the identical
        // movement can never disagree about what a given Radio Tower level is allowed to see.
        // Gated on the TARGET's tower level (§12's table), read from `settlementTarget
        // .buildings` — the full document the earlier `findOne` (no projection) already
        // fetched, so no second settlement read is needed here.
        const targetTowerLevel = currentLevelOf(
          toBuildingLevels(settlementTarget.buildings),
          'radioTower',
        );
        const detailTier = incomingDetailTier(this.config, targetTowerLevel);

        // The sender's own display name — needed for the payload's `ownerName` field
        // (`toIncomingMovementView`'s shape) but not otherwise read anywhere else in this
        // command, so it's fetched here, once, rather than for every send regardless of type/
        // target. A missing account is a "cannot happen" invariant (the caller authenticated
        // as this account moments ago via `AuthGuard`), so this throws rather than papering
        // over it with a placeholder name, mirroring `SettleArrivalResolver`'s identical
        // defensive throw on its own "owning account not found" case.
        const senderAccount = await this.accountModel.findById(accountId, 'name', { session });
        if (!senderAccount) {
          throw new Error(
            `MovementsService: sender account ${String(accountId)} was not found while ` +
              'building the incoming-attack notification',
          );
        }

        const payload = toIncomingMovementView(
          movement,
          {
            id: String(origin._id),
            x: origin.x,
            y: origin.y,
            ownerAccountId: String(accountId),
            ownerName: senderAccount.name,
          },
          detailTier,
          true,
        );
        await this.notificationsService.enqueue(
          targetOwnerAccount._id,
          NOTIFICATION_KIND_INCOMING_ATTACK,
          // `IncomingMovementView` is a concrete, known-shape interface, not an index-
          // signature type — the same "known shape, stored in a `Mixed` field" mismatch
          // `movement-arrive.handler.ts`'s own `event.payload as unknown as ...` cast exists
          // for, just in the opposite direction (widening out to storage instead of narrowing
          // in from it).
          payload as unknown as Record<string, unknown>,
          session,
        );
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

  // §8's recall/evict pair (M3c.6): both turn a stationed contingent into "a normal
  // returning movement travelling at the contingent's slowest speed", instantly and without
  // cost — mechanically identical, differing ONLY in who may issue them. `recallSupport` is
  // issued by the contingent's OWNER (acting from the origin settlement); `evictSupport` is
  // issued by the HOST (acting on its own settlement, naming the contingent by its
  // owner/origin pair — the mitigation §3 promises for the support-griefing edge). Both
  // funnel through `returnStationedContingent` below, which knows nothing about who is
  // allowed to call it — that split lives entirely in which settlement each entry point
  // ownership-checks. Both also funnel through `settleHostAndOrigin` below FIRST, to acquire
  // the pair in the ascending-`_id` order §18.3 requires before either command touches
  // anything — see that method's own comment for why recall and evict specifically need this
  // and the arrival resolvers don't.
  async recallSupport(
    hostSettlementId: string,
    fromSettlementId: string,
    accountId: Types.ObjectId,
    now: number,
  ): Promise<MovementView> {
    this.assertValidSettlementId(hostSettlementId);
    this.assertValidSettlementId(fromSettlementId);
    return this.runCommand(async (session) => {
      // The caller owns the contingent's ORIGIN here (§8: "the owner recalls their own
      // contingent"); the HOST is "the other" settlement, checked for existence only —
      // `settleHostAndOrigin` settles both, in whichever `_id` order is ascending, before
      // either side's ownership is known.
      const { hostDoc, originDoc: settledOrigin } = await this.settleHostAndOrigin(
        hostSettlementId,
        fromSettlementId,
        'origin',
        now,
        session,
      );
      // The ownership check `SettlementsService.settleSettlementDoc` used to give us for
      // free — `settleHostAndOrigin` settles both sides ownership-free (§18.3 forces the
      // acquisition order before either role is resolved), so this command owns the check
      // itself now. Same "don't leak existence" convention as `settleSettlementDoc`: an
      // unknown id and a foreign id produce the identical `SettlementNotFoundError`.
      if (!settledOrigin.accountId.equals(accountId)) {
        throw new SettlementNotFoundError(fromSettlementId);
      }
      // `settleSettlementDoc` also runs `ensureStarvationSchedule` on the settlement it
      // settles — preserved explicitly here so the origin keeps behaving exactly like it does
      // for every other player command that acts on it.
      const originDoc = await this.settlementsService.ensureStarvationSchedule(
        settledOrigin,
        now,
        session,
      );
      return this.returnStationedContingent(hostDoc, originDoc, accountId, now, session);
    });
  }

  async evictSupport(
    hostSettlementId: string,
    ownerAccountId: string,
    fromSettlementId: string,
    accountId: Types.ObjectId,
    now: number,
  ): Promise<MovementView> {
    this.assertValidSettlementId(hostSettlementId);
    this.assertValidSettlementId(fromSettlementId);
    // A malformed `ownerAccountId` can never match a real stationed contingent (every one on
    // record was written by `SupportArrivalResolver` from a real account id) — folded into
    // the same `contingentNotFound` rejection a well-formed-but-wrong id would get, rather
    // than a separate shape error the client would have to handle differently.
    if (!Types.ObjectId.isValid(ownerAccountId)) {
      throw new MovementCommandError(
        'errors.movement.contingentNotFound',
        { hostSettlementId, ownerAccountId, fromSettlementId },
        HttpStatus.NOT_FOUND,
      );
    }
    return this.runCommand(async (session) => {
      // Mirror of `recallSupport` above with host/origin roles swapped: the caller owns the
      // HOST here (§8: "...or the host evicts it") — the eviction mitigation §3 promises for
      // the support-griefing edge.
      const { hostDoc: settledHost, originDoc } = await this.settleHostAndOrigin(
        hostSettlementId,
        fromSettlementId,
        'host',
        now,
        session,
      );
      if (!settledHost.accountId.equals(accountId)) {
        throw new SettlementNotFoundError(hostSettlementId);
      }
      const hostDoc = await this.settlementsService.ensureStarvationSchedule(
        settledHost,
        now,
        session,
      );
      return this.returnStationedContingent(
        hostDoc,
        originDoc,
        new Types.ObjectId(ownerAccountId),
        now,
        session,
      );
    });
  }

  // The ascending-`_id` acquisition seam `recallSupport`/`evictSupport` share (§18.3).
  // Settling a settlement is a WRITE, not a read-only step before "the real write" starts —
  // `SettlementsService.settleDoc` (reached through `settleSettlementDocUnchecked` below)
  // performs a version-guarded `findOneAndUpdate` whenever any time has elapsed since the
  // last settle — so the very FIRST touch of each document is exactly where §18.3's
  // ascending-`_id` rule applies, not just the later `$set` writes
  // `returnStationedContingent` already orders correctly on its own. `recallSupport` and
  // `evictSupport` are exact mirror images of each other acting on the very same pair of
  // documents (recall used to settle origin-then-host; evict used to settle
  // host-then-origin), so without this shared seam a concurrent recall and evict of the same
  // contingent — the realistic case, since §8 hands the two parties one command each for
  // exactly this situation — would be guaranteed to acquire the pair in conflicting order,
  // precisely the deadlock hazard §18.3 exists to rule out. Both entry points funnel through
  // here so the ordering logic lives in exactly one place; each keeps its own ownership check
  // afterwards (`settleSettlementDocUnchecked` performs none at all), since which side is
  // "owned" is the one thing that differs between them.
  //
  // Deliberately NOT applied to `MovementArriveHandler`'s own host/origin settle-then-write
  // preamble: handlers never run concurrently with each other in the first place — §18
  // records that `SchedulerService.runOnce` claims and dispatches events strictly one at a
  // time, a load-bearing property that means two handlers can never race to acquire the same
  // pair in opposite orders the way two player commands can. Don't "consistency-fix" that
  // preamble to match this one; it has nothing to fix.
  //
  // Returns both documents settled, but the `ownedRole` document's ownership is NOT yet
  // verified here — the caller checks that itself, so a caller whose ownership check fails
  // still gets a `SettlementNotFoundError` for the right id rather than this method guessing
  // at it.
  private async settleHostAndOrigin(
    hostSettlementId: string,
    originSettlementId: string,
    ownedRole: 'host' | 'origin',
    now: number,
    session: ClientSession,
  ): Promise<{ hostDoc: SettlementDocument; originDoc: SettlementDocument }> {
    const hostFirst =
      String(new Types.ObjectId(hostSettlementId)) < String(new Types.ObjectId(originSettlementId));

    let hostDoc: SettlementDocument | null;
    let originDoc: SettlementDocument | null;
    if (hostFirst) {
      hostDoc = await this.settlementsService.settleSettlementDocUnchecked(
        hostSettlementId,
        now,
        session,
      );
      originDoc = await this.settlementsService.settleSettlementDocUnchecked(
        originSettlementId,
        now,
        session,
      );
    } else {
      originDoc = await this.settlementsService.settleSettlementDocUnchecked(
        originSettlementId,
        now,
        session,
      );
      hostDoc = await this.settlementsService.settleSettlementDocUnchecked(
        hostSettlementId,
        now,
        session,
      );
    }

    const ownedDoc = ownedRole === 'host' ? hostDoc : originDoc;
    const ownedSettlementId = ownedRole === 'host' ? hostSettlementId : originSettlementId;
    const otherDoc = ownedRole === 'host' ? originDoc : hostDoc;
    const otherSettlementId = ownedRole === 'host' ? originSettlementId : hostSettlementId;

    // Missing or foreign — identical rejection, same "don't leak existence" convention as
    // `SettlementsService.settleSettlementDoc`. The ownership half of that check (foreign vs.
    // simply missing) is the caller's job, not this method's — see this method's own leading
    // comment.
    if (!ownedDoc) {
      throw new SettlementNotFoundError(ownedSettlementId);
    }
    // The other side is settled ownership-free (a recall/evict is not an action taken on its
    // behalf) — `null` is defensive only (settlements are never deleted in v1):
    // `errors.movement.originGone` is the one key for "the settlement on the other side of
    // this contingent is gone", used for whichever of the two this command didn't
    // ownership-check, regardless of which structural role it plays.
    if (!otherDoc) {
      throw new MovementCommandError('errors.movement.originGone', {
        settlementId: otherSettlementId,
      });
    }

    return ownedRole === 'host'
      ? { hostDoc: ownedDoc, originDoc: otherDoc }
      : { hostDoc: otherDoc, originDoc: ownedDoc };
  }

  // The shared mechanics behind both `recallSupport` and `evictSupport` (§8): find the named
  // contingent on the host, spin up a brand-new `returning` movement at the contingent's own
  // slowest speed, move its troops off the host's `stationedTroops` and back onto the
  // origin's `awayTroops`. A fresh `Movement` document, never the original `support` movement
  // that first delivered these units — deliberately, because a contingent can be the merged
  // result of several `support` movements from the same origin (`SupportArrivalResolver`
  // step 2) with no single original document left to reopen, and `done` is terminal in the
  // `outbound | returning | done | cancelled` status machine besides.
  private async returnStationedContingent(
    hostDoc: SettlementDocument,
    originDoc: SettlementDocument,
    ownerAccountId: Types.ObjectId,
    now: number,
    session: ClientSession,
  ): Promise<MovementView> {
    // Defensive (§18): Deliverable 3 makes a `support` targeting its own origin unsendable at
    // the source, so a settlement should never legitimately host a contingent from itself —
    // but a recall/evict naming the same settlement as both host and origin would otherwise
    // double-write one document under two different roles in the ascending-`_id` ordering
    // below. A plain `Error`, not a `MovementCommandError` — this is a "cannot happen"
    // invariant to guard, not a rejection a well-behaved client could ever legitimately hit.
    if (String(hostDoc._id) === String(originDoc._id)) {
      throw new Error(
        `MovementsService: recall/evict named the same settlement ${String(hostDoc._id)} as ` +
          'both host and origin',
      );
    }

    const contingentIndex = hostDoc.stationedTroops.findIndex(
      (c) => c.ownerAccountId.equals(ownerAccountId) && c.fromSettlementId.equals(originDoc._id),
    );
    const contingent =
      contingentIndex === -1 ? undefined : hostDoc.stationedTroops[contingentIndex];
    // A contingent whose `troops` array is already empty counts as missing too — nothing left
    // to send home, and matching it here would create a `Movement` carrying zero units.
    if (!contingent || contingent.troops.length === 0) {
      throw new MovementCommandError(
        'errors.movement.contingentNotFound',
        {
          hostSettlementId: String(hostDoc._id),
          ownerAccountId: String(ownerAccountId),
          fromSettlementId: String(originDoc._id),
        },
        HttpStatus.NOT_FOUND,
      );
    }

    // The trip home (§8: "a normal returning movement travelling at the contingent's slowest
    // speed") — the same three `game-core` calls `sendMovement` already makes.
    const contingentTroops = toTroopCounts(contingent.troops);
    const distance = chebyshevDistance(
      { x: hostDoc.x, y: hostDoc.y },
      { x: originDoc.x, y: originDoc.y },
    );
    const speed = slowestTroopSpeed(this.config, contingentTroops);
    const durationMs = travelTimeMs(this.config, distance, speed);
    const returnAt = now + durationMs;
    const contingentTroopsPlain = toPlainUnitCounts(contingentTroops);

    // Pre-generated so the `movementReturn` event's payload can reference the movement by id
    // before the document itself is inserted — mirrors `sendMovement`'s own
    // `movementId = new Types.ObjectId()` pattern.
    const movementId = new Types.ObjectId();
    const returnEvent = await this.eventScheduler.scheduleEvent(
      {
        type: MOVEMENT_RETURN_EVENT_TYPE,
        dueAt: returnAt,
        payload: { movementId: String(movementId) },
      },
      session,
    );

    const [movement] = await this.movementModel.create(
      [
        {
          _id: movementId,
          ownerAccountId,
          type: MOVEMENT_TYPE_SUPPORT,
          fromSettlementId: originDoc._id,
          toSettlementId: hostDoc._id,
          target: { x: hostDoc.x, y: hostDoc.y },
          units: contingentTroopsPlain,
          survivors: contingentTroopsPlain,
          departAt: now,
          arriveAt: now,
          returnAt,
          status: 'returning',
          returnEventId: returnEvent._id,
          version: 0,
        },
      ],
      { session },
    );
    if (!movement) {
      throw new Error('MovementsService: recall/evict movement creation returned no document');
    }

    const remainingStationedTroops = hostDoc.stationedTroops
      .filter((_, i) => i !== contingentIndex)
      .map((c) => ({
        ownerAccountId: c.ownerAccountId,
        fromSettlementId: c.fromSettlementId,
        troops: c.troops.map((t) => ({ unitType: t.unitType, count: t.count })),
      }));
    const newOriginAwayTroops = toPlainUnitCounts(
      unionTroops(toTroopCounts(originDoc.awayTroops), contingentTroops),
    );

    // §18's ascending-`_id` write order, same discipline `BattleArrivalResolver`/
    // `SupportArrivalResolver` already apply to their own host/origin pairs. The ORIGIN's
    // upkeep RISES here (it pays for its units in transit again, §3 + record §24 amendment B:
    // away troops still pay upkeep, they merely cannot die), so `ensureStarvationSchedule`
    // runs on it; the HOST's upkeep only FALLS (one fewer contingent to feed), so it needs no
    // such call — a pending tick against a now-smaller deficit can only become unnecessary,
    // never miss one this write introduced. `ensureStarvationSchedule`'s own extra write only
    // ever touches the origin, so calling it right after the origin write, on whichever side
    // of the branch that write already sits, cannot reorder the two settlements' first-touch
    // relative to each other.
    if (String(hostDoc._id) < String(originDoc._id)) {
      await this.writeHostStationedTroops(hostDoc, remainingStationedTroops, session);
      const updatedOrigin = await this.writeOriginAwayTroops(
        originDoc,
        newOriginAwayTroops,
        session,
      );
      await this.settlementsService.ensureStarvationSchedule(updatedOrigin, now, session);
    } else {
      const updatedOrigin = await this.writeOriginAwayTroops(
        originDoc,
        newOriginAwayTroops,
        session,
      );
      await this.settlementsService.ensureStarvationSchedule(updatedOrigin, now, session);
      await this.writeHostStationedTroops(hostDoc, remainingStationedTroops, session);
    }

    return toMovementView(movement, now);
  }

  private async writeHostStationedTroops(
    hostDoc: SettlementDocument,
    stationedTroops: Array<{
      ownerAccountId: Types.ObjectId;
      fromSettlementId: Types.ObjectId;
      troops: UnitCountEntry[];
    }>,
    session: ClientSession,
  ): Promise<void> {
    const updated = await this.settlementModel.findOneAndUpdate(
      { _id: hostDoc._id, version: hostDoc.version },
      { $set: { stationedTroops, version: hostDoc.version + 1 } },
      { session },
    );
    if (!updated) {
      throw new VersionConflictError();
    }
  }

  private async writeOriginAwayTroops(
    originDoc: SettlementDocument,
    awayTroops: UnitCountEntry[],
    session: ClientSession,
  ): Promise<SettlementDocument> {
    const updated = await this.settlementModel.findOneAndUpdate(
      { _id: originDoc._id, version: originDoc.version },
      { $set: { awayTroops, version: originDoc.version + 1 } },
      { session, returnDocument: 'after' },
    );
    if (!updated) {
      throw new VersionConflictError();
    }
    return updated;
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

  // `GET /api/movements/incoming` (M3c.8, `docs/M3_DESIGN_DECISIONS.md` §12): every movement
  // currently inbound to one of the CALLER'S OWN settlements, with detail gated per movement
  // by that specific TARGET settlement's own Radio Tower level — not the caller's "best"
  // tower, and not one shared across settlements: a caller with several settlements gets each
  // one tiered independently, because each one's defender-side detail depends on what THAT
  // settlement built. Read-only: no transaction, no lazy settling of resource accrual — this
  // endpoint mutates nothing, same reason `MapService.getMapView` never opens a session.
  //
  // Selection, straight from §12:
  //   - `status: 'outbound'` only. A `returning` movement is headed home to its OWNER, not
  //     inbound at anyone — excluded by the query itself, not filtered after the fact.
  //   - `toSettlementId` one of the caller's own settlements. An oasis-targeted movement
  //     (`toOasisId` set, `toSettlementId` unset — the schema's own documented xor invariant)
  //     can never match this filter, so oases need no separate exclusion here: §10 is
  //     explicit that an oasis "is still not annexable... no ownership field", so there is
  //     nothing at the far end of an oasis raid for this endpoint to attach a settlement (or
  //     a Radio Tower level) to in the first place.
  //   - `scout` is excluded unconditionally, at every tier, at every tower level — M2 §8's
  //     rule, kept verbatim by §12: "a scout you can see coming is not a scout."
  //   - `settle`/`trade` have no send path yet (M3d) — no movement of either type can exist
  //     today, so this query does not special-case them. Whether an inbound `trade` belongs
  //     on this panel at all is M3d's decision, made when it designs `trade`'s own send path
  //     and visibility rules — not one this step should pre-empt by guessing.
  //   - The caller's OWN movements aimed at their OWN other settlement (e.g. a `support` from
  //     one of their settlements to another) genuinely belong here — "inbound" is a property
  //     of the TARGET, not the sender — so there is deliberately no `ownerAccountId: { $ne:
  //     accountId }` filter anywhere in this method.
  async listIncoming(accountId: Types.ObjectId, now: number): Promise<IncomingMovementsView> {
    const mySettlements = await this.settlementModel.find({ accountId }, '_id buildings');
    if (mySettlements.length === 0) {
      return { movements: [], serverTime: now };
    }
    const radioTowerLevelBySettlementId = new Map(
      mySettlements.map((s) => [
        String(s._id),
        currentLevelOf(toBuildingLevels(s.buildings), 'radioTower'),
      ]),
    );

    // Soonest-arriving first — the natural read order for "what's coming", and the one order
    // a countdown-driven panel actually wants; nothing in §12 mandates it, this is this
    // step's own judgment call.
    const movements = await this.movementModel
      .find({
        status: 'outbound',
        toSettlementId: { $in: mySettlements.map((s) => s._id) },
        type: { $ne: MOVEMENT_TYPE_SCOUT },
      })
      .sort({ arriveAt: 1 });
    if (movements.length === 0) {
      return { movements: [], serverTime: now };
    }

    // Origin settlements + their owners, resolved as two batched queries joined in memory —
    // not a per-movement lookup and not a `$lookup` aggregation. `MapService.getMapView`
    // already establishes exactly this pattern for its own owner join (at ~150 settlements,
    // one extra collection scan costs about the same as the primary query and stays far
    // simpler to read/test than a server-side join) — same shape here, just joining a
    // movement list to its origin settlements first and then to THEIR owners, two hops
    // instead of one.
    const originSettlementIds = [...new Set(movements.map((m) => String(m.fromSettlementId)))];
    const originSettlements = await this.settlementModel.find(
      { _id: { $in: originSettlementIds } },
      'x y accountId',
    );
    const originSettlementById = new Map(originSettlements.map((s) => [String(s._id), s]));

    const originAccountIds = [...new Set(originSettlements.map((s) => String(s.accountId)))];
    const originAccounts = await this.accountModel.find({ _id: { $in: originAccountIds } }, 'name');
    const originAccountById = new Map(originAccounts.map((a) => [String(a._id), a]));

    const views: IncomingMovementView[] = [];
    for (const doc of movements) {
      // Every movement's `fromSettlementId` references a real settlement, and every
      // settlement's `accountId` a real account — neither is ever deleted (the same
      // invariant `MapService.getMapView`'s owner join already relies on). Skipped rather
      // than thrown for the same reason that comment gives: a read model should not fail an
      // entire response over one stale row.
      const origin = originSettlementById.get(String(doc.fromSettlementId));
      if (!origin) continue;
      const originOwner = originAccountById.get(String(origin.accountId));
      if (!originOwner) continue;

      const hostile = doc.type === MOVEMENT_TYPE_RAID || doc.type === MOVEMENT_TYPE_ASSAULT;
      const targetLevel = radioTowerLevelBySettlementId.get(String(doc.toSettlementId)) ?? 0;
      // `support` is exempt from tiering entirely — always fully visible regardless of the
      // target's Radio Tower level (§12: it is help, and the host may need to evict it, §8).
      // Forcing `'full'` here rather than special-casing `support` a second time inside
      // `toIncomingMovementView` means that function's one tier-gated field-inclusion switch
      // already does the right thing for both: a `support` movement falls through the exact
      // same conditionals a `full`-tier raid would, instead of a parallel branch that could
      // drift from it.
      const detailTier =
        doc.type === MOVEMENT_TYPE_SUPPORT ? 'full' : incomingDetailTier(this.config, targetLevel);

      views.push(
        toIncomingMovementView(
          doc,
          {
            id: String(origin._id),
            x: origin.x,
            y: origin.y,
            ownerAccountId: String(originOwner._id),
            ownerName: originOwner.name,
          },
          detailTier,
          hostile,
        ),
      );
    }

    return { movements: views, serverTime: now };
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
