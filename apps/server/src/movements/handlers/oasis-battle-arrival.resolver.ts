import type {
  BattleContingent,
  BattleContingentOutcome,
  BattleKind,
  GameConfig,
  LootResult,
  Resources,
  TroopCounts,
} from '@last-signal/game-core';
import { battleRoll, resolveBattle, resolveLoot, subtractResources } from '@last-signal/game-core';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { GAME_CONFIG } from '../../game-config/game-config.tokens';
import { NotificationsService } from '../../notifications/notifications.service';
import { EventSchedulerService } from '../../scheduler/event-scheduler.service';
import type { GameEventDocument } from '../../schemas/event.schema';
import type { MovementDocument } from '../../schemas/movement.schema';
import { Movement, MOVEMENT_TYPE_ASSAULT, MOVEMENT_TYPE_RAID } from '../../schemas/movement.schema';
import type { OasisDocument } from '../../schemas/oasis.schema';
import { Oasis } from '../../schemas/oasis.schema';
import type { ReportDocument } from '../../schemas/report.schema';
import { REPORT_TYPE_OASIS_RAID, Report } from '../../schemas/report.schema';
import type { SettlementDocument } from '../../schemas/settlement.schema';
import { Settlement } from '../../schemas/settlement.schema';
import { toTroopCounts } from '../../settlements/settlements.util';
import { WorldService } from '../../world/world.service';
import { MOVEMENT_RETURN_EVENT_TYPE } from '../movements.constants';
import {
  computeReturnAt,
  subtractUnitCounts,
  toPlainUnitCounts,
  turnAroundOutboundMovement,
} from '../movements.util';
import type { OasisArrivalResolver } from './oasis-arrival-resolver.interface';

// The single defending contingent `resolveBattle`'s `defenders` input addresses an oasis's
// wildlife garrison by. Unlike `BattleArrivalResolver`'s `HOME_CONTINGENT_KEY` (which shares a
// namespace with `stationedContingentKey`'s `"<24-hex>:<24-hex>"` keys and needs a comment
// proving no collision is possible), an oasis contingent has no such neighbour to collide
// with at all — §10 is explicit that an oasis has no stationed support, ever, so `defenders`
// below is always a one-element array and this string never has to be told apart from
// anything else.
const OASIS_CONTINGENT_KEY = 'oasis';

// Resolves a `raid`/`assault` arrival at a farm oasis (M3c.7b, `docs/M3_DESIGN_DECISIONS.md`
// §10) — the oasis-target sibling of `BattleArrivalResolver`, structurally the same shape (load
// the origin, run `resolveBattle`, run `resolveLoot`, write reports, write both documents,
// schedule the return leg) but considerably thinner, because §10 strips out exactly the parts
// of a settlement battle an oasis doesn't have:
//
// - **No siege pass, ever** — not even for an assault carrying siege units and a stored
//   `movement.siegeTarget`. §10: "Raiding an oasis is a normal battle with `wallLevel = 0` and
//   no siege pass." `MovementsService.sendMovement` still validates and persists
//   `siegeTarget` for an *assault* carrying siege units regardless of what it targets (M3c.7a
//   recorded this deliberately: that validation is a rule about the movement *type*, not the
//   target it happens to be aimed at, and re-gating it per-target would contradict §10's own
//   framing of an oasis battle as "a normal battle", not a battle with a special-cased siege
//   rule). This resolver simply never reads `movement.siegeTarget` at all — siege units still
//   fight in `resolveBattle` below and their surviving carry still counts toward
//   `result.lootCapacity` exactly like every other unit type, but there is no wall to breach
//   and no building to knock a level off, so a siege pass would have nothing to do even if one
//   ran.
// - **One contingent, always** (`OASIS_CONTINGENT_KEY`) — an oasis has no stationed support
//   (§10: "still not annexable... no ownership field", and support cannot be sent to one at
//   all, `errors.movement.supportNotToOasis`), so there is no analog of
//   `BattleArrivalResolver`'s `stationedContingents`/`stationedByKey` bookkeeping here.
// - **Loot is Food only, by composition, not a new formula.** §6's `resolveLoot` already
//   distributes across whichever resources are actually stored; feeding it a `LootTarget`
//   whose `scrap`/`fuel`/`electronics` are pinned to 0 and whose `hiddenCacheLevel` is 0 (an
//   oasis has no Hidden Cache — the concept doesn't exist for wildlife) makes it yield
//   Food-only loot bounded by both the pool and surviving carry capacity for free, and it
//   already enforces §6's "an unsuccessful attacker loots nothing" through
//   `attackerPrevailed`. See `lootStored` below — that is the whole trick, and it is not a
//   trick at all, just an honest input.
// - **One report, `oasisRaid`, attacker only.** §15 names `oasisRaid` for both raid and
//   assault at an oasis (unlike the settlement side's separate `raid`/`assault` report types) —
//   an oasis has no owner, so there is no `defense` counter-report and no `supportLoss` report
//   to write; `kind` inside the payload is what tells a raid apart from an assault.
// - **A wipe is not a special case.** An assault "simply wipes the defenders (they respawn)"
//   (§10) — that is exactly what `defenders: []` already means to `settleOasis` (M3c.1/M3c.7a:
//   an oasis regrows its garrison toward `oasisTargetDefenders` from whatever survives, and `[]`
//   survives are the same as any other count), so `writeOasis` below needs no dedicated
//   "handle a total defender wipe" branch — it is the ordinary `survivors.filter(count > 0)`
//   path landing on an empty array.
@Injectable()
export class OasisBattleArrivalResolver implements OasisArrivalResolver {
  readonly types = [MOVEMENT_TYPE_RAID, MOVEMENT_TYPE_ASSAULT] as const;

