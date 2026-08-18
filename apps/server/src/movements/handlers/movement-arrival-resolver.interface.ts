import type { ClientSession } from 'mongoose';

import type { GameEventDocument } from '../../schemas/event.schema';
import type { MovementDocument, MovementType } from '../../schemas/movement.schema';
import type { SettlementDocument } from '../../schemas/settlement.schema';

// The per-type arrival-resolver contract §9's registry dispatches through
// (`docs/M3_DESIGN_DECISIONS.md` §9: "the handler resolves a per-type arrival resolver from a
// registry"). `MovementArriveHandler` owns the shared preamble — the §18.4 replay guard
// (`status !== 'outbound'` no-ops) and settling the target via
// `SettlementsService.settleSettlementDocUnchecked` — and hands off to whichever resolver
// claims `movement.type` for everything after that. Mirrors the existing split between
// `EventHandler` (the scheduler's shared claim/dispatch/retry machinery) and what a specific
// event type actually does — see `scheduler/event-handler.interface.ts`/`event-handler.registry.ts`,
// the in-repo precedent this is modelled on.
export interface MovementArrivalResolver {
  // One resolver may claim more than one `MovementType` — `raid`/`assault` share one
  // (`BattleArrivalResolver`), since both resolve through the same `resolveBattle` call and
  // differ only in `kind`. `MovementArriveHandler`'s own `type -> resolver` map rejects two
  // resolvers claiming the same type, the same duplicate-registration guard
  // `EventHandlerRegistry.register` already applies to event types.
  readonly types: readonly MovementType[];

  // The normal case: the target settlement was found and settled (pre-effect rates — this
  // matters, e.g. for a battle's wall level) by the shared preamble. Runs inside the
  // arrival's own transaction; every write must go through `session` for the "effects and the
  // event's `done` mark commit or roll back together" guarantee `EventHandler.handle` already
  // documents to hold here too.
  resolveArrival(
    movement: MovementDocument,
    targetDoc: SettlementDocument,
    event: GameEventDocument,
    session: ClientSession,
  ): Promise<void>;

  // The §9/§6 "defended-but-impossible" edge case: the target settlement is gone by arrival
  // (settlements are never deleted in v1, but the handler defends anyway rather than
  // assuming it). No defender to resolve against — each resolver writes its own report, in
  // its own shape and `type` (one of this resolver's own `types`, per §15: a raider must
  // never receive a `scoutFailed` report), then turns the whole force around unharmed.
  resolveMissingTarget(
    movement: MovementDocument,
    event: GameEventDocument,
    session: ClientSession,
  ): Promise<void>;
}
