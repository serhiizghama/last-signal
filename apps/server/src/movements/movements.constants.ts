// `GameEvent.type` this feature schedules and handles (M2b.3, `docs/M2_DESIGN_DECISIONS.md`
// §6): a scout arriving at its target, and a scout (or the whole movement's survivors)
// returning home afterward.
export const MOVEMENT_ARRIVE_EVENT_TYPE = 'movementArrive';
export const MOVEMENT_RETURN_EVENT_TYPE = 'movementReturn';

// Bounded retry count for the version-guard command pattern (concurrency playbook), mirrors
// `MAX_COMMAND_ATTEMPTS` in `settlements.constants.ts` — kept as its own constant (not
// imported cross-module) so this feature's retry bound can move independently, the same way
// `settlements`' own bound is free to.
export const MAX_COMMAND_ATTEMPTS = 5;