  // Same pattern as `BattleArrivalResolver` — the diagnostic surface for
  // `subtractUnitCounts`'s `shortfall` below.
  private readonly logger = new Logger(OasisBattleArrivalResolver.name);

  // Deliberately no `SettlementsService`/`ensureStarvationSchedule` dependency, unlike
  // `BattleArrivalResolver`. That call exists there only because a siege pass can knock out a
  // defender's Greenhouse and introduce a *new* Food deficit no pending tick was scheduled
  // against — this resolver never runs a siege pass (see the class comment) and an oasis is
  // not a settlement with its own Food upkeep/starvation schedule at all, so there is nothing
  // for that choke point to ever need to do here. The origin settlement's own upkeep can only
  // ever go *down* from battle losses (fewer `awayTroops`), exactly the same argument
  // `BattleArrivalResolver`'s own comment makes for its origin-side write, which is why that
  // write, below, doesn't touch `pendingStarvationEventId` either.
  constructor(
    @InjectModel(Movement.name) private readonly movementModel: Model<MovementDocument>,
    @InjectModel(Settlement.name) private readonly settlementModel: Model<SettlementDocument>,
    @InjectModel(Oasis.name) private readonly oasisModel: Model<OasisDocument>,
    @InjectModel(Report.name) private readonly reportModel: Model<ReportDocument>,
    @Inject(EventSchedulerService) private readonly eventScheduler: EventSchedulerService,
    @Inject(WorldService) private readonly worldService: WorldService,
    @Inject(GAME_CONFIG) private readonly config: GameConfig,
    // §16's `battleReportArrived` trigger — the `oasisRaid` report `writeReport`/
    // `resolveMissingTarget` below writes gets an outbox row through this.
    @Inject(NotificationsService) private readonly notificationsService: NotificationsService,
  ) {}

