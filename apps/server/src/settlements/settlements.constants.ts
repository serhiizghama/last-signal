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

// `GameEvent.type` for one chained unit-completion of a `trainUnits` order (M2b.2, §7):
// one pending event per active order, credits one unit and reschedules itself for the next
// unit unless the order is now fully delivered.
export const TRAINING_COMPLETE_EVENT_TYPE = 'trainingComplete';

// One active training order **per training building** (Barracks, Machine Shop, Command
// Center), not per settlement — M3's widening of M2b.2's per-settlement
// `MAX_ACTIVE_TRAINING_ORDERS = 1` (`docs/M3_DESIGN_DECISIONS.md` §2): a Barracks order and
// a Machine Shop order now run in parallel, but a second order at a training building that
// already has one running is still rejected with `errors.training.queueBusy`. Exactly the
// same constant-to-change shape `WAITING_QUEUE_SLOTS` gives the build queue — widening this
// further (e.g. two concurrent orders at one building) is a number to bump, not a rewrite.
// Cancelling a training order remains out of scope (M3 §2 reaffirms M2b.2's "no cancel for
// training") — there is deliberately no `cancelTraining` method/route anywhere in this
// module.
export const MAX_ACTIVE_ORDERS_PER_BUILDING = 1;

// Upper bound on a single `trainUnits` order's `count`. Generous enough that no real
// player hits it in normal play — even at the fastest scout's shortest training time, a
// batch this size represents many hours of queued, one-at-a-time completions — while still
// bounding how many chained `trainingComplete` events a single command can ultimately fan
// out into over the order's lifetime (one event alive at a time, but each completion
// reschedules the next, `count` times in total).
export const MAX_TRAIN_COUNT = 200;

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

// `GameEvent.type` for the hourly starvation tick (M3a.6, `docs/M3_DESIGN_DECISIONS.md`
// §4): scheduled lazily by `SettlementsService.settleDoc` the instant a settlement's net
// Food goes negative, at the exact instant stored Food is projected to hit zero. Fires every
// hour while net Food stays negative and stored Food is 0, killing the weakest troops first
// (`starvationOrder`, `game-core`) until net Food recovers or nothing is left to kill.
export const STARVATION_TICK_EVENT_TYPE = 'starvationTick';

// Tolerance for `SettlementsService.reconcileStarvationSchedule`'s "has the deadline actually
// moved" check (§4). Two settle calls against an *unperturbed* Food trajectory recompute the
// same absolute deadline up to `Math.ceil` rounding noise of a few milliseconds (`now`
// advances by the same amount the remaining-Food estimate shrinks by) — a real change (a
// command that spends or refunds Food, or changes troop upkeep) shifts the deadline by orders
// of magnitude more than this. Kept far under the hourly tick's own granularity, so it can
// never mask a genuine reschedule, purely to stop every single command against a starving
// settlement from cancel-and-rescheduling the identical tick out of pure numerical noise.
export const STARVATION_RESCHEDULE_EPSILON_MS = 1_000;

// Stored Food at/below this is treated as "empty" for `StarvationTickHandler`'s trigger
// re-check (§4: "stored Food is 0"). `settleResources` (`game-core`) already clamps stored
// values at `Math.max(0, ...)`, so this is belt-and-suspenders against float representation
// error rather than a real tolerance band — stored Food can never actually be a small
// negative number, only ever exactly 0 or positive.
export const STARVATION_FOOD_EMPTY_EPSILON = 1e-6;
