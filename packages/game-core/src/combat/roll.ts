import { hashStringToUint32, mulberry32 } from '../map/rng.js';

/**
 * The deterministic ±5% (draft) roll applied to a battle's `atkPts` (M3 §5 step 4, §18):
 * `r ∈ [-1, 1)`, derived from `hash(world.seed, movementId)` via the same FNV-1a + mulberry32
 * pair `map/rng.ts` already uses for `tileRoll` — same shape, different key, so a battle's roll
 * is as reproducible as a tile's terrain.
 *
 * **Why this can never be `Math.random()`:** battle resolution runs inside a scheduler handler
 * that must be replay-safe (playbook §4) — a crash and restart re-delivers the same arrival
 * event and must resolve the identical battle, not a new one — and inside `tools/sim` (M4),
 * which must be reproducible across runs to make tuning sweeps comparable. A wall-clock random
 * number would make a crash-replay produce a *different* battle than the report already
 * described, which is a determinism bug, not a balance one (§18: "no `Math.random()` and no
 * `Date.now()` in any resolution path").
 *
 * `mulberry32`'s first draw is `[0, 1)`; rescaled to `[-1, 1)` by `2 * draw - 1`.
 */
export function battleRoll(seed: string, movementId: string): number {
  const draw = mulberry32(hashStringToUint32(`${seed}:${movementId}`))();
  return 2 * draw - 1;
}