  async resolveArrival(
    movement: MovementDocument,
    targetDoc: OasisDocument,
    event: GameEventDocument,
    session: ClientSession,
  ): Promise<void> {
    const originDoc = await this.settlementModel.findById(movement.fromSettlementId, null, {
      session,
    });
    // Defensive, mirrors `BattleArrivalResolver`/every other resolver in this module:
    // settlements are never deleted in v1, so an attacker whose own home vanished mid-flight
    // is unreachable in practice. Nothing sane to apply — leave the movement `outbound` rather
    // than guessing.
    if (!originDoc) {
      return;
    }

    // §5 step 2, narrowed by §10: the only defending contingent an oasis can ever have is its
    // own wildlife garrison — `targetDoc.defenders` was already settled to `event.dueAt` by
    // the shared `MovementArriveHandler` preamble (`OasisService.settleOasisDocUnchecked`)
    // before this resolver ever ran, so this is the exact composition an attacker arriving at
    // this instant would meet.
    const defenders: BattleContingent[] = [
      { key: OASIS_CONTINGENT_KEY, troops: toTroopCounts(targetDoc.defenders) },
    ];
    const kind: BattleKind = movement.type === MOVEMENT_TYPE_ASSAULT ? 'assault' : 'raid';
    // The deterministic roll (§5 step 4, §18), byte-for-byte the same derivation
    // `BattleArrivalResolver` uses: `hash(world.seed, movementId)`, never `Math.random()` — a
    // scheduler replay (or `tools/sim`, M4) must reproduce the exact same battle.
    // `WorldService.getWorld()` is read outside `session` deliberately, for the identical
    // reason `BattleArrivalResolver`'s own call is: nothing in this transaction ever writes the
    // `world` document, so there is no isolation hazard, and its signature never accepts a
    // session either.
    const world = await this.worldService.getWorld();
    const roll = battleRoll(world.seed, String(movement._id));

    // §10: `wallLevel: 0` — an oasis has no Wall building at all, not even a level-0 one to
    // read off a buildings array the way `BattleArrivalResolver` reads `currentLevelOf`. No
    // siege pass follows this call under any circumstance — see the class comment for why a
    // stored `movement.siegeTarget` on an oasis assault is validated at send but never read
    // here.
    const result = resolveBattle(this.config, {
      attacker: toTroopCounts(movement.units),
      defenders,
      wallLevel: 0,
      kind,
      roll,
    });

    const oasisOutcome = result.defenders.find((d) => d.key === OASIS_CONTINGENT_KEY);
    // Unreachable: `OASIS_CONTINGENT_KEY` is always present in `defenders` above, and
    // `resolveBattle` returns exactly one outcome per input contingent. Narrows the type for
    // TypeScript rather than guarding a real runtime case — same shape as
    // `BattleArrivalResolver`'s identical `homeOutcome` guard.
    if (!oasisOutcome) {
      throw new Error(
        `OasisBattleArrivalResolver: resolveBattle returned no outcome for the oasis ` +
          `contingent of movement ${String(movement._id)}`,
      );
    }

    // §6/§10: Food-only loot, by composition rather than a bespoke oasis-loot formula. An
    // oasis's only "storeroom" is `targetDoc.loot.food` (already settled to `event.dueAt` by
    // the same preamble that settled `defenders` above); pinning the other three resources to
    // 0 and `hiddenCacheLevel` to 0 (an oasis has no Hidden Cache concept — §10 draws no
    // analogy to one) makes `resolveLoot` yield exactly "Food only, capped by surviving carry
    // capacity and by the pool" — §10's own words — with zero special-casing. `lootStored` is
    // kept around (not just inlined into the call below) because `writeOasis` needs the exact
    // same object to compute what's left in the pool afterward via the same `subtractResources`
    // the settlement side uses, rather than re-deriving "stored minus taken" by hand a second
    // time.
    const lootStored: Resources = {
      scrap: 0,
      fuel: 0,
      electronics: 0,
      food: targetDoc.loot.food,
    };
    const lootResult = resolveLoot(this.config, result, {
      stored: lootStored,
      hiddenCacheLevel: 0,
    });

    await this.writeReport(movement, targetDoc, kind, result, lootResult, oasisOutcome, session);

    const attackerSurvived = result.attacker.survivors.some((s) => s.count > 0);

    // §18's acquisition-order rule exists to stop two *concurrent multi-document commands*
    // from grabbing the same *pair* of documents in opposite orders and deadlocking. This
    // arrival writes exactly one `Oasis` document and one `Settlement` document — two
    // different collections, which can never be confused for one another the way two
    // `Settlement` documents in `BattleArrivalResolver` can (there, either settlement could be
    // "the attacker's" or "the defender's" depending on who raids whom, so the ordering has to
    // be computed at runtime from the actual `_id`s). No other command in this codebase ever
    // writes an oasis and a settlement as a pair, so there is no second writer whose ordering
    // this one could ever disagree with — a fixed, documented order is enough, and "resolve the
    // target, then account for the attacker" (oasis first, then the origin settlement) is the
    // natural one, matching `BattleArrivalResolver`'s own "defender, then origin" reading of
    // the same idiom.
    await this.writeOasis(targetDoc, oasisOutcome, lootStored, lootResult, session);
    await this.writeOriginAwayTroops(
      movement,
      originDoc,
      result.attacker.losses,
      attackerSurvived,
      session,
    );

    if (!attackerSurvived) {
      // Total wipe (§6/§8's shared convention, carried over verbatim from
      // `BattleArrivalResolver`): the movement ends here, `done` — no `movementReturn` to
      // schedule, nobody is coming home. `resolveLoot` already returns zero `taken` for an
      // unsuccessful attacker, so `movement.loot` is correctly left unset below too.
      const updated = await this.movementModel.findOneAndUpdate(
        { _id: movement._id, version: movement.version },
        { $set: { status: 'done', survivors: [], version: movement.version + 1 } },
        { session },
      );
      if (!updated) {
        throw new Error(
          `OasisBattleArrivalResolver: version conflict applying movement ${String(movement._id)}`,
        );
      }
      return;
    }

    const returnAt = computeReturnAt(movement.departAt, event.dueAt);
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
          survivors: toPlainUnitCounts(result.attacker.survivors),
          returnAt,
          returnEventId: returnEvent._id,
          version: movement.version + 1,
          // Only set when something was actually taken (§6), same convention
          // `BattleArrivalResolver` follows: absent is what "never looted" already means for
          // every other optional field on this schema, and `MovementReturnHandler` only
          // credits/clamps loot when this field is present (Deliverable 2, M3c.7b — it also
          // now knows to find this movement's report by `REPORT_TYPE_OASIS_RAID`, not just
          // `raid`/`assault`).
          ...(lootResult.totalTaken > 0 ? { loot: lootResult.taken } : {}),
        },
      },
      { session },
    );
    if (!updated) {
      throw new Error(
        `OasisBattleArrivalResolver: version conflict applying movement ${String(movement._id)}`,
      );
    }
  }

  // The §9/§6 "defended-but-impossible" edge case, carried over verbatim from
  // `BattleArrivalResolver.resolveMissingTarget`/`OasisScoutArrivalResolver.resolveMissingTarget`:
  // oases are never deleted in v1 either, but the handler defends anyway rather than assuming
  // it. Same shape as those two: a report of the *movement's own kind* (`oasisRaid`, per §15's
  // "oasisRaid for both raid and assault at an oasis" — never `scoutFailed`, a raider is not a
  // scout) carrying `reason: 'targetNotFound'` and no battle fields, then the shared
  // turn-around mechanics.
  async resolveMissingTarget(
    movement: MovementDocument,
    event: GameEventDocument,
    session: ClientSession,
  ): Promise<void> {
    const created = await this.reportModel.create(
      [
        {
          accountId: movement.ownerAccountId,
          type: REPORT_TYPE_OASIS_RAID,
          read: false,
          payload: {
            movementId: String(movement._id),
            fromSettlementId: String(movement.fromSettlementId),
            target: { x: movement.target.x, y: movement.target.y },
            reason: 'targetNotFound',
          },
        },
      ],
      { session },
    );
    await this.notificationsService.enqueueForReports(created, session);

    await turnAroundOutboundMovement(
      movement,
      event,
      this.eventScheduler,
      this.movementModel,
      session,
    );
  }

  // §15's `oasisRaid` — the attacker's own report, and the *only* report this resolver ever
  // writes: an oasis has no owner (§10), so there is no `defense` counter-report and no
  // `supportLoss` report (an oasis has no stationed support to lose). Structured ids and
  // numbers only, never prose (M1 §15), and shaped to carry the same battle-internal fields
  // `BattleArrivalResolver`'s own attacker report carries (`atkPts`/`defPts`/`x`/the loss
  // fractions) so a client-side renderer that already knows how to read one can read the
  // other with no special-casing.
  private async writeReport(
    movement: MovementDocument,
    targetDoc: OasisDocument,
    kind: BattleKind,
    result: ReturnType<typeof resolveBattle>,
    lootResult: LootResult,
    oasisOutcome: BattleContingentOutcome,
    session: ClientSession,
  ): Promise<void> {
    const created = await this.reportModel.create(
      [
        {
          accountId: movement.ownerAccountId,
          type: REPORT_TYPE_OASIS_RAID,
          read: false,
          payload: {
            movementId: String(movement._id),
            fromSettlementId: String(movement.fromSettlementId),
            toOasisId: String(movement.toOasisId),
            target: { x: movement.target.x, y: movement.target.y },
            kind,
            attacker: {
              sent: movement.units.map((u) => ({ unitType: u.unitType, count: u.count })),
              losses: toPlainUnitCounts(result.attacker.losses),
              survivors: toPlainUnitCounts(result.attacker.survivors),
            },
            // The garrison as it stood *before* this battle — `targetDoc.defenders` is still
            // the preamble's pre-effect snapshot at this point, `writeOasis` below hasn't run
            // yet, so this is the composition a raider actually met, not what's left of it.
            defendersMet: targetDoc.defenders.map((d) => ({
              unitType: d.unitType,
              count: d.count,
            })),
            defenderLosses: toPlainUnitCounts(oasisOutcome.losses),
            atkPts: result.atkPts,
            defPts: result.defPts,
            x: result.x,
            attackerLossFraction: result.attackerLossFraction,
            defenderLossFraction: result.defenderLossFraction,
            wallFactor: result.wallFactor,
            // Always 0 — an oasis has no Wall building (§10) — kept as its own field anyway,
            // matching `BattleArrivalResolver`'s `defenderWallLevel` key name, so a renderer
            // built against the settlement-side report needs no special case to also read this
            // one.
            defenderWallLevel: 0,
            attackerPrevailed: result.attackerPrevailed,
            lootCapacity: result.lootCapacity,
            lootCapacityBound: lootResult.capacityBound,
            // §10/§6: Food only, by construction — `lootResult.taken.scrap/fuel/electronics`
            // are always 0 here (see `lootStored` in `resolveArrival`), so the one number worth
            // naming on its own is the Food actually taken.
            foodTaken: lootResult.taken.food,
          },
        },
      ],
      { session },
    );
    await this.notificationsService.enqueueForReports(created, session);
  }

  // Writes the oasis's surviving defenders and its reduced Food pool — one write, version-
  // guarded, exactly the discipline every other mutating write in this codebase follows.
  // Deliberately does NOT touch `lastRegenAt`/`lastDefenderRegenAt`: the shared
  // `MovementArriveHandler` preamble (`OasisService.settleOasisDocUnchecked`) already settled
  // both clocks to `event.dueAt` before this resolver ever ran, and re-stamping either here
  // would double-count regeneration between that settle and this write — the exact same
  // "settle first, only then change state" discipline §7 states explicitly for a settlement's
  // siege pass and `BattleArrivalResolver` already follows for `resources.lastCalcAt`. An
  // assault's total wipe needs no special case here either (see the class comment): `[]`
  // survivors is an ordinary input to `settleOasis`'s own regrowth-toward-`oasisTargetDefenders`
  // logic, not a state this write has to reason about.
  private async writeOasis(
    targetDoc: OasisDocument,
    oasisOutcome: BattleContingentOutcome,
    lootStored: Resources,
    lootResult: LootResult,
    session: ClientSession,
  ): Promise<void> {
    const survivors = oasisOutcome.survivors
      .map((t) => ({ unitType: t.unitType, count: t.count }))
      .filter((t) => t.count > 0);
    // The same `subtractResources(stored, taken)` composition `BattleArrivalResolver` uses for
    // a settlement's resources, applied to the identical `lootStored` object `resolveLoot` was
    // fed above — not a second, independently-written "pool minus food taken" calculation that
    // could quietly drift from what was actually resolved.
    const remainingFood = subtractResources(lootStored, lootResult.taken).food;

    const updated = await this.oasisModel.findOneAndUpdate(
      { _id: targetDoc._id, version: targetDoc.version },
      {
        $set: {
          defenders: survivors,
          'loot.food': remainingFood,
          version: targetDoc.version + 1,
        },
      },
      { session },
    );
    if (!updated) {
      throw new Error(
        `OasisBattleArrivalResolver: version conflict applying battle to oasis ${String(targetDoc._id)}`,
      );
    }
  }

  // Subtracts the attacker's battle losses (or, on a total wipe, its entire departed army) from
  // the origin settlement's `awayTroops` (M3a.4, §3) — byte-for-byte the same shape
  // `BattleArrivalResolver.writeOriginAwayTroops` uses, duplicated here rather than shared
  // because neither resolver exports its private helpers and this one is the only other
  // caller; see that method's own comment for why `subtractUnitCounts`'s `shortfall` is logged,
  // not thrown. Skipped entirely when there is nothing to subtract.
  private async writeOriginAwayTroops(
    movement: MovementDocument,
    originDoc: SettlementDocument,
    attackerLosses: TroopCounts,
    attackerSurvived: boolean,
    session: ClientSession,
  ): Promise<void> {
    const toSubtract = attackerSurvived
      ? toPlainUnitCounts(attackerLosses).filter((l) => l.count > 0)
      : movement.units.map((u) => ({ unitType: u.unitType, count: u.count }));
    if (toSubtract.length === 0) {
      return;
    }

    const { result: originAwayTroops, shortfall } = subtractUnitCounts(
      originDoc.awayTroops.map((t) => ({ unitType: t.unitType, count: t.count })),
      toSubtract,
    );
    if (shortfall.length > 0) {
      this.logger.error(
        `OasisBattleArrivalResolver: awayTroops drifted below zero applying movement ` +
          `${String(movement._id)} at origin ${String(originDoc._id)} — clamped at zero, ` +
          `shortfall: ${JSON.stringify(shortfall)}`,
      );
    }
    const updatedOrigin = await this.settlementModel.findOneAndUpdate(
      { _id: originDoc._id, version: originDoc.version },
      { $set: { awayTroops: originAwayTroops, version: originDoc.version + 1 } },
      { session },
    );
    if (!updatedOrigin) {
      throw new Error(
        `OasisBattleArrivalResolver: version conflict applying movement ${String(movement._id)} (origin awayTroops)`,
      );
    }
  }
}
