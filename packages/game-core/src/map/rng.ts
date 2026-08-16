/**
 * Deterministic pseudo-randomness for the map module (M2 §2, §3). Every derived fact — terrain,
 * oasis placement — is a pure function of the stored world seed (plus coordinates, for
 * per-tile facts), never of the clock or `Math.random`, so two nodes (or a server and a
 * browser) computing the same seed always agree. Integer arithmetic only, via `Math.imul`
 * and `>>> 0`, so results are stable across platforms — no float-order or locale
 * sensitivity to worry about.
 */

/** Hashes an arbitrary string to a uint32 via FNV-1a. Deterministic, no allocation beyond the closure. */
export function hashStringToUint32(input: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  return hash >>> 0;
}

/**
 * A seeded PRNG (mulberry32): given a uint32 seed, returns a step function producing an
 * independent, uniformly distributed stream in `[0, 1)`. Small, fast, and good enough for
 * cosmetic world generation — not cryptographic.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A one-shot `[0, 1)` draw for a single `(seed, x, y)` tile: hashes the composite key, then
 * takes the first mulberry32 step. Used by `terrainAt` so terrain is a pure function of the
 * world seed and coordinates alone, with no shared state between tiles.
 */
export function tileRoll(seed: string, x: number, y: number): number {
  return mulberry32(hashStringToUint32(`${seed}:${x}:${y}`))();
}
