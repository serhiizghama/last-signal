import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { OasisService } from '../../oasis/oasis.service';
import type { EventHandler } from '../../scheduler/event-handler.interface';
import type { GameEventDocument } from '../../schemas/event.schema';
import { MOVEMENT_TYPE_SETTLE } from '../../schemas/movement.schema';
import type { MovementDocument, MovementType } from '../../schemas/movement.schema';
import { Movement } from '../../schemas/movement.schema';
import { SettlementsService } from '../../settlements/settlements.service';
import { MOVEMENT_ARRIVE_EVENT_TYPE } from '../movements.constants';
import { BattleArrivalResolver } from './battle-arrival.resolver';
import type { MovementArrivalResolver } from './movement-arrival-resolver.interface';
import type { OasisArrivalResolver } from './oasis-arrival-resolver.interface';
import { OasisBattleArrivalResolver } from './oasis-battle-arrival.resolver';
import { OasisScoutArrivalResolver } from './oasis-scout-arrival.resolver';
import { ScoutArrivalResolver } from './scout-arrival.resolver';
import { SettleArrivalResolver } from './settle-arrival.resolver';
import { SupportArrivalResolver } from './support-arrival.resolver';
import { TradeArrivalResolver } from './trade-arrival.resolver';

interface MovementArrivePayload {
  movementId: string;
}

// The shared arrival preamble (M3c.4, `docs/M3_DESIGN_DECISIONS.md` §9: "one arrival handler,
// dispatching by type"): loads the movement, applies the §18.4 replay guard, settles the
// target — a settlement, a farm oasis (§10, M3c.7a), or — as of M3d.1, §13 — nothing at all
// (a `settle` movement's target is a bare tile with no document yet) — and hands off to
// whichever resolver claims that target kind. Everything type-specific — scouting, a
// raid/assault's battle, support, founding, and eventually trade — lives in the resolver, not
// here; see `MovementArrivalResolver`/`OasisArrivalResolver`/`TileArrivalResolver`'s own
// comments for the split this mirrors (`EventHandler`/`EventHandlerRegistry`, the in-repo
// precedent).
//
// **Two registries plus one direct field, not one dispatch table (M3c.7a, widened M3d.1).** A
// movement's target is *at most* one of a settlement or an oasis (the schema's own documented
// invariant — see `Movement.toSettlementId`'s comment) — and, uniquely for `settle`, neither
// at all. The two `Map`-backed registries below exist because a settlement target and an
// oasis target need genuinely different resolvers per `MovementType` (an oasis has no owner,
// no siege pass, no intel tiers — §10), so `handle` branches on which id the movement
// actually carries and consults that kind's own `type -> resolver` map. The tile-target case
// needs no such map — `settle` is the only type that can ever reach it — so it is wired as a
// single `settleResolver` field instead; see that field's own comment.
@Injectable()
export class MovementArriveHandler implements EventHandler {
  readonly type = MOVEMENT_ARRIVE_EVENT_TYPE;
  readonly supportedPayloadVersions = [1];

  // `MovementType -> MovementArrivalResolver`, built once at construction from the injected
  // resolvers — mirrors `EventHandlerRegistry`'s `Map<string, EventHandler>`, scoped to this
  // handler alone rather than promoted to its own shared, module-level registry class: unlike
  // `EventHandlerRegistry` (which the scheduler itself must consult for arbitrary event
  // types), nothing outside this handler ever needs to resolve a movement type to a resolver.
  // As of M3d.3, `trade` (`TradeArrivalResolver`) has an entry too — every `MovementType` that
  // can ever reach `handleSettlementTarget` now does (see that method's own guard, now
  // unreachable in practice, updated accordingly). `settle` is the one type that never will:
  // it has no entry here (nor in `oasisResolvers` below), not because it's unimplemented, but
  // because it can never reach either registry at all — its target is neither a settlement nor
  // an oasis (§9/§13). See the dedicated `settleResolver` field and `handle`'s own third
  // dispatch branch below.
  private readonly resolvers = new Map<MovementType, MovementArrivalResolver>();

  // The oasis-target sibling registry (M3c.7a, §9/§10) — `scout` (`OasisScoutArrivalResolver`)
  // and, as of M3c.7b, `raid`/`assault` (`OasisBattleArrivalResolver`). Kept as its own `Map`,
  // not folded into `resolvers` above: the two are keyed by the same `MovementType`, but which
  // one `handle` consults depends on the *target kind*, not the movement type, so a single
  // shared map could never express "scout has a settlement resolver AND a separate oasis
  // resolver".
  private readonly oasisResolvers = new Map<MovementType, OasisArrivalResolver>();

