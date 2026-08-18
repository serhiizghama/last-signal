import type {
  BattleContingent,
  BattleKind,
  BuildingType,
  GameConfig,
  LootResult,
  Resources,
  SiegeResult,
  TroopCounts,
} from '@last-signal/game-core';
import {
  RESOURCE_KINDS,
  battleRoll,
  calcStorageCaps,
  resolveBattle,
  resolveLoot,
  resolveSiegePass,
  subtractResources,
} from '@last-signal/game-core';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { GAME_CONFIG } from '../../game-config/game-config.tokens';
import { EventSchedulerService } from '../../scheduler/event-scheduler.service';
import type { GameEventDocument } from '../../schemas/event.schema';
import type { MovementDocument } from '../../schemas/movement.schema';
import { Movement, MOVEMENT_TYPE_ASSAULT, MOVEMENT_TYPE_RAID } from '../../schemas/movement.schema';
import type { ReportDocument, ReportType } from '../../schemas/report.schema';
import {
  REPORT_TYPE_ASSAULT,
  REPORT_TYPE_BUILDING_DESTROYED,
  REPORT_TYPE_DEFENSE,
  REPORT_TYPE_RAID,
  REPORT_TYPE_SUPPORT_LOSS,
  Report,
} from '../../schemas/report.schema';
import type { BuildingSlot } from '../../schemas/settlement.schema';
import { Settlement } from '../../schemas/settlement.schema';
import type { SettlementDocument, StationedContingent } from '../../schemas/settlement.schema';
import { SettlementsService } from '../../settlements/settlements.service';
import {
  currentLevelOf,
  isBuildingType,
  stationedContingentKey,
  toBuildingLevels,
  toTroopCounts,
} from '../../settlements/settlements.util';
import { WorldService } from '../../world/world.service';
import { MOVEMENT_RETURN_EVENT_TYPE } from '../movements.constants';
import {
  computeReturnAt,
  mergeUnitCounts,
  subtractUnitCounts,
  toPlainUnitCounts,
  turnAroundOutboundMovement,
} from '../movements.util';
import type { MovementArrivalResolver } from './movement-arrival-resolver.interface';

// The opaque `key` `resolveBattle`'s `defenders` input addresses the target's own ("home")
// troops by. Every *stationed* contingent's key is `stationedContingentKey(ownerAccountId,
// fromSettlementId)` (`settlements.util.ts`) — always exactly `"<24-hex>:<24-hex>"`, 49
// characters. `'home'` can never collide with that shape (wrong length, and it contains a
// letter — `h` — past hex's `a-f` range besides), so no encoding trick is needed to keep the
// two namespaces apart.
const HOME_CONTINGENT_KEY = 'home';

// One stationed contingent, carrying both the opaque `key` `resolveBattle` addresses it by
// and the real document fields (owner/origin) needed to persist/report it back afterwards.
// Same shape as `StarvationTickHandler`'s own `KeyedContingent`.
interface KeyedContingent {
  key: string;
  original: StationedContingent;
}

type ContingentOutcome = { key: string; losses: TroopCounts; survivors: TroopCounts };

// The §7 siege pass's outcome, computed once (pure — no writes) so both `writeReports` and
// `writeDefenderSettlement` read the exact same numbers rather than two call sites each
// re-deriving them. `null` means no siege pass ran at all: `movement.type !== 'assault'`, no
// `siegeTarget` was persisted (an assault whose army carried no siege units never gets one at
// send, §9), or the stored value somehow doesn't narrow (see `computeSiegeOutcome`'s own
// comment) — every one of those is "as if no siege units survived", the exact same shape
// `resolveSiegePass` itself returns for a defeated attacker.
interface SiegeOutcome {
  /** The narrowed `movement.siegeTarget` — `'wall'` or a real `BuildingType`. */
  narrowedTarget: 'wall' | BuildingType;
  result: SiegeResult;
  /** `targetDoc.buildings`, reshaped to plain objects, with `wall`/the target level applied. */
  updatedBuildings: Array<Pick<BuildingSlot, 'id' | 'type' | 'level' | 'slot'>>;
  /** Loot-deducted resource values, further clamped to the *post-destruction* storage caps. */
  resourceValuesAfterClamp: Resources;
  /** Per resource, how much the clamp above destroyed — §15's `buildingDestroyed` payload. */
  clampedAway: Resources;
  /** True when the wall or the named target actually lost a level — gates the starvation
   * reschedule and whether a `buildingDestroyed` report is written at all (§15: "when the
   * pass actually changed a level"). */
  levelsChanged: boolean;
}

