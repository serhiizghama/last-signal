import type { ClientSession } from 'mongoose';

import type { GameEventDocument } from '../../schemas/event.schema';
import type { MovementDocument } from '../../schemas/movement.schema';

// The tile-target sibling of `MovementArrivalResolver`/`OasisArrivalResolver` (M3d.1,
// `docs/M3_DESIGN_DECISIONS.md` §9/§13): a `settle` movement's target is neither a
// `Settlement` document nor an `Oasis` document — it is a bare tile that does not exist as a
// document at all until (on success) `resolveArrival` creates one there. There is therefore
// nothing for `MovementArriveHandler`'s shared preamble to settle-and-hand-in the way it does
// for the other two target kinds (`SettlementDocument`/`OasisDocument`), so this contract
// takes no target-document parameter at all — just the movement, the event, and the session.
//
// Unlike the other two sibling interfaces, this one is not a per-`MovementType` registry
// entry: `settle` is the only movement type that can ever reach "neither `toSettlementId` nor
// `toOasisId` set" (the schema's own documented invariant — see `Movement.toSettlementId`'s
// comment), so `MovementArriveHandler` wires exactly one implementation of this interface
// directly, rather than building a `Map<MovementType, TileArrivalResolver>` with a single
// entry for no reason. See that handler's own comment on its tile-target dispatch branch.
export interface TileArrivalResolver {
  // Re-checks everything the world could have changed since send (§13: tile still free, still
  // `isSettleable`, Influence still permits another settlement), then either creates the
  // settlement and ends the movement `done`, or turns the whole convoy around with its
  // Settlers alive and a `settle` report naming which check failed. One transaction — the
  // same one `MovementArriveHandler`'s caller (the scheduler, or a direct replay call) already
  // opened; every write must go through `session`.
  resolveArrival(
    movement: MovementDocument,
    event: GameEventDocument,
    session: ClientSession,
  ): Promise<void>;

  // Deliberately NOT part of this interface (unlike its two siblings' `resolveMissingTarget`):
  // that method exists to handle "the target document that used to be here is gone by
  // arrival" — a real possibility for a `Settlement`/`Oasis` id resolved at send time, since
  // the world can change while the convoy travels. A `settle` movement never resolves a
  // target document at send at all (§13's whole point is that the tile has none yet), so
  // there is no id to have gone stale and nothing for a "missing target" case to mean here.
  // Every way the world can have changed by arrival — the tile got taken, it stopped being
  // settleable, Influence dropped — is a *normal, expected* outcome `resolveArrival` itself
  // re-checks and handles, not an exceptional "the thing I was pointed at vanished" case.
}
