import { GRID_RADIUS } from '../schemas/grid.constants';

export interface Tile {
  x: number;
  y: number;
}

// "Outer ring" = tiles whose Chebyshev distance from the centre (the Signal Source, per
// §14/IMPLEMENTATION_PLAN.md's "humans spawn in the outer ring") falls in this band, not a
// single one-tile-wide ring. A 3-tile-deep band (28..30, out of a 30-tile radius — the
// outermost 10%) gives ~150 accounts (IMPLEMENTATION_PLAN.md's total) comfortable room to
// spread (696 tiles, well over 4x the account count) without visually crowding into a
// razor-thin line, while still reading as unambiguously "the edge of the map". M2's
// terrain-aware placement policy is free to replace this band (or the whole rule) without
// touching the schema.
export const OUTER_RING_MIN_DISTANCE = GRID_RADIUS - 2;
export const OUTER_RING_MAX_DISTANCE = GRID_RADIUS;

// Chebyshev distance from the centre: max(|x|, |y|).
function chebyshevDistance(x: number, y: number): number {
  return Math.max(Math.abs(x), Math.abs(y));
}

// Every tile at Chebyshev distance exactly `d` from the centre, walked clockwise starting
// at the top-left corner `(-d, -d)`: top edge left-to-right, right edge top-to-bottom,
// bottom edge right-to-left, left edge bottom-to-top — each edge excludes the corner
// already emitted by the previous edge, so every tile appears exactly once. `d` must be
// >= 1 (this band never includes the centre, so the `d === 0` case is unreachable in
// practice, but is handled for completeness/testability).
function ringTiles(d: number): Tile[] {
  if (d === 0) {
    return [{ x: 0, y: 0 }];
  }
  const tiles: Tile[] = [];
  for (let x = -d; x <= d; x += 1) {
    tiles.push({ x, y: -d });
  }
  for (let y = -d + 1; y <= d; y += 1) {
    tiles.push({ x: d, y });
  }
  for (let x = d - 1; x >= -d; x -= 1) {
    tiles.push({ x, y: d });
  }
  for (let y = d - 1; y >= -d + 1; y -= 1) {
    tiles.push({ x: -d, y });
  }
  return tiles;
}

// The full outer-ring band flattened into one ordered walk: innermost sub-ring first,
// outward — a deterministic "perimeter" for the stride mapping below to index into.
// Computed once at module load; the band is small (696 tiles at the default constants) and
// fixed for the process lifetime.
const PERIMETER: readonly Tile[] = (() => {
  const tiles: Tile[] = [];
  for (let d = OUTER_RING_MIN_DISTANCE; d <= OUTER_RING_MAX_DISTANCE; d += 1) {
    tiles.push(...ringTiles(d));
  }
  return tiles;
})();

export const PERIMETER_LENGTH = PERIMETER.length;

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

// A stride coprime to `n`, chosen near `n * (golden ratio conjugate)` (~0.618) — the
// classic "Fibonacci hashing" trick for a low-discrepancy stepping sequence: since the
// stride is coprime to `n`, `counter -> (counter * stride) mod n` visits every one of the
// `n` positions exactly once before repeating (a full-cycle permutation), and because the
// golden-ratio step is irrational-like relative to `n`, consecutive counters land roughly
// the "golden angle" apart around the ring instead of a small fixed hop that could still
// look locally bunched for nearby counter values. Computed from `n` at runtime (not a
// hardcoded prime) so this stays correct if the band or grid size constants ever change.
function findCoprimeStride(n: number): number {
  if (n <= 1) {
    return 1;
  }
  const golden = 0.6180339887498949;
  const center = Math.round(n * golden);
  for (let offset = 0; offset < n; offset += 1) {
    const up = center + offset;
    if (up >= 1 && up < n && gcd(up, n) === 1) {
      return up;
    }
    const down = center - offset;
    if (down >= 1 && down < n && gcd(down, n) === 1) {
      return down;
    }
  }
  // Unreachable for n > 1: gcd(1, n) === 1 always holds, so the loop above finds a
  // coprime candidate (at worst 1 itself) well before `offset` reaches `n`.
  return 1;
}

const STRIDE = findCoprimeStride(PERIMETER_LENGTH);

function positiveMod(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

// Deterministic, pure mapping from a per-world counter value to an outer-ring tile.
// `counter` is expected to be a non-negative integer (the caller's atomic Mongo counter
// starts at 1 and only ever increments) but the mapping is well-defined for any integer.
//
// Successive counters are spread around the ring rather than clustered: consecutive
// `counter` values map to perimeter positions exactly `STRIDE` apart (mod `PERIMETER_LENGTH`),
// and `STRIDE` is coprime to `PERIMETER_LENGTH` (see `findCoprimeStride`), so the mapping is
// a full-cycle permutation — every tile is visited exactly once every `PERIMETER_LENGTH`
// counters, with no two counters ever mapping to the same tile within one full cycle.
export function pickOuterRingTile(counter: number): Tile {
  const index = positiveMod(counter * STRIDE, PERIMETER_LENGTH);
  const tile = PERIMETER[index];
  if (!tile) {
    // Unreachable: `index` is always in `[0, PERIMETER_LENGTH)` by construction.
    throw new RangeError(`pickOuterRingTile: no tile at perimeter index ${index}`);
  }
  return tile;
}

// Re-exported for tests/callers that want to assert the geometry directly rather than
// through the counter mapping (e.g. "every tile in the band has Chebyshev distance in
// [MIN, MAX]").
export { chebyshevDistance };
