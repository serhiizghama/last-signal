// Fixed filter value for the one document `PlacementCounter` ever holds — see that
// schema's comment.
export const PLACEMENT_COUNTER_KEY = 'settlement-outer-ring';

// Bounded retry count for the "candidate tile collided with the unique {x,y} index, advance
// to the next one" loop (see `SettlementsService.createSettlement`). Not the full perimeter
// length (696 at the default constants) — that would let one request's worst case take
// hundreds of round-trips. Collisions are expected to be exceedingly rare (the outer-ring
// band comfortably outnumbers ~150 accounts, and the stride walk spreads allocations well
// apart — see `placement.geometry.ts`), so this is generous headroom, not a realistic ceiling.
export const MAX_PLACEMENT_ATTEMPTS = 25;
