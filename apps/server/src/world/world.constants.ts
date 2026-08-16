// Fixed filter value for the one document `World` ever holds — see that schema's `key`
// field comment. Mirrors `PLACEMENT_COUNTER_KEY` in `placement/placement.constants.ts`: a
// feature-module constant, not a schema default, so both the write (`WorldService`'s
// `create`) and every read (`getWorld`, `bootstrap`'s existence check) stay in one place.
export const WORLD_SINGLETON_KEY = 'world';

// The round/act every fresh world bootstraps into. Round wipe/rollover — which would ever
// produce a round other than 1 here — is M5 (§2 of the M2 design record), out of scope for
// this module.
export const INITIAL_ROUND_NUMBER = 1;
export const INITIAL_ACT = 1;