  constructor(
    @InjectModel(Movement.name) private readonly movementModel: Model<MovementDocument>,
    @Inject(SettlementsService) private readonly settlementsService: SettlementsService,
    @Inject(OasisService) private readonly oasisService: OasisService,
    @Inject(ScoutArrivalResolver) scoutArrivalResolver: ScoutArrivalResolver,
    @Inject(BattleArrivalResolver) battleArrivalResolver: BattleArrivalResolver,
    @Inject(SupportArrivalResolver) supportArrivalResolver: SupportArrivalResolver,
    @Inject(TradeArrivalResolver) tradeArrivalResolver: TradeArrivalResolver,
    @Inject(OasisScoutArrivalResolver) oasisScoutArrivalResolver: OasisScoutArrivalResolver,
    @Inject(OasisBattleArrivalResolver) oasisBattleArrivalResolver: OasisBattleArrivalResolver,
    // The tile-target resolver (M3d.1, §9/§13) — wired directly, NOT through a
    // `Map<MovementType, ...>` like `resolvers`/`oasisResolvers` above: `settle` is the only
    // movement type that can ever reach "neither `toSettlementId` nor `toOasisId` set", so a
    // one-entry map would buy nothing over a single field. See
    // `TileArrivalResolver`'s own comment for why this contract deliberately looks different
    // from its two siblings.
    @Inject(SettleArrivalResolver) private readonly settleResolver: SettleArrivalResolver,
  ) {
    for (const resolver of [
      scoutArrivalResolver,
      battleArrivalResolver,
      supportArrivalResolver,
      tradeArrivalResolver,
    ]) {
      for (const type of resolver.types) {
        // Throws on a duplicate `type` so a copy-paste mistake fails loudly at boot instead of
        // silently shadowing an existing resolver — same guard `EventHandlerRegistry.register`
        // applies to event types.
        if (this.resolvers.has(type)) {
          throw new Error(
            `MovementArriveHandler: a resolver for movement type "${type}" is already registered`,
          );
        }
        this.resolvers.set(type, resolver);
      }
    }

    for (const resolver of [oasisScoutArrivalResolver, oasisBattleArrivalResolver]) {
      for (const type of resolver.types) {
        if (this.oasisResolvers.has(type)) {
          throw new Error(
            `MovementArriveHandler: an oasis resolver for movement type "${type}" is already registered`,
          );
        }
        this.oasisResolvers.set(type, resolver);
      }
    }
  }

  async handle(event: GameEventDocument, session: ClientSession): Promise<void> {
    const payload = event.payload as unknown as MovementArrivePayload;

    const movement = await this.movementModel.findById(payload.movementId, null, { session });
    // The movement itself is gone — nothing left to apply this to. Not expected in practice
    // (movements are never deleted in v1) but defensive rather than throwing, mirroring
    // `BuildCompleteHandler`.
    if (!movement) {
      return;
    }
    if (movement.status !== 'outbound') {
      return;
    }

    // Branch on the target kind (§9/§10/§13) — the replay guard above runs first,
    // unconditionally, for all three branches.
    if (movement.toOasisId != null) {
      await this.handleOasisTarget(movement, event, session);
      return;
    }
    if (movement.toSettlementId != null) {
      await this.handleSettlementTarget(movement, event, session);
      return;
    }

    // Neither id is set (M3d.1, §9/§13): legitimate now, but ONLY for `settle` — its target is
    // a bare tile with no document to reference (`Movement.toSettlementId`'s comment, widened
    // in M3d.1 from "exactly one" to "at most one, and a `settle` movement sets neither"). This
    // check must come before the "corrupt document" throw below, since it's the one case that
    // throw is explicitly carved out for.
    if (movement.type === MOVEMENT_TYPE_SETTLE) {
      await this.settleResolver.resolveArrival(movement, event, session);
      return;
    }

    // Neither id is set AND the type isn't `settle` — a corrupt document under the schema's
    // own documented invariant. This should be structurally impossible (every send path sets
    // either exactly one of the two ids, or — for `settle` only — neither), but a
    // scheduler-driven handler processing a movement it did not create must not silently
    // guess which target kind was intended. Throwing keeps the event `due`/retried (the same
    // recoverable-dead-letter shape the two guards below use) rather than resolving corrupt
    // data against an arbitrary default — a human operator has to fix the document, the same
    // as any other structurally-impossible state this codebase throws loudly on rather than
    // silently papering over.
    throw new Error(
      `MovementArriveHandler: movement ${String(movement._id)} of type "${movement.type}" has ` +
        'neither toSettlementId nor toOasisId set — corrupt document, refusing to guess a ' +
        'target kind',
    );
  }

