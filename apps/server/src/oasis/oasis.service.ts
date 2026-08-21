import type { GameConfig, OasisLiveState, TroopCounts, UnitType } from '@last-signal/game-core';
import { settleOasis } from '@last-signal/game-core';
import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { GAME_CONFIG } from '../game-config/game-config.tokens';
import type { OasisDocument } from '../schemas/oasis.schema';
import { Oasis } from '../schemas/oasis.schema';
import { WorldService } from '../world/world.service';

// Thrown internally when a version-guarded `findOneAndUpdate` matches no document (the
// expected `version` is stale) — mirrors `SettlementsService`'s identically-named internal
// signal (`settlements.errors.ts`) and `MovementsService`'s own local copy
// (`movements.errors.ts`) exactly; kept as its own local class here for the same reason those
// two decline to share one class cross-module. Unlike those two, nothing in this module ever
// catches it to retry: `OasisService` has no player-facing command of its own — both its
// callers (`MovementsService.sendMovement`'s `findByCoords`, and `MovementArriveHandler`'s
// `settleOasisDocUnchecked`) already sit inside a transaction with its own outer retry —
// `MovementsService.runCommand` for the send-side lookup, the scheduler's own backoff for the
// arrival-side settle (concurrency playbook, two retry layers). This class exists purely so a
// version conflict here fails as loudly and specifically in a stack trace/log as every other
// settle seam's does, not to be caught anywhere in this file.
export class VersionConflictError extends Error {
  constructor() {
    super('VersionConflictError: oasis version changed underneath this settle');
  }
}

// Same narrowing convention `settlements/settlements.util.ts`'s `toTroopCounts` and
// `movements/movements.util.ts`'s `isUnitType` already apply to their own module's
// `{unitType: string, count: number}` subdocument shape (`OasisDefenderEntry.unitType` is a
// plain `string` on the schema for the same reason `SettlementTroopEntry.unitType` is — see
// that field's own comment) — this module's own copy rather than a cross-module import,
// mirroring how `movements.util.ts`'s `isUnitType` already declined to import
// `settlements.util.ts`'s for exactly this "one small helper, not a cross-module dependency"
// reason.
function toTroopCounts(defenders: ReadonlyArray<{ unitType: string; count: number }>): TroopCounts {
  return defenders.map((d) => ({ unitType: d.unitType as UnitType, count: d.count }));
}

// The oasis settle seam (M3c.7a, `docs/M3_DESIGN_DECISIONS.md` §10) — the same lazy pattern
// `SettlementsService`'s own settle seam already established for settlement resources
// (`docs/CONCURRENCY_PLAYBOOK.md` §3), applied to an oasis's live defender/loot state
// instead: no background tick ever runs against the 24 oases M2 placed, so any command or
// handler that touches one settles it first, up to `now`, under the same version guard as
// every other mutating write.
//
// Ownership-free by construction, for a stronger reason than `SettlementsService`'s own
// ownership-free sibling has: an oasis has no owning account at all (§10 — "still not
// annexable... no ownership field"), so there is no "calling account" to check ownership
// against for ANY caller, not just a scheduler-driven one. That is why this service has only
// one settle entry point rather than the settlement side's ownership-checked/ownership-free
// pair.
@Injectable()
export class OasisService {
  constructor(
    @InjectModel(Oasis.name) private readonly oasisModel: Model<OasisDocument>,
    @Inject(WorldService) private readonly worldService: WorldService,
    @Inject(GAME_CONFIG) private readonly config: GameConfig,
  ) {}

  // The coordinate lookup `MovementsService.sendMovement`'s target resolution needs (§9):
  // "no settlement at (x, y) — is there an oasis there instead". Deliberately does NOT
  // settle: nothing `sendMovement`'s own validation does reads an oasis's live defender/loot
  // state, only whether one exists at all, so settling here would be a write with zero
  // information gained for this caller. The actual settle happens once, at arrival, where
  // the live numbers first matter — see `settleOasisDocUnchecked` below.
  async findByCoords(x: number, y: number, session: ClientSession): Promise<OasisDocument | null> {
    return this.oasisModel.findOne({ x, y }, null, { session });
  }