// Resolves a `raid`/`assault` arrival — the M3c.4/M3c.5a/M3c.5b battle+loot+siege step
// (`docs/M3_DESIGN_DECISIONS.md` §5/§6/§7/§9/§15/§18). §6's loot pass is resolved here (taken
// from the target's already-settled resources, deducted in the same write as the defender's
// troops, and persisted onto the movement for the return leg to credit/clamp). §7's siege
// pass runs next (M3c.5b, `computeSiegeOutcome` below): only for an `assault` carrying a
// validated `movement.siegeTarget`, using `game-core`'s `resolveSiegePass` for the level
// arithmetic and applying its own three consequences here — settle-then-change-levels (the
// preamble already settled resources to `event.dueAt` before this resolver ever ran, so the
// level change below is correctly ordered after it), the storage-cap clamp, and arming the
// starvation schedule when a destroyed building could have introduced a new Food deficit.
@Injectable()
export class BattleArrivalResolver implements MovementArrivalResolver {
  readonly types = [MOVEMENT_TYPE_RAID, MOVEMENT_TYPE_ASSAULT] as const;

  // Same pattern as every other handler/resolver in this module — the diagnostic surface for
  // `subtractUnitCounts`'s `shortfall` below.
  private readonly logger = new Logger(BattleArrivalResolver.name);

  constructor(
    @InjectModel(Movement.name) private readonly movementModel: Model<MovementDocument>,
    @InjectModel(Settlement.name) private readonly settlementModel: Model<SettlementDocument>,
    @InjectModel(Report.name) private readonly reportModel: Model<ReportDocument>,
    @Inject(EventSchedulerService) private readonly eventScheduler: EventSchedulerService,
    @Inject(WorldService) private readonly worldService: WorldService,
    @Inject(GAME_CONFIG) private readonly config: GameConfig,
    // The M3a.6 starvation lazy-scheduling choke point (`ensureStarvationSchedule`) — needed
    // here, not just from account commands and `BuildCompleteHandler`/`TrainingCompleteHandler`,
    // because a siege pass (§7) can knock a producer to 0 and introduce a Food deficit no
    // pending tick covers. `SettlementsModule` is already an import of `MovementsModule` (see
    // that module's own comment — every other handler in this file already goes through
    // `SettlementsService` for the settle seam), so this is no new module wiring.
    @Inject(SettlementsService) private readonly settlementsService: SettlementsService,
  ) {}

