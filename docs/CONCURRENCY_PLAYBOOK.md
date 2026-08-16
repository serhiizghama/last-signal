# Concurrency playbook

Standalone reference for how "Last Signal" makes multi-step game commands safe under
concurrent requests, and how the event scheduler survives crashes and restarts. Written
from the shipped M1a.7 implementation (`apps/server/src/settlements/`,
`apps/server/src/scheduler/`) — every claim below cites the real file and function it
comes from. `docs/M1_DESIGN_DECISIONS.md` §11–§12 is the design intent this document was
commissioned to write up "as a standalone doc during M1a" (§11); this file is that doc.
Every later milestone that adds a new command (`trainTroops`, `sendMovement`, `trade`, …)
follows the recipe here verbatim.

## 1. Why transactions are not enough on their own

MongoDB 7 on a single-node replica set gives multi-document transactions, so a command
that touches more than one document (e.g. deduct resources *and* enqueue an event) commits
or rolls back atomically. That solves atomicity. It does **not** solve races between two
concurrent transactions on the *same* document:

Two `startBuild` calls for the same settlement can both start a transaction, both read the
settlement, both see "500 scrap available, this build costs 400" — and both decide the
build is affordable, because neither has committed yet and each transaction sees a
consistent snapshot from the moment it started. Without an extra guard, both would deduct
400 scrap independently and both `findOneAndUpdate` would succeed, leaving the settlement
at -300 scrap.

The fix is not the transaction — it's that every mutating write is a **version-guarded
`findOneAndUpdate`**: the filter requires the document's `version` to still equal the value
this transaction read at the start. Whichever transaction commits first bumps `version`;
the second transaction's `findOneAndUpdate` then matches zero documents (its expected
`version` is stale) and fails instead of silently overwriting. The transaction gives
atomicity of *this command's own writes*; the version guard is what makes two *different*
commands conflict instead of double-spending. See `SettlementsService.startBuild` in
`apps/server/src/settlements/settlements.service.ts:88-191`, and the write itself:

```ts
const updated = await this.settlementModel.findOneAndUpdate(
  { _id: settlementId, version: settled.version },
  {
    $set: { 'resources.values': newValues, version: settled.version + 1 },
    $push: { buildQueue: { id: queueItemId, type, targetLevel, cost, ... } },
  },
  { session, returnDocument: 'after' },
);
if (!updated) {
  throw new VersionConflictError();
}
```

`version` is an application-controlled `Number` field on `Settlement`
(`apps/server/src/schemas/settlement.schema.ts:118-121`), deliberately **not** Mongoose's
own `__v` (`versionKey: false` on the schema, `settlement.schema.ts:104-107`) — the two are
kept apart so nothing can confuse "Mongoose's document revision bookkeeping" with "this
app's optimistic-concurrency guard".

This is proven directly by an integration test, not just asserted in prose — see §6 below.

## 2. The command pattern

Every command that mutates a settlement (`startBuild`, `cancelBuild`, and every future one
— `trainTroops`, `sendMovement`, `trade`) follows the same recipe. Read
`SettlementsService.startBuild` and `.cancelBuild` in `settlements.service.ts` as the
reference implementations; `runCommand` (`settlements.service.ts:320-339`) is the shared
driver every command method is written against.

1. **Open a transaction.** `runCommand` calls `connection.startSession()` then
   `session.withTransaction(...)`; the command body runs entirely inside that callback.
2. **Settle resources first.** Before validating or touching anything else, call
   `settleSettlementDoc` (`settlements.service.ts:261-299`) to materialise lazy resource
   accrual up to `now`. Every command reads *settled* state, never a stale snapshot — see
   §3.
3. **Validate via `game-core`.** All game-rule checks — unknown building type, max level,
   prerequisites, queue capacity, the Food-starvation gate, storage caps, affordability —
   call into `@last-signal/game-core` (`calcBuildCost`, `canAfford`, `missingPrerequisites`,
   `wouldStarveSettlement`, `calcStorageCaps`, …), never reimplement game math in the
   service. Each failure throws a `BuildCommandError` with a stable i18n key + params
   (`settlements.errors.ts:24-33`), e.g. `errors.build.insufficientResources`. Nothing is
   written yet at this point, so a validation failure leaves the document untouched (the
   transaction has made no writes to roll back).
4. **Version-guarded update.** Build the update document, then call `findOneAndUpdate` with
   `{ _id, version: settled.version }` in the filter and `$set: { ..., version:
   settled.version + 1 }` in the update. If it returns `null`, throw `VersionConflictError`
   — a plain `Error`, not an `HttpException` (`settlements.errors.ts:37-43`), because it is
   caught internally by `runCommand`, never meant to reach an HTTP response directly.
