// DI token for the injected `GameConfig` (see `docs/M1_DESIGN_DECISIONS.md` §9: every
// game-core formula takes an injected config rather than reaching for a module-level
// constant). A token — not the concrete `GameConfig` type — because interfaces cannot be
// DI tokens, and this is also the seam a later per-round/archived-config lookup would
// replace `useValue: DEFAULT_CONFIG` with a `useFactory` behind, with zero call-site change.
export const GAME_CONFIG = Symbol('GAME_CONFIG');