  private async handleSettlementTarget(
    movement: MovementDocument,
    event: GameEventDocument,
    session: ClientSession,
  ): Promise<void> {
    const resolver = this.resolvers.get(movement.type);
    // DEFENSIVE NET, now unreachable in practice (M3c.4, narrowed in M3c.6, M3d.1 and again in
    // M3d.3): every `MovementType` that can actually carry a `toSettlementId` today —
    // `scout`, `raid`, `assault`, `support`, `trade` — has a registered resolver as of this
    // step (`settle` never reaches this method at all — see `handle`'s own third dispatch
    // branch and the `resolvers` map's comment). This guard is kept, not deleted, for the same
    // reason `handleOasisTarget`'s sibling guard below is kept: it is the one thing standing
    // between a future movement type reaching a settlement target with no resolver shipped
    // for it, and that arrival being silently misapplied as some other type's effects instead
    // of dead-lettering recoverably. Throwing here leaves the movement `outbound` and the
    // event `due` (via the scheduler's own retry/backoff, and eventually `failed` once
    // `maxAttempts` is exhausted — see `SchedulerService.dispatch`), which is recoverable: the
    // movement is simply resolved correctly once its resolver lands.
    if (!resolver) {
      throw new Error(
        `MovementArriveHandler: no arrival resolver registered for movement ${String(movement._id)} ` +
          `of type "${movement.type}"`,
      );
    }

    // The settle seam (M2b.3): settles the *defender's* resources — ownership-free, since
    // there is no "calling account" for a scheduler-driven handler to check ownership
    // against; see `SettlementsService.settleSettlementDocUnchecked`'s own comment. `null`
    // means the target settlement is gone — §6's defended-but-impossible edge case.
    const targetDoc = await this.settlementsService.settleSettlementDocUnchecked(
      String(movement.toSettlementId),
      event.dueAt,
      session,
    );
    if (!targetDoc) {
      await resolver.resolveMissingTarget(movement, event, session);
      return;
    }

    await resolver.resolveArrival(movement, targetDoc, event, session);
  }

  private async handleOasisTarget(
    movement: MovementDocument,
    event: GameEventDocument,
    session: ClientSession,
  ): Promise<void> {
    const resolver = this.oasisResolvers.get(movement.type);
    // GUARD, now unreachable in practice (M3c.7a added it as a load-bearing TEMPORARY guard
    // while only `scout` had an oasis resolver; M3c.7b landed `raid`/`assault`
    // (`OasisBattleArrivalResolver`), so every `MovementType` that can actually carry a
    // `toOasisId` today — `scout`, `raid`, `assault` — now has one registered above. `support`
    // is rejected at send before it ever reaches an oasis (`errors.movement.supportNotToOasis`,
    // M3c.7a); `settle` is rejected at send too (`errors.movement.tileOccupied`, M3d.1) — an
    // oasis occupies its tile exactly as a settlement does, §13 — so a `settle` movement can
    // never carry a `toOasisId` either; `trade` (M3d.3) is always created by
    // `MarketService.acceptOffer` with an explicit `toSettlementId` for both legs — an offer's
    // two parties are always settlements, never oases — so it can never produce one either.
    // Kept, not deleted, for the same reason the settlement-side guard above
    // is kept: it is the one thing standing between a future movement type reaching an oasis
    // target with no resolver shipped for it, and that arrival being silently misapplied as
    // some other type's effects instead of dead-lettering recoverably. The movement stays
    // `outbound`, the event stays `due`/retried, exactly as the settlement-side guard already
    // documents.
    if (!resolver) {
      throw new Error(
        `MovementArriveHandler: no oasis arrival resolver yet for movement ${String(movement._id)} ` +
          `of type "${movement.type}"`,
      );
    }

    // The settle seam (§10/§18): settles the oasis's live defender/loot state — ownership-
    // free by construction (an oasis has no owning account at all, unlike a settlement's
    // ownership-free-but-still-owned-by-someone case — see `OasisService`'s own comment).
    // `null` means the target oasis is gone — the same defended-but-impossible edge case as
    // the settlement side, carried over verbatim for a target kind that is also never
    // deleted in v1.
    const targetDoc = await this.oasisService.settleOasisDocUnchecked(
      String(movement.toOasisId),
      event.dueAt,
      session,
    );
    if (!targetDoc) {
      await resolver.resolveMissingTarget(movement, event, session);
      return;
    }

    await resolver.resolveArrival(movement, targetDoc, event, session);
  }
}