5. **Schedule any event with the same session.** If the command needs a future event (a
   build completing), call `eventScheduler.scheduleEvent(input, session)` — the *same*
   `session` the command's own transaction is using
   (`settlements.service.ts:155-163`) — so "spend the resources" and "schedule the
   completion" commit or abort together. `EventSchedulerService.scheduleEvent`'s whole
   reason for taking an optional `session` parameter is this
   (`event-scheduler.service.ts:17-20`).
6. **Commit.** Falls out of `session.withTransaction` returning normally — no explicit
   commit call in the command body itself.
7. **Bounded retry on version conflict.** `runCommand` catches `VersionConflictError` and
   retries the *entire* command function — including its reads and validation, not just the
   final write — from scratch against fresh state, up to `MAX_COMMAND_ATTEMPTS` (5,
   `settlements.constants.ts`) times. Any other thrown error (a `BuildCommandError`, "not
   found") is not a race and propagates immediately, unretried
   (`settlements.service.ts:329-333`).
8. **Fail with an i18n error key.** If every retry is exhausted, `runCommand` throws
   `CommandConflictRetryExhaustedError` → `errors.command.conflictRetryExhausted`, HTTP 409
   (`settlements.errors.ts:46-51`). This is a real, if rare, client-visible outcome under
   heavy contention — it gets its own key rather than a generic 500.

Note there are **two** retry layers, not one, and they solve different problems
(`settlements.service.ts:314-319`):

- The MongoDB driver's own `session.withTransaction` retries `TransientTransactionError`s —
  a genuine storage-engine write conflict where two transactions physically collided on the
  same document mid-flight. This is handled *inside* `withTransaction`, transparently.
- `runCommand`'s own retry loop (step 7 above) handles the *logical* case: a
  `findOneAndUpdate` filtered on a specific `version` simply matching no document, which is
  not itself a transient/retryable driver error — from the driver's point of view that
  write just succeeded in touching zero documents.

A future `trainTroops`/`sendMovement`/`trade` command is written by copying this shape:
wrap the body in `runCommand`, settle first, validate with `game-core`, write via a
version-guarded `findOneAndUpdate`, schedule same-session, let `runCommand` retry
conflicts, and give every rejection a stable error key.

## 3. Resource settlement discipline

`Settlement.resources` is `{ values, lastCalcAt }`
(`settlement.schema.ts:53-59`) — resources accrue continuously between event ticks, and the
server never runs a background job to "tick" every settlement's resources on a timer.
Instead, every command's *first* step, before anything else, is to settle: compute
production/upkeep since `lastCalcAt` up to `now` and persist the result under the same
version guard as any other write.

```ts
// settleSettlementDoc, settlements.service.ts:261-299
const elapsedMs = now - doc.resources.lastCalcAt;
if (elapsedMs <= 0) {
  return doc; // nothing to persist — also avoids a pointless version bump
}
const settled = settleResources(this.config, buildings, { values, lastCalcAt }, now);
const updated = await this.settlementModel.findOneAndUpdate(
  { _id: settlementId, version: doc.version },
  { $set: { 'resources.values': settled.values, 'resources.lastCalcAt': settled.lastCalcAt, version: doc.version + 1 } },
  { session, returnDocument: 'after' },
);
```

This exists because the client must never see, or be able to act on, a resource number the
server would compute differently a moment later. If a command instead read `values` as
stored and only *computed* the accrual in memory for a comparison (without persisting it),
two problems follow: the persisted `lastCalcAt` would drift from reality, and a second
concurrent command reading the same raw document would redo the same lazy math from a
different `now`, producing two different "current" balances for the same instant — exactly
the kind of disagreement the version guard exists to prevent. Materialising the settle step
as a real write, gated by the same `version` field as every other mutation, keeps "what the
server just computed" and "what's on disk" the same document state a subsequent read (or a
racing command) will see.

`elapsedMs <= 0` is short-circuited to a no-op read (no write) — this is the case where two
commands land in the same millisecond, or a command re-enters after a retry with a `now`
that's no longer newer than the just-settled `lastCalcAt`. Skipping the write here is not
just an optimization: settling would otherwise cost a real version bump for zero
information gained, adding one more contention point for concurrent commands to conflict
over pointlessly.

## 4. Event processing