  async resolveArrival(
    movement: MovementDocument,
    targetDoc: SettlementDocument,
    event: GameEventDocument,
    session: ClientSession,
  ): Promise<void> {
    const originDoc = await this.settlementModel.findById(movement.fromSettlementId, null, {
      session,
    });
    // Defensive, mirrors `ScoutArrivalResolver`/every other handler here: settlements are
    // never deleted in v1, so an attacker whose own home vanished mid-flight is unreachable
    // in practice. Nothing sane to apply — leave the movement `outbound` rather than
    // guessing.
    if (!originDoc) {
      return;
    }

    // §5 step 2: every defending contingent — the target's own `troops` (keyed
    // `HOME_CONTINGENT_KEY`) plus every `stationedTroops` entry (keyed
    // `stationedContingentKey`, the exact same key `StarvationTickHandler` already uses for
    // this array, reused here rather than re-invented). Deliberately excludes
    // `targetDoc.awayTroops` — "troops of the defender that are away do not defend" (§5).
    const stationedContingents: KeyedContingent[] = targetDoc.stationedTroops.map((contingent) => ({
      key: stationedContingentKey(contingent.ownerAccountId, contingent.fromSettlementId),
      original: contingent,
    }));
    const defenders: BattleContingent[] = [
      { key: HOME_CONTINGENT_KEY, troops: toTroopCounts(targetDoc.troops) },
      ...stationedContingents.map((c) => ({
        key: c.key,
        troops: toTroopCounts(c.original.troops),
      })),
    ];

    // Computed once and reused for the wall level below, the loot pass's Hidden Cache lookup,
    // and (M3c.5b) the siege pass — one settled snapshot of the defender's buildings, not
    // three separate reshapes of the same Mongoose array.
    const buildingLevels = toBuildingLevels(targetDoc.buildings);
    const wallLevel = currentLevelOf(buildingLevels, 'wall');
    const kind: BattleKind = movement.type === MOVEMENT_TYPE_ASSAULT ? 'assault' : 'raid';
    // The deterministic roll (§5 step 4, §18): `hash(world.seed, movementId)`, never
    // `Math.random()` — a scheduler replay (or `tools/sim`, M4) must reproduce the exact same
    // battle. `WorldService.getWorld()` is read outside `session` deliberately: nothing in
    // this transaction ever writes the `world` document, so there is no isolation hazard in
    // reading it without one — its own signature never accepts a session either.
    const world = await this.worldService.getWorld();
    const roll = battleRoll(world.seed, String(movement._id));

    const result = resolveBattle(this.config, {
      attacker: toTroopCounts(movement.units),
      defenders,
      wallLevel,
      kind,
      roll,
    });

    const homeOutcome = result.defenders.find((d) => d.key === HOME_CONTINGENT_KEY);
    // Unreachable: `HOME_CONTINGENT_KEY` is always present in `defenders` above, and
    // `resolveBattle` returns exactly one outcome per input contingent. Narrows the type for
    // TypeScript rather than guarding a real runtime case.
    if (!homeOutcome) {
      throw new Error(
        `BattleArrivalResolver: resolveBattle returned no outcome for the home contingent of ` +
          `movement ${String(movement._id)}`,
      );
    }
    const stationedOutcomes = result.defenders.filter((d) => d.key !== HOME_CONTINGENT_KEY);
    const stationedByKey = new Map(stationedContingents.map((c) => [c.key, c.original]));

    // §6: loot off the target's *already-settled* resources (`targetDoc` was settled to
    // `event.dueAt` by `MovementArriveHandler`'s preamble before this resolver ever ran — the
    // same discipline M2b.3 already applies to the scouting snapshot, so the amount stolen is
    // the amount that existed at this instant) and its Hidden Cache level. `resolveLoot` takes
    // the real `BattleResult` and enforces "an unsuccessful attacker loots nothing" itself via
    // `attackerPrevailed` — nothing to special-case here, including on a total wipe below.
    const lootResult = resolveLoot(this.config, result, {
      stored: targetDoc.resources.values,
      hiddenCacheLevel: currentLevelOf(buildingLevels, 'hiddenCache'),
    });

    // §7 (M3c.5b): the siege pass, computed here — pure, no writes yet — so `writeReports`
    // and `writeDefenderSettlement` below both read the exact same numbers. `null` for a raid
    // (siege units may never join one, §9) and for an assault with no persisted
    // `siegeTarget` (no siege units survived to be named at send — see the schema's own
    // comment on `Movement.siegeTarget`).
    const siegeOutcome = this.computeSiegeOutcome(
      movement,
      targetDoc,
      buildingLevels,
      result,
      lootResult,
    );

    await this.writeReports(
      movement,
      targetDoc,
      event,
      kind,
      wallLevel,
      result,
      lootResult,
      siegeOutcome,
      homeOutcome,
      stationedOutcomes,
      stationedByKey,
      session,
    );

    const attackerSurvived = result.attacker.survivors.some((s) => s.count > 0);

    // Starvation interaction, resolved explicitly rather than left implicit: battle losses
    // only ever *remove* troops from a settlement's upkeep union (`upkeepTroopsOf` —
    // `troops`/`awayTroops`/`stationedTroops`), never add to it, so they can only ever lower
    // net Food upkeep. A settlement's existing `pendingStarvationEventId` (if any) therefore
    // stays valid either way: if it was already scheduled against a now-later (or
    // now-nonexistent) deficit, `StarvationTickHandler` simply re-settles and re-checks the
    // trigger at tick time and finds nothing to kill (or reschedules further out) — it can
    // never find a deficit this write *introduced*. Neither write below touches
    // `pendingStarvationEventId`/`pendingStarvationDueAt` for exactly that reason: a pending
    // tick can become unnecessary here, never missing.
    //
    // That reasoning covers troop losses only — it does NOT cover the siege pass (§7): a
    // knocked-out producer (a Greenhouse) or a knocked-out upkeep-weighted building can
    // introduce a *new* Food deficit no pending tick was ever scheduled against. That is
    // exactly why the ascending-order write below calls `ensureStarvationSchedule` on the
    // defender whenever `siegeOutcome.levelsChanged` — the one case this paragraph's argument
    // doesn't cover.
    //
    // §18's ascending-`_id` rule: the two Settlement documents this arrival writes (the
    // defender's troops/stationedTroops/buildings, the attacker origin's awayTroops) are
    // acquired in ascending `_id` order — "so two concurrent multi-document commands can
    // never deadlock by grabbing the same pair in opposite orders" — regardless of which one
    // happens to be the attacker and which the defender in this particular battle.
    // `String(ObjectId)` sorts identically to the underlying 12-byte value (a fixed-length
    // hex encoding), so a plain string comparison is exact. `ensureStarvationSchedule`'s own
    // extra write (below, when the siege pass actually changed a level) only ever touches
    // this same defender document — never the origin — so running it immediately after
    // `writeDefenderSettlement`, on whichever side of the branch that call already sits,
    // cannot reorder the two settlements' first-touch relative to each other.
    if (String(targetDoc._id) < String(originDoc._id)) {
      const updatedDefender = await this.writeDefenderSettlement(
        targetDoc,
        homeOutcome,
        stationedOutcomes,
        stationedByKey,
        lootResult,
        siegeOutcome,
        session,
      );
      if (siegeOutcome?.levelsChanged) {
        await this.settlementsService.ensureStarvationSchedule(
          updatedDefender,
          event.dueAt,
          session,
        );
      }
      await this.writeOriginAwayTroops(
        movement,
        originDoc,
        result.attacker.losses,
        attackerSurvived,
        session,
      );
    } else {
      await this.writeOriginAwayTroops(
        movement,
        originDoc,
        result.attacker.losses,
        attackerSurvived,
        session,
      );
      const updatedDefender = await this.writeDefenderSettlement(
        targetDoc,
        homeOutcome,
        stationedOutcomes,
        stationedByKey,
        lootResult,
        siegeOutcome,
        session,
      );
      if (siegeOutcome?.levelsChanged) {
        await this.settlementsService.ensureStarvationSchedule(
          updatedDefender,
          event.dueAt,
          session,
        );
      }
    }

    if (!attackerSurvived) {
      // Total wipe (§6/§8's shared convention): the movement ends here, `done` — no
      // `movementReturn` to schedule, nobody is coming home. `resolveLoot` already returns
      // zero `taken` for an unsuccessful attacker (§6, asserted by a test rather than
      // special-cased here), so `movement.loot` is correctly left unset below too.
      const updated = await this.movementModel.findOneAndUpdate(
        { _id: movement._id, version: movement.version },
        { $set: { status: 'done', survivors: [], version: movement.version + 1 } },
        { session },
      );
      if (!updated) {
        throw new Error(
          `BattleArrivalResolver: version conflict applying movement ${String(movement._id)}`,
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
          // Only set when something was actually taken (§6): absent is what "never looted"
          // already means for every other optional field on this schema, and the return leg
          // (`MovementReturnHandler`) only credits/clamps loot when this field is present.
          ...(lootResult.totalTaken > 0 ? { loot: lootResult.taken } : {}),
        },
      },
      { session },
    );
    if (!updated) {
      throw new Error(
        `BattleArrivalResolver: version conflict applying movement ${String(movement._id)}`,
      );
    }
  }

