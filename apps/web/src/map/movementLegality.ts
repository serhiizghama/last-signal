import type { TileSelection } from './tileSelection';

/**
 * The three movement types `AttackForm` (M3e.3) can send — everything the tile sheet offers
 * besides `scout`, which `ScoutForm`/`scoutEligibility.ts` already own unchanged since M2c.2.
 */
export type AttackableMovementType = 'raid' | 'assault' | 'support';

/**
 * Which of raid/assault/support a tapped tile's *kind* can legally receive (§9's shared target
 * matrix, §10's oasis rules, §8/M3c.6's support rules) — independent of army composition,
 * troops at home, or beginner protection, which are separate, orthogonal gates
 * (`armyEligibility.ts`, `isBeginnerProtected`) the caller layers on top. Mirrors
 * `MovementsService.sendMovement`'s own target-kind branch exactly, so `TileInfoSheet` can
 * never offer a type the server would reject with `targetNotSettlement` / `supportNotToOasis`
 * / `targetIsOwnSettlement` / `targetIsOrigin` — the same "never merely disable an illegal
 * option, don't offer it at all" convention the sheet already follows for the scout action on
 * the caller's own settlement.
 *
 * Only ever called with an `oasis` or `settlement` selection — an `empty` tile has no legal
 * hostile action at all (the settle flow is M3e.6, a separate form this sheet doesn't render
 * yet), so `TileInfoSheet` never calls this for that kind.
 */
export function legalAttackTypesForTarget(
  selection: Extract<TileSelection, { kind: 'oasis' | 'settlement' }>,
  fromSettlementId: string,
): readonly AttackableMovementType[] {
  if (selection.kind === 'oasis') {
    // §10: an oasis is a legal raid/assault target (assault simply wipes the wildlife, which
    // respawns); support has nothing there to hold (no settlement document, no owner).
    return ['raid', 'assault'];
  }

  if (selection.isOwn) {
    // §8: support garrisons your OTHER settlements (multiple per account, Influence-gated,
    // §13) — never the one the army is departing from (M3c.6's `targetIsOrigin`: a
    // zero-distance no-op the server structurally rejects). Raid/assault/scout never target
    // your own settlement at all, protected or not.
    return selection.settlement.id === fromSettlementId ? [] : ['support'];
  }

  // A foreign settlement accepts all three (§9). Beginner protection, if the owner still has
  // it, is a separate, orthogonal gate the caller applies on top — this matrix answers only
  // "what kind of target is this", never "is it currently attackable".
  return ['raid', 'assault', 'support'];
}