The scheduler (`apps/server/src/scheduler/scheduler.service.ts`) is a small in-process
polling loop, not a separate worker process. Each tick (`runOnce`,
`scheduler.service.ts:111-120`):

1. **Sweep expired leases** back to `due` (see below).
2. **Claim the next due event**, strictly in `dueAt` order, one at a time, until none
   remain.
3. **Dispatch** each claimed event: run its handler and mark it `done`, in one transaction.

**Claim before handling.** `claimNextDueEvent` (`scheduler.service.ts:141-148`) is a single
atomic `findOneAndUpdate({ status: 'due', dueAt: { $lte: now } }, { $set: { status:
'processing', processingStartedAt: now } }, { sort: { dueAt: 1 } })`. The match-and-update
happening as one atomic operation is what makes claiming safe under concurrency at all: an
event already `processing` no longer matches `status: 'due'`, so it can't be claimed twice,
even if a second scheduler process existed.

**Handler effects + `done` mark in one transaction.** `dispatch`
(`scheduler.service.ts:150-185`) opens a session, calls `handler.handle(event, session)`,
then marks the event `done` — both inside the same `session.withTransaction`. Either both
commit or both roll back; there is no state where a handler's effects are visible but the
event is still `processing` (or vice versa) after a successful commit.

**Handlers are idempotent and re-check state.** The `EventHandler` contract says so
explicitly (`event-handler.interface.ts:5-8`): "a crash between the worker's claim and its
transaction commit means the same event can be handed to `handle` more than once, so a
handler is expected to re-check state rather than blindly reapply effects." The shipped
`BuildCompleteHandler` (`apps/server/src/settlements/handlers/build-complete.handler.ts`)
does exactly this — it looks the queue item up by id and no-ops if it's already gone:

```ts
const itemIndex = doc.buildQueue.findIndex((i) => i.id === payload.queueItemId);
if (itemIndex === -1) {
  // Already applied (replay) or the build was cancelled in the meantime — no-op.
  return;
}
```

This is proven by an integration test that replays the same event twice and asserts the
building level only advances once (§6).

**Unknown type / unsupported `payloadVersion` → dead-lettered, not retried.**
`dispatch` checks both *before* opening any transaction (`scheduler.service.ts:150-163`):
no registered handler for `event.type`, or the handler doesn't list `event.payloadVersion`
in `supportedPayloadVersions`, goes straight to `failUndeliverable` →
`status: 'failed'`. Both conditions are structurally unfixable by retrying — retrying would
just loop forever — so there is no backoff step for them.

**A handler that throws gets bounded retry with backoff, then dead-letters.**
`recordFailure` (`scheduler.service.ts:201-225`): each failure increments `attempts`; below
`maxAttempts` (default 3, `DEFAULT_MAX_ATTEMPTS` in `scheduler.constants.ts`) the event goes
back to `due` with `dueAt = now + backoff`, where backoff is `pollIntervalMs * 2^(attempts
- 1)` capped at 30s (`computeBackoffMs`, `scheduler.service.ts:230-232`); at or past
`maxAttempts` it's marked `failed` instead.

**Lease + sweep for crash recovery.** Claiming sets `processingStartedAt`; if a worker dies
mid-handler, that event stays `processing` forever unless something notices. Every tick's
first step, `sweepExpiredLeases` (`scheduler.service.ts:125-134`), atomically returns any
`processing` event whose lease is older than `leaseTimeoutMs` (default 60s) back to `due`,
via `updateMany({ status: 'processing', processingStartedAt: { $lte: staleBefore } }, {
$set: { status: 'due' }, $unset: { processingStartedAt: '' } })` — preserving the original
`dueAt`, so a crash-recovered event doesn't jump the replay queue or get reordered.

**`dueAt`-order replay after downtime.** `claimNextDueEvent` always sorts by `dueAt: 1`
before claiming (`scheduler.service.ts:143-147`). A restart after the 1-second poll loop
was down for a while (a VPS restart mid-round) just means many events are simultaneously
due; the loop drains them one at a time, oldest `dueAt` first, with each one's *original*
scheduled time — not "now" — determining any onward scheduling (see
`BuildCompleteHandler`'s use of `event.dueAt`, not `Date.now()`, when promoting the next
queued build, `build-complete.handler.ts:96-110`). No collapsing, no fast-forwarding
multiple ticks into one.

## 5. What is NOT protected — handle per-feature

The version guard protects **one document at a time**. It does not give you:

