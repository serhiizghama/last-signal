// DI token for the number of *parallel active* build slots a settlement has. Deliberately
// a parameter, not a hardcoded assumption: the Engineers faction (not implemented yet, no
// faction system exists) gets a second genuinely parallel active build as their identity
// bonus (§6 of the M1 design record). Every queue-capacity / promotion computation in this
// module reads this token rather than assuming 1, so wiring the faction bonus later is a
// per-settlement provider value, not a rewrite of the queue logic.
export const ACTIVE_BUILD_SLOTS = Symbol('ACTIVE_BUILD_SLOTS');

// Everyone gets one active build slot by default — the Engineers override lands with the
// faction system.
export const DEFAULT_ACTIVE_BUILD_SLOTS = 1;

// Fixed regardless of faction (§6): a two-slot waiting queue on top of however many active
// slots a settlement has.
export const WAITING_QUEUE_SLOTS = 2;

// `GameEvent.type` this feature schedules and handles.
export const BUILD_COMPLETE_EVENT_TYPE = 'buildComplete';

// Bounded retry count for the version-guard command pattern (concurrency playbook,
// `docs/M1_DESIGN_DECISIONS.md` §11): a command retries this many times on a version
// conflict before giving up with `errors.command.conflictRetryExhausted`.
export const MAX_COMMAND_ATTEMPTS = 5;

// Starting resource endowment for a brand-new settlement (Command Center L1, nothing else
// built). `game-core` does not define a canonical "starting stock" (there is no such field
// on `GameConfig` — verified against `packages/game-core/src/config/types.ts`), so this is
// a server-local, first-pass number, not something pulled from the catalogue. Deliberately
// matches both the existing dev-seeder's `DEFAULT_SEED_RESOURCES` and game-core's own
// internal balance-harness `STARTING_RESOURCES` (`packages/game-core/src/balance/
// referencePlayer.ts`) so all three stay in visible agreement rather than three
// independently-drifting "reasonable-sounding" numbers. See that harness constant's own
// comment for the reasoning (bootstraps the settlement past its otherwise-permanent
// zero-production deadlock) — and the M1b report's §5 finding: even with this stock, the
// settlement's net Food is already negative at creation, so the Greenhouse Farm is the only
// buildable first target regardless of starting resources.
export const STARTING_RESOURCES = { scrap: 500, fuel: 500, electronics: 500, food: 500 };

// Bounded retry count for `SettlementsService.createSettlement`'s placement-collision loop
// — see `MAX_PLACEMENT_ATTEMPTS` in `placement.constants.ts` for the reasoning; kept as the
// same value here so both bounds move together if that reasoning ever changes.
export const MAX_CREATE_SETTLEMENT_ATTEMPTS = 25;
