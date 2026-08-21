import type { ClientSession } from 'mongoose';

import type { GameEventDocument } from '../../schemas/event.schema';
import type { MovementDocument, MovementType } from '../../schemas/movement.schema';
import type { OasisDocument } from '../../schemas/oasis.schema';

// The oasis-target sibling of `MovementArrivalResolver` (M3c.7a,
// `docs/M3_DESIGN_DECISIONS.md` §9/§10): identical contract — same `types` array, same
// `resolveArrival`/`resolveMissingTarget` split, same "runs inside the arrival's own
// transaction, every write must go through `session`" discipline — with an `OasisDocument`
// target instead of a `SettlementDocument`. See that interface's own comment
// (`movement-arrival-resolver.interface.ts`) for the full rationale this mirrors; only what
// differs is called out again here.
//
// `MovementArriveHandler` now holds two of these `type -> resolver` registries side by side
// — one keyed off `movement.toSettlementId`, one off `movement.toOasisId` — and dispatches to
// whichever one the movement's actual target kind selects; see that handler's own comment for
// the branch. Kept as its own sibling interface rather than a shared generic over the target
// type: the two registries' resolvers do genuinely different things per §10 (an oasis has no
// owner, no siege pass, no intel tiers), and a generic type parameter here would buy nothing
// but indirection for what is, in this step, a single implementer.
export interface OasisArrivalResolver {
  // Only `scout` claims a type here in M3c.7a (`OasisScoutArrivalResolver`) — `raid`/
  // `assault` at an oasis land in M3c.7b. See `MovementArrivalResolver.types`'s own comment
  // for the duplicate-registration guard this feeds, applied by `MovementArriveHandler` to
  // this registry exactly the way it already is to the settlement one.
  readonly types: readonly MovementType[];

  // The normal case: the target oasis was found and settled (pre-effect state, by the shared
  // preamble) before this runs. Runs inside the arrival's own transaction; every write must
  // go through `session` for the same commit-or-roll-back-together guarantee
  // `MovementArrivalResolver.resolveArrival` already documents.
  resolveArrival(
    movement: MovementDocument,
    targetDoc: OasisDocument,
    event: GameEventDocument,
    session: ClientSession,
  ): Promise<void>;

  // The §9/§6 "defended-but-impossible" edge case, carried over verbatim: oases are never
  // deleted in v1 either, but the handler defends anyway rather than assuming it. No
  // defender to resolve against — this resolver writes its own report, then turns the whole
  // force around unharmed, the same mechanics `turnAroundOutboundMovement` already gives the
  // settlement side.
  resolveMissingTarget(
    movement: MovementDocument,
    event: GameEventDocument,
    session: ClientSession,
  ): Promise<void>;
}