  // The settle-and-persist core (mirrors `SettlementsService.settleDoc`'s shape and
  // version-guard discipline — see that method's own comment in
  // `settlements/settlements.service.ts`). Skips the write entirely when nothing would
  // change, EXCEPT the one case `settleOasis` itself documents as needing unconditional
  // materialisation: `lastRegenAt === null` (never touched since world generation, per
  // `Oasis.lastRegenAt`'s own schema comment) always falls through to a real settle+write
  // regardless of `now`, so first contact still gets the full target garrison rather than
  // being silently swallowed by a stale-looking timestamp comparison.
  //
  // `now <= lastRegenAt` is the single-timestamp gate checked below even though a settled
  // oasis actually carries two independent clocks (`lastRegenAt` for continuous Food,
  // `lastDefenderRegenAt` for discrete whole-interval defender growth — see
  // `OasisLiveState`'s own comment in `game-core` for why one clock cannot serve both). This
  // is a correct gate, not an approximation: `lastRegenAt` is the one of the two that always
  // advances all the way to `now` on any real settle, and `lastDefenderRegenAt` can never lag
  // more than one `defenderIntervalMs` behind it in a settled document (each settle credits
  // every whole interval elapsed and advances the timestamp by exactly that much, banking
  // only the sub-interval remainder) — so `now <= lastRegenAt` already guarantees no whole
  // defender interval could have elapsed either, making one comparison a correct no-op check
  // for both clocks at once.
  private async settleDoc(
    doc: OasisDocument,
    seed: string,
    now: number,
    session: ClientSession,
  ): Promise<OasisDocument> {
    if (doc.lastRegenAt !== null && now - doc.lastRegenAt <= 0) {
      return doc;
    }

    // Reshapes `doc.defenders` off its Mongoose subdocument array into plain, narrowed
    // objects before it ever reaches the pure `settleOasis` — so its output
    // (`settled.defenders`, built from either the fresh `target` array or a spread of this
    // already-plain input) is guaranteed plain too, and safe to `$set` directly without the
    // hazard `toPlainQueueItem`'s comment describes (`settlements/build-queue.util.ts`).
    const state: OasisLiveState = {
      defenders: toTroopCounts(doc.defenders),
      food: doc.loot.food,
      lastRegenAt: doc.lastRegenAt,
      lastDefenderRegenAt: doc.lastDefenderRegenAt,
    };
    const settled = settleOasis(this.config, seed, doc.x, doc.y, state, now);

    const updated = await this.oasisModel.findOneAndUpdate(
      { _id: doc._id, version: doc.version },
      {
        $set: {
          defenders: settled.defenders,
          'loot.food': settled.food,
          lastRegenAt: settled.lastRegenAt,
          lastDefenderRegenAt: settled.lastDefenderRegenAt,
          version: doc.version + 1,
        },
      },
      { session, returnDocument: 'after' },
    );
    if (!updated) {
      throw new VersionConflictError();
    }
    return updated;
  }

  // The ownership-free settle entry point `MovementArriveHandler` needs (§10/§18): loads the
  // oasis by id, settles it to `now` (the caller passes `event.dueAt`, never `Date.now()` —
  // §18's determinism rule is this method's caller's responsibility, the same way it is
  // `SettlementsService.settleSettlementDocUnchecked`'s caller's), and returns the updated
  // document — or `null` when the oasis is gone, the same "defended-but-impossible" shape
  // `settleSettlementDocUnchecked` returns for a missing target (oases are never deleted in
  // v1 either, but the handler defends anyway rather than assuming it — see
  // `OasisScoutArrivalResolver.resolveMissingTarget`).
  async settleOasisDocUnchecked(
    oasisId: string,
    now: number,
    session: ClientSession,
  ): Promise<OasisDocument | null> {
    const doc = await this.oasisModel.findById(oasisId, null, { session });
    if (!doc) {
      return null;
    }
    // `WorldService.getWorld()` is read outside `session` deliberately, mirroring
    // `BattleArrivalResolver`'s identical call (`handlers/battle-arrival.resolver.ts`): the
    // world document is never written by anything in this transaction (or any transaction —
    // it is created once at bootstrap and never mutated again), so there is no isolation
    // hazard in reading it without one, and its own signature never accepts a session either.
    const world = await this.worldService.getWorld();
    return this.settleDoc(doc, world.seed, now, session);
  }
}
