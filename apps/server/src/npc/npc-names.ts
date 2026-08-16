import type { NpcRng } from './npc.tokens';

// A small post-apocalyptic-survivor-themed name generator (M2a.5, §4: NPCs must be
// indistinguishable from humans — no "NPC #37"). 40 x 40 = 1600 combinations, comfortably
// above the ~135-account seed target with room for `WORLD_NPC_COUNT` to grow; `generateNpcName`
// below guarantees uniqueness regardless via the caller-supplied `taken` set.
const FIRST_NAMES: readonly string[] = [
  'Ash',
  'Raven',
  'Wren',
  'Sable',
  'Juniper',
  'Talon',
  'Nyx',
  'Ridge',
  'Ember',
  'Fenn',
  'Sage',
  'Briar',
  'Cove',
  'Marrow',
  'Vale',
  'Kestrel',
  'Rust',
  'Flint',
  'Harlow',
  'Onyx',
  'Sparrow',
  'Thorne',
  'Vesper',
  'Dusk',
  'Nova',
  'Reed',
  'Silas',
  'Wick',
  'Zephyr',
  'Cinder',
  'Moss',
  'Quinn',
  'Rowan',
  'Slate',
  'Storm',
  'Wolfe',
  'Yarrow',
  'Briggs',
  'Cade',
  'Doran',
];

const SURNAMES: readonly string[] = [
  'Voss',
  'Okafor',
  'Vance',
  'Rourke',
  'Sinclair',
  'Marsh',
  'Blackwood',
  'Cross',
  'Hollis',
  'Kestner',
  'Ashworth',
  'Draven',
  'Fairweather',
  'Grimm',
  'Hale',
  'Ironside',
  'Lowry',
  'Munro',
  'Nakamura',
  'Osei',
  'Petrov',
  'Quirke',
  'Rasmussen',
  'Stryker',
  'Tovar',
  'Underwood',
  'Ferro',
  'Kade',
  'Larkspur',
  'Mercer',
  'Nash',
  'Okonkwo',
  'Prescott',
  'Reyes',
  'Sharpe',
  'Tanaka',
  'Ulrich',
  'Varga',
  'Whitlock',
  'Zeller',
];

/**
 * Draws a unique `"First Last"` name from the pools above, retrying against `taken` (which the
 * caller both pre-populates with every existing account name and mutates with each name this
 * returns) until a free combination is found. Falls back to a numeric-suffixed variant only if
 * the entire 1600-combination pool is somehow exhausted — astronomically unlikely at seed scale,
 * but a bounded fallback keeps this function total rather than looping forever.
 */
export function generateNpcName(rng: NpcRng, taken: Set<string>): string {
  const maxAttempts = FIRST_NAMES.length * SURNAMES.length;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const first = FIRST_NAMES[Math.floor(rng() * FIRST_NAMES.length)]!;
    const last = SURNAMES[Math.floor(rng() * SURNAMES.length)]!;
    const candidate = `${first} ${last}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${FIRST_NAMES[0]} ${SURNAMES[0]} ${suffix}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}
