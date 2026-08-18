import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import type { EventHandler } from '../../scheduler/event-handler.interface';
import type { GameEventDocument } from '../../schemas/event.schema';
import type { MovementDocument, MovementType } from '../../schemas/movement.schema';
import { Movement } from '../../schemas/movement.schema';
import { SettlementsService } from '../../settlements/settlements.service';
import { MOVEMENT_ARRIVE_EVENT_TYPE } from '../movements.constants';
import { BattleArrivalResolver } from './battle-arrival.resolver';
import type { MovementArrivalResolver } from './movement-arrival-resolver.interface';
import { ScoutArrivalResolver } from './scout-arrival.resolver';

interface MovementArrivePayload {
  movementId: string;
}

// The shared arrival preamble (M3c.4, `docs/M3_DESIGN_DECISIONS.md` §9: "one arrival handler,
// dispatching by type"): loads the movement, applies the §18.4 replay guard, settles the
// target settlement (the seam every per-type resolver needs — pre-effect rates matter, e.g.
// for a battle's wall level), and hands off to whichever `MovementArrivalResolver` claims
// `movement.type`. Everything type-specific — scouting, a raid/assault's battle, and
// eventually support/settle/trade — lives in that resolver, not here; see
// `MovementArrivalResolver`'s own comment for the split this mirrors
// (`EventHandler`/`EventHandlerRegistry`, the in-repo precedent).
//
// Idempotency guard: re-checks `movement.status` before doing anything — only `outbound`
// means "this arrival hasn't been applied yet". A replay (a crash between this transaction
// committing and the event's own `done` mark landing, both inside the scheduler's own
// transaction per `SchedulerService.dispatch`) finds `status` already advanced past
// `outbound` (by this handler's own earlier, successful run) and no-ops — the same principle
// as `BuildCompleteHandler`'s "item already gone" check, just keyed on a status field instead
// of an array membership, because a movement (unlike a build-queue item) is never removed.
@Injectable()
export class MovementArriveHandler implements EventHandler {
  readonly type = MOVEMENT_ARRIVE_EVENT_TYPE;
  readonly supportedPayloadVersions = [1];

  // `MovementType -> MovementArrivalResolver`, built once at construction from the injected
  // resolvers — mirrors `EventHandlerRegistry`'s `Map<string, EventHandler>`, scoped to this
  // handler alone rather than promoted to its own shared, module-level registry class: unlike
  // `EventHandlerRegistry` (which the scheduler itself must consult for arbitrary event
  // types), nothing outside this handler ever needs to resolve a movement type to a resolver.
  // `support`/`settle`/`trade` have no entry — see `handle`'s own guard below.
  private readonly resolvers = new Map<MovementType, MovementArrivalResolver>();

  constructor(
    @InjectModel(Movement.name) private readonly movementModel: Model<MovementDocument>,
    @Inject(SettlementsService) private readonly settlementsService: SettlementsService,
    @Inject(ScoutArrivalResolver) scoutArrivalResolver: ScoutArrivalResolver,
    @Inject(BattleArrivalResolver) battleArrivalResolver: BattleArrivalResolver,
  ) {
    for (const resolver of [scoutArrivalResolver, battleArrivalResolver]) {
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

    const resolver = this.resolvers.get(movement.type);
    // TEMPORARY GUARD (M3c.4): `support`/`settle`/`trade` still have no arrival resolver —
    // support's stationing arrival and settle/trade's own flows are later steps, not this
    // one. Resolving one of them as some other type's arrival would silently misapply
    // effects, and unlike a thrown error that damage cannot be replayed away once it lands.
    // Throwing here instead leaves the movement `outbound` and the event `due` (via the
    // scheduler's own retry/backoff, and eventually `failed` once `maxAttempts` is exhausted —
    // see `SchedulerService.dispatch`), which is recoverable: the movement is simply resolved
    // correctly once its resolver lands. Remove this guard's mention of a type the moment that
    // type gets its own resolver.
    if (!resolver) {
      throw new Error(
        `MovementArriveHandler: no arrival resolver yet for movement ${String(movement._id)} ` +
          `of type "${movement.type}" — support/settle/trade land in a later step`,
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
}
