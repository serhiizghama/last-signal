// The world is a fixed 61×61 grid centred on the Signal Source at (0,0) (§14 of the M1
// design record, IMPLEMENTATION_PLAN.md's world table): both axes run -30..30 inclusive,
// which is exactly 61 integer positions per axis. Shared between `Settlement` (coordinate
// bounds on `x`/`y`) and the placement module (outer-ring geometry) so "61×61, centred at
// the origin" is defined exactly once rather than as two independently-drifting magic
// numbers.
export const GRID_RADIUS = 30;
export const GRID_MIN = -GRID_RADIUS;
export const GRID_MAX = GRID_RADIUS;