  // §9's turn-around edge case, this resolver's own report shape (§15): a `raid`/`assault`
  // whose target vanished before arrival gets a report of the *movement's own type*
  // (`raid`/`assault`, never `scoutFailed` — a raider is not a scout, and the report `type` is
  // the wire-level signal the client keys its rendering off of), carrying
  // `reason: 'targetNotFound'` and no battle fields (there was no battle). Turn-around
  // mechanics (schedule the return leg, every unit still alive) are identical to every other
  // movement type's — `turnAroundOutboundMovement` is the one shared implementation.
  async resolveMissingTarget(
    movement: MovementDocument,
    event: GameEventDocument,
    session: ClientSession,
  ): Promise<void> {
    const type: ReportType =
      movement.type === MOVEMENT_TYPE_ASSAULT ? REPORT_TYPE_ASSAULT : REPORT_TYPE_RAID;
    await this.reportModel.create(
      [
        {
          accountId: movement.ownerAccountId,
          type,
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

    await turnAroundOutboundMovement(
      movement,
      event,
      this.eventScheduler,
      this.movementModel,
      session,
    );
  }

  // Writes the attacker's own report (`raid`/`assault`), the defender's `defense`
  // counter-report, and one `supportLoss` report per stationed contingent that took
  // casualties — all in one `ordered: true` create call (Mongoose's requirement whenever
  // `create()` is called with both a session and more than one document — see
  // `StarvationTickHandler.writeReports`'s own comment, the precedent this mirrors). §15:
  // "Both parties always get a report, and so does every supporter with casualties."
  private async writeReports(
    movement: MovementDocument,
    targetDoc: SettlementDocument,
    event: GameEventDocument,
    kind: BattleKind,
    wallLevel: number,
    result: ReturnType<typeof resolveBattle>,
    lootResult: LootResult,
    siegeOutcome: SiegeOutcome | null,
    homeOutcome: ContingentOutcome,
    stationedOutcomes: readonly ContingentOutcome[],
    stationedByKey: ReadonlyMap<string, StationedContingent>,
    session: ClientSession,
  ): Promise<void> {
    const attackerSummary = {
      // `movement.units` is `MovementUnitEntry[]` (`unitType: string`, not yet narrowed to a
      // real `UnitType`) — a plain reshape, not `toPlainUnitCounts` (which expects the
      // already-narrowed `TroopCounts` `resolveBattle` returns), same distinction
      // `MovementsService.sendMovement` draws between raw input and `merged as TroopCounts`.
      sent: movement.units.map((u) => ({ unitType: u.unitType, count: u.count })),
      losses: toPlainUnitCounts(result.attacker.losses),
      survivors: toPlainUnitCounts(result.attacker.survivors),
    };
    // Shared between the attacker's and defender's reports — the same battle, both sides get
    // to see the same numeric internals `BattleResult` exposes. Loot is deliberately NOT in
    // here: §6 gives the two sides different loot information (the attacker also learns the
    // capacity-bound flag and the Hidden Cache protection that denied them more; the defender
    // only learns what was taken), so each report payload below adds its own loot fields.
    const sharedBattleNumbers = {
      atkPts: result.atkPts,
      defPts: result.defPts,
      x: result.x,
      attackerLossFraction: result.attackerLossFraction,
      defenderLossFraction: result.defenderLossFraction,
      wallFactor: result.wallFactor,
      defenderWallLevel: wallLevel,
      attackerPrevailed: result.attackerPrevailed,
    };

    // §7/§15 (M3c.5b): the siege pass's own numbers, shared verbatim between the attacker's
    // and the defender's report — "wall level before/after, buildings destroyed" is the
    // attacker's own intel on their assault, and the defender sees the exact same thing about
    // their own buildings. `{}` (added, never renaming a field already on either payload)
    // when no siege pass ran at all — a raid, or an assault with no persisted `siegeTarget`.
    const siegeReportFields = siegeOutcome
      ? {
          wallLevelBefore: siegeOutcome.result.wallLevelBefore,
          wallLevelAfter: siegeOutcome.result.wallLevelAfter,
          siegeTarget: siegeOutcome.narrowedTarget,
          targetLevelBefore: siegeOutcome.result.targetLevelBefore,
          targetLevelAfter: siegeOutcome.result.targetLevelAfter,
          wallPointsSpent: siegeOutcome.result.wallPointsSpent,
          wallPointsDiscarded: siegeOutcome.result.wallPointsDiscarded,
          buildingPointsSpent: siegeOutcome.result.buildingPointsSpent,
          buildingPointsDiscarded: siegeOutcome.result.buildingPointsDiscarded,
        }
      : {};

    const reports: Array<{
      accountId: MovementDocument['ownerAccountId'] | SettlementDocument['accountId'];
      type: ReportType;
      read: boolean;
      payload: Record<string, unknown>;
    }> = [
      // The attacker's report: both armies, per-unit-type losses, the defender's *total*
      // losses (merged across every contingent — `mergeUnitCounts`, the same duplicate-summing
      // helper `sendMovement` already uses for a raw unit list), the battle's numeric
      // internals, and the defender's wall level.
      {
        accountId: movement.ownerAccountId,
        type: movement.type === MOVEMENT_TYPE_ASSAULT ? REPORT_TYPE_ASSAULT : REPORT_TYPE_RAID,
        read: false,
        payload: {
          movementId: String(movement._id),
          fromSettlementId: String(movement.fromSettlementId),
          toSettlementId: String(targetDoc._id),
          target: { x: movement.target.x, y: movement.target.y },
          kind,
          attacker: attackerSummary,
          defenderLosses: mergeUnitCounts(
            result.defenders.flatMap((d) => toPlainUnitCounts(d.losses)),
          ),
          ...sharedBattleNumbers,
          ...siegeReportFields,
          lootCapacity: result.lootCapacity,
          // §6: what the raid/assault actually carried off, whether availability exceeded
          // capacity (the proportional-split case), and how much the target's Hidden Cache
          // protected per resource — real, useful intel for the raider (how much the cache
          // denied them), so it rides on the attacker's own report, not the defender's.
          loot: lootResult.taken,
          lootCapacityBound: lootResult.capacityBound,
          hiddenCacheProtection: lootResult.protectedPerResource,
        },
      },
    ];

    // The defender's counter-report: the same battle from their side — the attacker's army
    // and losses (so they know who hit them and with what), their own home losses/survivors,
    // and which *contingents* (by real owner/origin ids, not the internal key string alone —
    // §15) took losses.
    const stationedLossesForDefender = stationedOutcomes
      .filter((o) => o.losses.some((l) => l.count > 0))
      .map((o) => {
        const original = stationedByKey.get(o.key);
        return {
          ownerAccountId: original ? String(original.ownerAccountId) : null,
          fromSettlementId: original ? String(original.fromSettlementId) : null,
          losses: toPlainUnitCounts(o.losses).filter((l) => l.count > 0),
        };
      });
    reports.push({
      accountId: targetDoc.accountId,
      type: REPORT_TYPE_DEFENSE,
      read: false,
      payload: {
        movementId: String(movement._id),
        fromSettlementId: String(movement.fromSettlementId),
        toSettlementId: String(targetDoc._id),
        attackerAccountId: String(movement.ownerAccountId),
        target: { x: movement.target.x, y: movement.target.y },
        kind,
        attacker: attackerSummary,
        home: {
          losses: toPlainUnitCounts(homeOutcome.losses),
          survivors: toPlainUnitCounts(homeOutcome.survivors),
        },
        stationedLosses: stationedLossesForDefender,
        // §6: what was taken from them — no capacity-bound flag or Hidden Cache protection
        // number here (that's the attacker's own capacity internals, not the defender's).
        lootTaken: lootResult.taken,
        ...sharedBattleNumbers,
        ...siegeReportFields,
      },
    });

    // §7/§15's own report: written to the defender only when the siege pass actually changed
    // a level (wall or the named target) — never for an assault that named a target but
    // never got past the wall, and never for a raid or a siege-less assault at all
    // (`siegeOutcome` is `null` there). Carries the wall's and the target building's
    // before/after levels plus the per-resource amount the storage clamp (below) destroyed —
    // structured ids/numbers only, per §8/M1 §15, same as every other report in this file.
    if (siegeOutcome?.levelsChanged) {
      reports.push({
        accountId: targetDoc.accountId,
        type: REPORT_TYPE_BUILDING_DESTROYED,
        read: false,
        payload: {
          movementId: String(movement._id),
          fromSettlementId: String(movement.fromSettlementId),
          toSettlementId: String(targetDoc._id),
          wallLevelBefore: siegeOutcome.result.wallLevelBefore,
          wallLevelAfter: siegeOutcome.result.wallLevelAfter,
          siegeTarget: siegeOutcome.narrowedTarget,
          targetLevelBefore: siegeOutcome.result.targetLevelBefore,
          targetLevelAfter: siegeOutcome.result.targetLevelAfter,
          storageClamped: siegeOutcome.clampedAway,
        },
      });
    }

    // One `supportLoss` report per supporter whose own contingent took casualties — "their own
    // contingent's losses only" (§15): no host losses, no full battle internals, mirrors
    // `StarvationTickHandler.writeReports`'s identical-purpose supporter report.
    for (const outcome of stationedOutcomes) {
      const losses = toPlainUnitCounts(outcome.losses).filter((l) => l.count > 0);
      if (losses.length === 0) {
        continue;
      }
      const original = stationedByKey.get(outcome.key);
      if (!original) {
        // Structurally shouldn't happen — `stationedByKey` is built from the exact same
        // `targetDoc.stationedTroops` that produced every key `resolveBattle` can return, the
        // same defensive shape `StarvationTickHandler.writeReports` already guards.
        this.logger.error(
          `BattleArrivalResolver: no stationed contingent found for key "${outcome.key}" while ` +
            `writing the supporter report for settlement ${String(targetDoc._id)}.`,
        );
        continue;
      }
      reports.push({
        accountId: original.ownerAccountId,
        type: REPORT_TYPE_SUPPORT_LOSS,
        read: false,
        payload: {
          movementId: String(movement._id),
          hostSettlementId: String(targetDoc._id),
          at: event.dueAt,
          losses,
        },
      });
    }

    await this.reportModel.create(reports, { session, ordered: true });
  }

  // Writes the defender's `troops` (home contingent survivors), `stationedTroops` (every
  // stationed contingent's survivors, dropping any contingent whose troops are now empty —
  // the exact same convention `StarvationTickHandler`'s own `remainingStationed` uses for this
  // same array, matched deliberately rather than inventing a second one), the loot deduction
  // (§6), and now also — when a siege pass ran (§7, M3c.5b) — the post-destruction
  // `buildings` levels and the storage-cap-clamped resource values, all in the one write per
  // document the brief calls for, not two. Deliberately does NOT touch `resources.lastCalcAt`:
  // the preamble (`MovementArriveHandler`) already settled it to `event.dueAt` before this
  // resolver ran, and re-stamping it here would double-count production between the settle
  // and this write — exactly §7's "settle resources first, then change levels", already
  // satisfied by construction since `siegeOutcome` (computed from this same `targetDoc`) never
  // touches `lastCalcAt` either.
  //
  // Returns the updated document (`returnDocument: 'after'`) so the caller can feed it
  // straight into `SettlementsService.ensureStarvationSchedule` without a second read — the
  // starvation choke point needs the settlement's *current* buildings/resources, which is
  // exactly what this write just produced.
  private async writeDefenderSettlement(
    targetDoc: SettlementDocument,
    homeOutcome: ContingentOutcome,
    stationedOutcomes: readonly ContingentOutcome[],
    stationedByKey: ReadonlyMap<string, StationedContingent>,
    lootResult: LootResult,
    siegeOutcome: SiegeOutcome | null,
    session: ClientSession,
  ): Promise<SettlementDocument> {
    const homeTroops = toPlainUnitCounts(homeOutcome.survivors).filter((t) => t.count > 0);
    const remainingStationed = stationedOutcomes
      .map((outcome) => {
        const original = stationedByKey.get(outcome.key);
        if (!original) {
          this.logger.error(
            `BattleArrivalResolver: resolveBattle returned an unknown stationed key ` +
              `"${outcome.key}" for settlement ${String(targetDoc._id)} — dropping it defensively.`,
          );
          return null;
        }
        return {
          ownerAccountId: original.ownerAccountId,
          fromSettlementId: original.fromSettlementId,
          troops: toPlainUnitCounts(outcome.survivors).filter((t) => t.count > 0),
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null && c.troops.length > 0);

    const updatedTarget = await this.settlementModel.findOneAndUpdate(
      { _id: targetDoc._id, version: targetDoc.version },
      {
        $set: {
          troops: homeTroops,
          stationedTroops: remainingStationed,
          // §7: loot comes off first, then the siege pass's storage clamp — composed by
          // `computeSiegeOutcome` itself (it clamps the already loot-deducted values), so this
          // is simply "use the siege outcome's final figure when one exists".
          'resources.values': siegeOutcome
            ? siegeOutcome.resourceValuesAfterClamp
            : subtractResources(targetDoc.resources.values, lootResult.taken),
          ...(siegeOutcome ? { buildings: siegeOutcome.updatedBuildings } : {}),
          version: targetDoc.version + 1,
        },
      },
      { session, returnDocument: 'after' },
    );
    if (!updatedTarget) {
      throw new Error(
        `BattleArrivalResolver: version conflict applying battle to defender settlement ${String(targetDoc._id)}`,
      );
    }
    return updatedTarget;
  }

  // §7's siege pass (M3c.5b), computed once — pure, no writes — from the target's own
  // pre-write state, so `writeReports` and `writeDefenderSettlement` both read identical
  // numbers. `null` whenever no pass should run at all: `movement.type !== 'assault'`, no
  // `siegeTarget` was persisted (an assault whose surviving army carried no siege units never
  // gets one — see the schema's own comment), or (defensive only — `MovementsService.sendMovement`
  // already validates this at send, so this should be unreachable in practice) the stored
  // string doesn't narrow to a real `BuildingType`/`'wall'`. The last case logs through this
  // resolver's own `Logger` and skips the pass rather than throwing — the arrival must still
  // complete even if this one signal is bad.
  //
  // `resolveSiegePass` itself already implements "a defeated attacker never gets a siege pass"
  // (§7) — called unconditionally on `battle.attackerPrevailed`, it returns a complete no-op
  // for a defeated attacker, so there is nothing to gate on `attackerPrevailed` here.
  private computeSiegeOutcome(
    movement: MovementDocument,
    targetDoc: SettlementDocument,
    buildingLevels: ReturnType<typeof toBuildingLevels>,
    battle: ReturnType<typeof resolveBattle>,
    lootResult: LootResult,
  ): SiegeOutcome | null {
    const siegeTargetInput = movement.siegeTarget;
    if (movement.type !== MOVEMENT_TYPE_ASSAULT || siegeTargetInput === undefined) {
      return null;
    }
    if (!isBuildingType(siegeTargetInput)) {
      this.logger.error(
        `BattleArrivalResolver: movement ${String(movement._id)} carries an unrecognised ` +
          `siegeTarget "${siegeTargetInput}" — skipping the siege pass rather than ` +
          `failing the arrival.`,
      );
      return null;
    }
    const narrowedTarget: 'wall' | BuildingType = siegeTargetInput;
    const wallLevel = currentLevelOf(buildingLevels, 'wall');
    // Ignored by `resolveSiegePass` when `narrowedTarget === 'wall'` (its own doc comment) —
    // 0 is as good as any other placeholder value in that case.
    const targetBuildingLevel =
      narrowedTarget === 'wall' ? 0 : currentLevelOf(buildingLevels, narrowedTarget);

    const result = resolveSiegePass(this.config, battle, {
      wallLevel,
      siegeTarget: narrowedTarget,
      targetBuildingLevel,
    });

    // Plain reshape, not a raw Mongoose subdocument spread — same hazard `toPlainQueueItem`'s
    // comment (`settlements/build-queue.util.ts`) describes, and this array is headed for a
    // `$set`. A level that didn't change is left alone rather than rewritten with the same
    // value, and — per §7's worked example in `resolveSiegePass`'s own doc comment — a level
    // can only ever change here for a building that already has an entry (a level > 0 to
    // begin with implies one), so there is never a "create a new entry" case to handle.
    let updatedBuildings = targetDoc.buildings.map((b) => ({
      id: b.id,
      type: b.type,
      level: b.level,
      slot: b.slot,
    }));
    if (result.wallLevelAfter !== result.wallLevelBefore) {
      updatedBuildings = updatedBuildings.map((b) =>
        b.type === 'wall' ? { ...b, level: result.wallLevelAfter } : b,
      );
    }
    if (narrowedTarget !== 'wall' && result.targetLevelAfter !== result.targetLevelBefore) {
      updatedBuildings = updatedBuildings.map((b) =>
        b.type === narrowedTarget ? { ...b, level: result.targetLevelAfter } : b,
      );
    }

    // §7: "settle resources first, then change levels" — `targetDoc.resources.values` is
    // already the preamble's settled-to-`event.dueAt` snapshot, so this is simply "apply loot,
    // then clamp to the *post-destruction* caps" — the loot-then-clamp composition the brief
    // calls for, in that order.
    const newCaps = calcStorageCaps(this.config, toBuildingLevels(updatedBuildings));
    const postLoot = subtractResources(targetDoc.resources.values, lootResult.taken);
    const resourceValuesAfterClamp = { ...postLoot };
    const clampedAway: Resources = { scrap: 0, fuel: 0, electronics: 0, food: 0 };
    for (const kind of RESOURCE_KINDS) {
      clampedAway[kind] = Math.max(0, postLoot[kind] - newCaps[kind]);
      resourceValuesAfterClamp[kind] = Math.min(postLoot[kind], newCaps[kind]);
    }

    return {
      narrowedTarget,
      result,
      updatedBuildings,
      resourceValuesAfterClamp,
      clampedAway,
      levelsChanged:
        result.wallLevelAfter !== result.wallLevelBefore ||
        result.targetLevelAfter !== result.targetLevelBefore,
    };
  }

  // Subtracts the attacker's battle losses (or, on a total wipe, its entire departed army —
  // same "dead, not delayed" convention `ScoutArrivalResolver`'s total-wipe branch uses) from
  // the origin settlement's `awayTroops` (M3a.4, §3). Skipped entirely when there is nothing
  // to subtract (no losses, army survived) — one less contention point, mirrors
  // `ScoutArrivalResolver`'s own `losses.length > 0` guard.
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
        `BattleArrivalResolver: awayTroops drifted below zero applying movement ` +
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
        `BattleArrivalResolver: version conflict applying movement ${String(movement._id)} (origin awayTroops)`,
      );
    }
  }
}