- **Cross-settlement invariants.** Nothing in this playbook makes two settlements'
  documents update atomically as a pair beyond what a single multi-document transaction
  already gives you *within one command's own writes*. A trade between two settlements, or
  a raid that debits one settlement and credits another, has to open its own transaction
  and version-guard *both* documents' updates inside it — there's no cross-document version
  guard "for free". If both settlements need to see a consistent state relative to each
  other, that consistency is this future command's own responsibility to construct, the
  same way `startBuild` constructs it for one document.
- **Anything spanning two accounts** (a trade offer accepted concurrently by two different
  responses, an attack landing while the target is also acting) needs its own concurrency
  design — likely still "settle both sides first, version-guard both writes, single
  transaction" but there is no existing settlement-vs-settlement code to point to yet as of
  M1a. Design it against this playbook's shape, don't invent a new pattern.
- **Ordering across different settlements' events.** The scheduler processes events
  strictly in global `dueAt` order, not "per settlement" order — two events for two
  different settlements interleave in whatever order their `dueAt` values happen to fall
  in. That's fine for independent settlements but matters if a future feature needs strict
  ordering between events belonging to *different* settlements (e.g. an attack must be
  processed before the defender's next build tick) — that ordering isn't provided here and
  needs its own mechanism.
- **The event's own idempotency** is on the handler author, not the framework. The `done`
  mark commits atomically with the handler's writes, but "atomically" only guarantees they
  land together — it does not make the handler's *logic* idempotent for you. Every new
  handler must re-check state the way `BuildCompleteHandler` does (§4), or a replay after a
  crash will double-apply its effect.

## 6. How to test it

The concurrency test that actually exists — `settlements.integration.spec.ts`, `'the race:
two concurrent startBuild calls that can only afford one — exactly one succeeds, resources
never go negative'` (`apps/server/src/settlements/settlements.integration.spec.ts:486-510`):

```ts
const cost = calcBuildCost(config, type, 1);
const settlementId = await foodSafeSettlement({ ...cost, food: ABUNDANT_RESOURCES.food });

const [responseA, responseB] = await Promise.all([
  postBuild(settlementId, type),
  postBuild(settlementId, type),
]);

const statuses = [responseA.status, responseB.status].sort();
expect(statuses).toEqual([200, 400]);
const failure = responseA.status === 400 ? responseA : responseB;
expect(failure.body.error.key).toBe('errors.build.insufficientResources');

const state = await settlementModel.findById(settlementId);
for (const kind of ['scrap', 'fuel', 'electronics', 'food'] as const) {
  expect(state.resources.values[kind]).toBeGreaterThanOrEqual(0);
}
expect(state.buildQueue).toHaveLength(1);
```

It seeds a settlement with resources sufficient for **exactly one** copy of the build, then
fires two `startBuild` requests concurrently via `Promise.all`. It asserts: exactly one
succeeds (200) and one fails (400, with the affordability error key — not the version-guard
error, because `runCommand`'s retry means the loser sees fresh state and legitimately fails
`canAfford`, not a raw conflict); resources are never negative; the build queue has exactly
one entry. This is the property the whole playbook exists to guarantee, proven end to end
through the real HTTP API against a real `MongoMemoryReplSet`, not mocked.

Idempotent replay is proven the same file, `'idempotency: replaying the buildComplete
handler for the same event increments the level only once'`
(`settlements.integration.spec.ts:444-484`): it calls `buildCompleteHandler.handle(event,
session)` twice directly (bypassing the scheduler's claim step, since the property under
test is the handler's own idempotency, not the claim logic) and asserts the building level
only advances once and the queue item is only removed once.

**Writing the equivalent for a new command** (e.g. `trainTroops`): seed a settlement with
resources for exactly one unit of whatever's being trained, fire two concurrent requests
via `Promise.all`, assert exactly one 200 and one rejection with the command's own
insufficient-resources key, and assert the persisted resource values are never negative and
the resulting queue/state has exactly one entry — the same four assertions as the build
race test, against the new command's own endpoint and error key. For a handler, seed an
event, call the handler directly twice against two separate sessions/transactions the way
the idempotency test does, and assert the second call is a no-op against whatever the
handler's own state marker is (a queue item id disappearing, a status flag, etc.).

Scheduler crash-recovery behavior (lease sweep, backoff, dead-letter) has its own dedicated
suite, `apps/server/src/scheduler/scheduler.integration.spec.ts`, which simulates "time
passing" by writing timestamps directly into event documents rather than sleeping on the
wall clock — reuse that pattern rather than the `startBuild` race pattern when testing
scheduler mechanics rather than a specific command.
