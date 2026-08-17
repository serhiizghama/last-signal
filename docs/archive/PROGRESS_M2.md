# Archived progress log — M2 (Map & movement)

Per-step detail for **M2**, moved here verbatim from `docs/PROGRESS.md` when the
milestone was reviewed and committed (`b947f7f`, `a9f246e`), per the format rule at the
top of that file. Nothing was edited on the way in — the condensed M2 summary that
replaced it lives in `docs/PROGRESS.md`. Earlier milestones: `PROGRESS_M0_M1.md`.

---

## Log — M2

<!-- Newest entries at the bottom. Per-step entries for M2 accumulate here. -->

### M2 design session ✅ (2026-08-16)

Two rounds of structured Q&A with the owner per `docs/M2_DESIGN_SESSION_PROMPT.md`,
producing **`docs/M2_DESIGN_DECISIONS.md` (RESOLVED, binding for M2)**. Headline
decisions: bounded map + Chebyshev metric; center-out expanding random spawn replacing
the outer ring; the Signal Source is **not** placed in M2 (dynamic balanced placement at
the Act 2 reveal, owned by M5); scouts are **trained** (scout-only slice of the training
system pulled into M2), full scout-vs-scout loss model from day one; map fully public;
scout is the **only** movement type (settle/trade/support → M3); ~135 real inert NPC
accounts seed the map; flat placeholder tiles (slicing stays M6); Influence display-only.
Travel-time contract (§0) pinned for `tools/sim`; M2a/M2b/M2c split with executable
acceptance criteria in §13; required plan edits listed in §15 (not yet applied).

### M2.0 — plan edits from the M2 record §15 ✅ (2026-08-16)

Applied by the orchestrator (documentation only, no code). `docs/IMPLEMENTATION_PLAN.md`
now matches the binding M2 record on all six required points: §2.5 spawn rewritten to the
unified center-out expanding-random policy (NPCs seeded through it first); §2.5 Source
replaced with "no location until the Act 2 reveal places it at a computed balanced point,
algorithm owned by M5" (and the intro line no longer says the Source sits at the map
centre); §2.5 gained "bounded grid, no wrap, Chebyshev metric" and seed-derived cosmetic
terrain with the toxic-lake exception; §2.6 gained the resolved scouting detail (1.5-power
loss curve, Radio Tower differential intel tiers, counter-report requires a scout at home,
failed missions still return an empty report); §5's M2 line dropped "Source placeholder"
and now reads world gen / map UI / scout-only movements / scout-only training / reports /
Influence display, with M3 gaining settler convoy + founding gate, Market, support, oasis
combat, incoming visibility, starvation and beginner protection; §1's Round row pins
`travel = 2`. Two consistency edits beyond the list: §3.2 collections gained `oases` and
the `world` singleton's `seed`, and M1's "deferred out of M1" line now routes Influence
*display* to M2 and founding/Market to M3.

**Baseline before any M2 code** (from a `pnpm clean` tree, this session):
`pnpm lint && pnpm typecheck && pnpm test && pnpm build` all green — 248 tests
(game-core 144, server 66, web 38), exit code 0, no warnings in stdout.

### M2a.1 — game-core: map geometry, terrain, travel & spawn formulas ✅ (2026-08-16)

New pure module `packages/game-core/src/map/` (M2 record §1–§3): `geometry.ts`
(`Tile`, `chebyshevDistance`, `isInGrid`), `rng.ts` (FNV-1a string hash + mulberry32 +
per-tile `tileRoll` — integer-only, platform-stable, no `Math.random`/clock), `terrain.ts`
(`TERRAIN_IDS`, `terrainAt(config, seed, x, y)`, `canTerrainHostSettlement`), `travel.ts`
(`travelTimeMs`, `slowestSpeed`), `spawn.ts` (`spawnRadius`, `spawnAnnulus`,
`pickSpawnTile` with injected rng + legality predicate, grows outward, returns `null`
rather than looping), `settleability.ts` (`isSettleable` — grid/lake/oasis/min-distance in
one place), `oases.ts` (`generateOases` — deterministic, bounded, returns fewer than the
target rather than hanging). `GameConfig` gained a `map` block (radius 30, terrain weights,
oases 24/≥5/margin 2, spawn 4 + 1.8·√n / band 6 / max 30, settlement min distance 3);
`configVersion` 2 → 3; `speed.travel` 2.5 → **2** per §0.

Files: `packages/game-core/src/map/*` (7 sources + 7 specs, new),
`config/types.ts`, `config/defaultConfig.ts`, `src/index.ts`.

**Verification (run by the orchestrator, not taken from the subagent's report):**
`pnpm clean` then `pnpm lint` (no issues) → `pnpm typecheck` (clean) → `pnpm format:check`
(clean) → `pnpm test`: game-core **215 passed** (was 144, +71), server **66 passed**
(unchanged), web **38 passed** (unchanged); `pnpm build` green. Tests lock the §0 contract
table (15 rows, ±1 min) and its three bounds, terrain determinism + distribution, spawn
monotonicity/`R(135)=25`, oasis constraints and both bounded-termination cases.
Two extra probes run directly against the built package: terrain distribution and oasis
generation across six different seeds (deviation < 1 pp, 24 oases every time), and a
150-settlement placement simulation through `pickSpawnTile` + `isSettleable` — all 150
placed, zero failures, minimum pairwise Chebyshev distance exactly 3, outer radius ~22–26.
That last probe was the real risk in this step (135 NPCs at min-distance 3 could have been
geometrically infeasible); it is not.

*Process note:* the subagent finished its edits but its final report never arrived. Per the
M0 lesson ("a silent subagent is not necessarily a failed one") no replacement was
dispatched — the work was verified directly instead, and the agent was told to stand down
before the next step touched the same files.

### M2a.2 — game-core: scout unit catalogue, training formulas, troop Food upkeep ✅ (2026-08-16)

New pure module `packages/game-core/src/units/` (M2 record §7): `catalogue.ts` (`UNITS` —
the three faction scouts, draft numbers verbatim from §7), `training.ts` (`unitsForFaction`,
`scoutUnitForFaction`, `calcTrainCost`, `calcTrainTimeMs`, `calcTrainBatchTimeMs`),
`troops.ts` (`TroopCounts`, `calcTroopFoodUpkeepPerHour`, `slowestTroopSpeed`,
`calcTroopScoutAttack/Defense`). `GameConfig` gained `units` plus shared `FACTIONS`/`Faction`
ids (game-core stays display-free — ids only); `configVersion` 3 → 4.

Troop upkeep now enters the economy as an **additive, optional trailing parameter**
defaulting to "no troops": `calcNetFoodPerHour`, `calcNetRates`, `settleResources`,
`msUntilFull/Empty/Affordable` and `wouldStarveSettlement` all accept `troops`, and the new
`wouldStarveWithTroops(config, buildings, troops, addedTroops)` implements §7's training
gate (absolute, whole batch included). Deliberately optional so no existing call site broke;
**the server and client must pass the real troop list once `settlements.troops` exists** —
M2b's acceptance criterion ("training a scout makes Food upkeep visibly drop") is what
proves that wiring actually happened.

**Verification (run by the orchestrator):** `pnpm clean` then lint (no issues), typecheck
(clean), `format:check` (clean), `pnpm test`: game-core **254 passed** (was 215, +39),
server **66** and web **38** unchanged; `pnpm build` green. Probed the built package
directly: `configVersion` 4, train times 240000 / 260000 / 320000 ms (= 1200/1300/1600 s ÷
`speed.training` 5), batch cost scaling, net Food dropping by exactly the troop upkeep, and
the training gate rejecting/accepting correctly.

*Known sharp edge (for M2b):* `slowestTroopSpeed` reads every entry's unit type regardless
of its `count`, so a `{count: 0}` entry would still influence the result. The command layer
must reject/strip zero counts (§6 already requires counts ≥ 1) rather than relying on the
formula to ignore them.

### M2a.3 — server: world bootstrap (seed) + the `oases` collection ✅ (2026-08-16)

New `apps/server/src/world/` module (M2 record §2, §12). `World` gained a `seed` and a
`key` field with a **unique index** — that index is what makes the singleton a singleton at
the database level and makes two concurrent bootstraps safe: at most one `create` wins, the
loser's duplicate-key error is treated as "someone else already bootstrapped" and reads the
winner back instead of throwing. New `Oasis` schema (`oases` collection, `{x, y, type}`,
grid-bounded coordinates, unique `{x, y}`, `type` an enum with the single v1 value `farm` so
M3 can widen it without a migration). `WorldService`: `bootstrap(now)` (idempotent; creates
the world document **and** its `generateOases(config, seed)` oases in one transaction so the
two can never disagree), `getWorld()`, `listOases()`, `regenerate(seed?, now)`, plus
`onModuleInit` so a fresh boot against an empty DB self-heals. Dev-only
`POST /api/dev/world/regenerate` (optional `{seed}`), 404 in production exactly like
`DevSeedController`; documented as never touching accounts/settlements. Terrain is still
never stored — only the seed is.

Files: `apps/server/src/world/{world.service,world.module,world.constants,world-dev.controller,world-regenerate.dto,world.integration.spec}.ts` (new),
`schemas/oasis.schema.ts` (new), `schemas/world.schema.ts`, `schemas/index.ts`,
`database/database.module.ts`, `app.module.ts`, `README.md`.

**Verification (run by the orchestrator):** lint / typecheck / format:check clean;
`pnpm test`: server **71 passed** (was 66, +5), game-core **254** and web **38** unchanged;
`pnpm clean && pnpm build` green, no warnings in stdout. The new spec covers all five
required properties, including the concurrent-bootstrap race (`Promise.all`) and the
production 404. Runtime smoke against the real Docker Mongo is deferred to M2a.6, where
`GET /api/map` makes the bootstrapped world observable over HTTP.

### M2a.4 — server: center-out spawn policy replaces M1b's outer ring ✅ (2026-08-16)

`PlacementService` was rewritten around `game-core` (M2 record §3): `findTile()` reads the
world seed, every existing settlement's coordinates and every oasis tile **once per call**,
then delegates entirely to `pickSpawnTile` + `isSettleable` + `terrainAt`. No placement rule
is reimplemented server-side. The random source is a DI token (`PLACEMENT_RNG`, bound to
`Math.random` in production) so tests can force a specific candidate — without that seam the
duplicate-key retry path could not be exercised deterministically. `createSettlement` keeps
its shape (bounded loop, one transaction per attempt, unique `{x, y}` index as final
authority) but draws a fresh candidate per attempt.

Deleted as dead: `placement.geometry.ts` (+ spec), `placement.constants.ts`,
`schemas/placement-counter.schema.ts` and its registrations — the counter-seeded stride walk
has no role under a random policy. Grepped: no live references remain (one stale comment
pointer in `world.schema.ts` fixed by the orchestrator).

**Verification (run by the orchestrator):** lint / typecheck / format:check clean;
`pnpm test`: server **65 passed** (71 − the 7 deleted outer-ring geometry tests + 1 net new
— reconciles exactly, nothing silently lost), game-core **254** and web **38** unchanged;
`pnpm clean && pnpm build` clean, zero warnings. New coverage: a property test creating **30
settlements through the real API** (all on-grid, none on a toxic-lake or oasis tile, all
pairwise Chebyshev ≥ 3, each inside the spawn annulus for the count at its creation — the
M2a acceptance criterion), and a forced-collision test that makes two *concurrent* creates
draw the identical candidate via the injected RNG, proving the unique-index tie-break and
the loser's retry onto a distinct tile. That test's determinism holds because `pickSpawnTile`
is synchronous, so each concurrent call consumes its two rng draws atomically.

### M2a.5 — server: ~135 inert NPC accounts seeded at world start ✅ (2026-08-16)

New `apps/server/src/npc/` module (M2 record §4). `NpcSeederService.seedIfNeeded(now)` seeds
`WORLD_NPC_COUNT` (default **135**) real `accounts` + `settlements` documents through the
same center-out placement policy humans use — `pickSpawnTile` / `isSettleable` / `terrainAt`
from `game-core`, fed an **in-memory tile accumulator** (seeded from whatever settlements
already exist) so the whole batch is computed before any write and persisted with two bulk
inserts. No behaviour, no ticks, no `npcState`: M4 switches them on without touching their
data. `npc-generator.ts` is pure and DB-free (bands, buildings, troops, resources, tile,
name); `npc-names.ts` generates unique human-plausible survivor names — nothing reads as
"NPC #37", since NPCs must be indistinguishable in-game.

Bands per §4 (40/40/20): *young* CC 1–2 / resource 1–3 / no troops, *developed* CC 3–5 /
resource 4–7 / Barracks / 0–3 scouts, *veteran* CC 5–7 / resource 6–9 / Barracks / 2–6
scouts; factions and sides uniform; resources at 50 % of each settlement's own storage caps;
scouts are always that faction's own scout unit. Building legality is enforced through
`missingPrerequisites`, not by hand — which is why the *young* band simply has no Electronics
Workshop (it needs CC 3).

Schema: `Settlement.troops: [{unitType, count}]` (home troops; stationing is M3 — nothing
writes it yet, M2b does), and `Account.isNpc` — the marker the seeder needs for idempotency
and M4 needs for ticking. It is never exposed in any client-facing view.

**Idempotency & race safety:** the world document gained `npcsSeededAt`; seeding is claimed
by an atomic `findOneAndUpdate({key, npcsSeededAt: null}, {$set: {npcsSeededAt: now}})`
**inside the same transaction as the bulk inserts** — so a claim can never commit without its
NPCs (which would otherwise wedge the world as "seeded" with nothing to show). `regenerate`
deletes the previously-seeded NPC accounts/settlements and resets the marker, leaving human
accounts untouched.

**Test-environment control:** `WORLD_NPC_COUNT` (via `ConfigService`, documented in
`.env.example`); all six pre-existing `AppModule` integration specs set it to `0` in their
`beforeAll` so their exact settlement-count and annulus assertions stay valid.

**Verification (run by the orchestrator):** lint / typecheck / format:check clean;
`pnpm test`: server **74 passed** (was 65, +9), game-core **254** and web **38** unchanged;
`pnpm clean && pnpm build` clean, no warnings. Measured full-scale seed: **44 ms** for 135
NPCs. Independent probe of my own: every band is net-Food-**positive** even in its
worst-case level combination (young +25.9/h, developed +66.4/h, veteran +130.2/h), so no
seeded NPC starts in a starving state — worth knowing before M3 turns starvation on.

*Process lesson (new, mine not the subagent's):* I ran the full gate while this subagent was
still mid-edit and hit a single transient failure in `settlements.integration.spec.ts >
queue limit` ("expected 403 to be 200"). It did not reproduce in six subsequent full-suite
runs or three isolated runs of that spec, and no server code path returns 403 (no guard
returns false, nothing throws `ForbiddenException`) — the plausible cause is my run racing
the subagent's in-flight edits and its concurrent `tsup` rebuild, which wipes `dist/`
mid-run. **Do not run the verification gate until the subagent has confirmed it stood
down** — the standing "never dispatch onto files another agent may hold" lesson applies to
the orchestrator's own commands too.

### M2a.6 — server: `GET /api/map` ✅ (2026-08-16)

New `apps/server/src/map/` module (M2 record §5): one response carrying the world header
(`seed`, `roundNumber`, `act`, `serverTime`), every settlement's **public fields only**
(`id`, `x`, `y`, `name`, `ownerAccountId`, `ownerName`, `ownerFaction`, `ownerSide`) and
every oasis (`x`, `y`, `type`). No terrain in the payload at all — the client derives it from
the seed via `terrainAt`. Owner data is resolved as two queries joined in memory (not an
N+1, not an aggregation) — justified in a comment against the ~150-document scale. Guarded by
`AuthGuard`, with a comment spelling out that "public" means *public between players*, not
anonymous. `world.source` is deliberately **omitted** rather than shipped as a permanently
`null` field, leaving M5 free to design its real shape.

**Verification (run by the orchestrator):** lint / typecheck clean, Prettier clean across
every in-scope file, `pnpm test`: server **80 passed** (was 74, +6), game-core **254** and
web **38** unchanged, `pnpm clean && pnpm build` clean. The new spec asserts the leak
guard on the **serialized JSON**, not just the typed object.

## ✅ M2a — World, spawn & map data: COMPLETE (awaiting owner review/commit)

Acceptance criteria from the M2 record §13, verified end to end against the **real Docker
Mongo over real HTTP** (a throwaway `last-signal-m2a-smoke` database, dropped afterwards —
the owner's `last-signal` dev database was never touched):

| Criterion | Result |
|---|---|
| Server bootstraps a world on an empty DB | ✅ world created with seed `f6020c5a…`, round 1, act 1 |
| `GET /api/map` returns ~135 NPC settlements and ~24 oases | ✅ exactly 135 settlements + 24 oases, 26 KB payload |
| No settlement on a lake or on an oasis | ✅ checked for all 136 settlements against `terrainAt` + the oasis list |
| All pairwise settlement distances ≥ 3 | ✅ global minimum pairwise Chebyshev distance = 3 |
| Terrain identical across two derivations from one seed | ✅ unit-tested in `game-core` (plus 6-seed distribution probe) |
| A newly registered account lands inside the current spawn annulus | ✅ registered through the real API → tile (5, −24), radius 24, annulus [19, 25] at n=135 |

Also smoke-verified: **restarting the server does not re-bootstrap or re-seed** — same seed,
same 136 settlements, same 24 oases after a full restart against the same database.

Final gate for M2a: **372 tests** (game-core 254, server 80, web 38), lint / typecheck /
build clean from a `pnpm clean` tree. Prettier is clean for every file in the project's own
scope; `pnpm format:check` does currently fail on `apps/web/public/_preview.html`, an
untracked file the owner created outside this work — left untouched deliberately, but it
will need formatting (or a Prettier ignore entry) before it is committed, or CI will fail.

---

## Log — M2b (scouts, movement & reports — server)

### M2b.1 — game-core: scouting resolution (loss curve + intel tiers) ✅ (2026-08-16)

New pure module `packages/game-core/src/scouting/` (M2 record §8): `combat.ts`
(`resolveScoutCombat` — `atkPts`/`defPts`, `lossFraction = min(1, (defPts/atkPts) ** config
exponent)`, per-unit-type losses/survivors, defenders never take losses), `intel.ts`
(`resolveIntelTier` on the Radio Tower differential, `tierIncludesBuildings`,
`isScoutDetected`), `resolve.ts` (`resolveScouting` — the single arrival entry point
returning combat + a **typed** `none | base | buildings` intel union + `detected`).
Display-free: ids and numbers only. Config gained `scouting: { lossExponent: 1.5,
buildingsTierMinDiff: 1 }`; `configVersion` 4 → 5.

**Orchestrator-required fix, applied before acceptance:** `isScoutDetected` originally
returned true for any troop entry with `count > 0`. The rule is "≥ 1 **scout** at home" —
identical today (every catalogued unit is a scout) but a latent, silently-compiling bug the
moment M3 adds 12 non-scout units to the same list. It now takes `config` and filters on
`role === 'scout'`, with a fixture-config test proving a non-scout-only defender is not
detected.

**Verification (run by the orchestrator):** lint / typecheck clean, Prettier clean on every
in-scope file, `pnpm test`: game-core **278 passed** (was 254, +24), server **80** and web
**38** unchanged, clean-tree build clean. I re-derived both hand-computed cases
independently: 5 Falconers (225 atk) vs 2 Falconers (80 def) → 0.355556^1.5 = 0.212012 →
round(1.06) = 1 lost, 4 survive; 4 Lookouts (140) vs 3 Falconers (120) → 0.857143^1.5 =
0.793560 → round(3.174) = 3 lost, 1 survives. The half-way rounding case is explicit about
relying on JS `Math.round` rounding .5 up.

### M2b.2 — server: `trainScouts`, chained completion events, troop upkeep wired ✅ (2026-08-16)

`POST /api/settlements/:id/train` `{unitType, count}` following the concurrency playbook
verbatim: settle → validate → deduct the whole batch **at enqueue** → version-guarded write
→ schedule the first `trainingComplete` in the same session. `Settlement.trainingQueue`
carries `{id, unitType, totalCount, remainingCount, unitTrainTimeMs, startedAt,
nextCompletesAt, cost, eventId}`. `TrainingCompleteHandler` credits **one** unit at a time
and chains the next event off `event.dueAt` (never `Date.now()`, so replay after downtime
resolves in game time).

**Idempotency guard (the interesting part):** unlike builds, the queue item *outlives*
several events, so "item still exists → apply" would double-credit a replay. The event
payload carries `remainingCountAtSchedule`, and the handler no-ops unless the persisted
order still shows exactly that count.

**Troop Food upkeep is now wired end to end** — the M2a.2 hook is closed on both sides:
server `settleSettlementDoc` (`settleResources`), the build gate (`wouldStarveSettlement`)
and the state view (`calcNetRates`/`calcNetFoodPerHour`); client `useLiveResources`
(`settleResources`), `ResourceBar` (`msUntilFull`) and `buildEligibility`
(`wouldStarveSettlement`, `msUntilAffordable`) via a new `toTroopCounts` selector mirroring
the server's own. The client half was **not** in the original brief — I required it before
accepting, because a player with scouts would otherwise have watched the browser tick Food
faster than the server computes it, which is precisely the drift `game-core` exists to
prevent.

**Orchestrator decisions recorded** (technical, the design record is silent on them):
**one active training order per settlement** (second order → `errors.training.queueBusy`;
M3 may widen it), **no cancel for training** (the record defines cancel for builds only),
training requires a faction (a never-registered guest is rejected rather than defaulted),
and a player may train only their own faction's scout. All four are behind named constants
or explicit checks with comments saying so.

**Verification (run by the orchestrator):** lint / typecheck clean, full suite green —
server **92** (was 80, +12), web **39** (was 38, +1), game-core **278** unchanged;
clean-tree build clean, zero warnings. Server coverage includes the M2b acceptance
criterion ("units credited one at a time, Food upkeep drops"), the Food gate on the whole
batch, six validation cases, the one-active-order rule, handler replay idempotency, the
playbook race test, and ownership 404. The web test derives its expectation from
`settleResources`/`wouldStarveSettlement` and fails without the client fix.

### M2b.3 — server: scout movements (send/cancel/arrive/return) + reports written ✅ (2026-08-16)

New `apps/server/src/movements/` module and two collections (`movements`, `reports`),
implementing M2 record §6 and §8. `POST /api/movements` (scout only), `POST
/api/movements/:id/cancel` (90 s window, config), `GET /api/movements/mine`. Travel time is
`travelTimeMs` over Chebyshev distance at the **slowest** unit's speed; departure is
immediate; units are deducted from home `troops` under a version guard and the
`movementArrive` event is scheduled in the same transaction.

`MovementArriveHandler` settles the **defender's** resources inside its own transaction (so
the intel snapshot is exact), calls `game-core`'s `resolveScouting`, writes the attacker's
`scout`/`scoutFailed` report and — iff detected — the defender's `scoutDetected`
counter-report, then either flips to `returning` with survivors + schedules
`movementReturn`, or ends the movement `done` when nobody survived.
`MovementReturnHandler` credits survivors home. Both are idempotent on the movement's own
`status`. `computeReturnAt(departAt, turnAroundAt)` is shared by cancel and arrival so the
round-trip rule cannot drift. The §6 "target missing at arrival" edge case is handled with
its own `targetNotFound` report.

**The settle seam** (the one risky refactor here): `settleDoc` is now the single
ownership-free settle implementation, with two entry points on top — `settleSettlementDoc`
(unchanged, ownership-checked, used by every player-facing command) and
`settleSettlementDocUnchecked` (used only by the arrival handler, which has no "calling
account" to check against). No ownership check was weakened and there is no duplicated
settle logic.

Config gained `movement.cancelWindowMs` (90 000, draft); `configVersion` 5 → 6.

**Verification (run by the orchestrator):** lint / typecheck clean, Prettier clean,
`pnpm test`: server **112 passed** (was 92, +20), game-core **280** (was 278, +2), web
**39** unchanged; clean-tree build clean, zero warnings. Coverage includes the M2b
acceptance path end to end (send → arrive → return, base-tier intel with **no** building
list at tower diff 0, defender counter-report, survivors credited home), the buildings tier
at diff ≥ 1, the undetected case, the total-wipe case, cancel inside/outside the window and
by the wrong account, replay idempotency for **both** handlers, the playbook race on the
last scout, nine validation cases and own-movements-only visibility. I re-derived the fixed
combat case by hand: 2 Falconers (90 atk) vs 2 Lookouts (40 def) → (40/90)^1.5 = 0.29630 →
round(0.5926) = 1 lost, 1 survives — matches the test.

### M2b.4 — server: reports API + the WebSocket gateway ✅ (2026-08-16)

New `apps/server/src/reports/` (`GET /api/reports` — newest-first, **seek/cursor**
pagination on a `(createdAt, _id)` pair over the `{accountId, createdAt: -1, _id: -1}`
index, with the unread count; `GET /api/reports/:id` — ownership-checked 404-not-403,
**marks read on open**) and `apps/server/src/realtime/` (socket.io gateway on path `/ws`,
in-process, CORS from the same `parseCorsOrigins` helper as the REST API). Dependencies
added: `@nestjs/websockets`, `@nestjs/platform-socket.io`, `socket.io` (+ `socket.io-client`
as a dev dependency for the tests) — all sanctioned by plan §3.4, nothing else.

**WS auth:** socket.io *middleware* (`server.use`), so a rejected socket never connects at
all rather than connecting and being kicked; the only credential is the same session cookie
`AuthGuard` resolves, through the same `AuthService`. Each connection joins a per-account
room, so a push reaches every tab.

**The push-after-commit problem, solved properly.** Reports are written inside the
scheduler's transaction, so emitting from the arrival handler could tell a client to fetch a
report that is not yet visible — or that never commits. The chosen solution is a **MongoDB
change stream** on `reports`: Mongo only delivers change events once the write is committed
and visible, so "received `reportArrived`" implies "a plain read can already see it" **by
construction**. It also keeps `movements/**` entirely unaware that socket.io exists.
*Known operational debt:* a non-resumable change-stream error logs and stops the stream —
pushes then stop until a restart. Acceptable for M2 (the client refetches anyway); worth a
supervisor/restart strategy before M7.

**Verification (run by the orchestrator):** lint / typecheck clean, `pnpm test`: server
**123 passed** (was 112, +11), game-core **280** and web **39** unchanged; clean-tree build
clean; `pnpm install --frozen-lockfile` reproduces with **zero** warnings (no ignored build
scripts, no peer-dependency complaints). Coverage includes 3-page cursor pagination with no
gaps/duplicates, cross-account leak checks, read-on-open idempotency, 401/404 conventions,
four handshake-auth cases, multi-tab delivery, and the commit-ordering guarantee (on
`reportArrived`, immediately fetch the report and assert it exists).

## ✅ M2b — Scouts, movement & reports (server): COMPLETE (awaiting owner review/commit)

The M2 record §13 acceptance criterion for M2b, verified **over the real HTTP API against
real Docker Mongo with the real scheduler running** (throwaway `last-signal-m2b-smoke`
database, dropped afterwards; the owner's dev database untouched). The integration suite
deliberately stubs the scheduler out (`SCHEDULER_ENABLED=false`), so this smoke is what
proves the live event loop:

| Criterion | Result |
|---|---|
| Train a scout; the completion event fires | ✅ real scheduler credited the unit 260 s after enqueue (1300 s ÷ `speed.training` 5); the training queue emptied itself |
| Food upkeep visibly drops | ✅ net Food 426.5036 → 425.5036/h — exactly the falconer's 1/h upkeep |
| Scout an NPC and lose what the formula says | ✅ 3 Falconers (135 atk) vs 2 Surveyor Drones (70 def) → (70/135)^1.5 = 0.37338 → 1 lost, 2 survived; movement flipped to `returning` with exactly those survivors |
| The report contains exactly the base-tier intel | ✅ target resources + storage caps + home troop counts, **no** building list (Radio Tower diff 0) |
| The NPC account has a counter-report | ✅ exactly one `scoutDetected`, naming the attacking settlement and owner; the NPC's own scouts untouched (defenders never die) |
| Survivors come home | ✅ return event fired on schedule, movement `done`, 2 falconers back in `troops`, net Food back to 426.5036/h |
| Realtime | ✅ a real socket.io client authenticated by the session cookie received `reportArrived` at the arrival instant, and the pushed report was immediately fetchable |

Replay idempotency (both handlers), the playbook race on the last scout, cancel inside and
outside the 90 s window, the undetected and total-wipe cases and every validation rejection
are covered by the integration suite rather than the smoke.

Final gate for M2b: **442 tests** (game-core 280, server 123, web 39), lint / typecheck /
build clean from a `pnpm clean` tree, `--frozen-lockfile` install clean.

**Deferred out of M2b, deliberately:** no cancel for training orders (the record defines
cancel for builds only), no incoming-movement visibility (M3 by §8), no beginner protection
(M3), no oasis scouting (M3).

---

## Log — M2c (map & reports UI)

### M2c.1 — web: screen navigation + the Map tab ✅ (2026-08-16)

New `apps/web/src/map/`: `mapGeometry.ts` (pure, unit-tested — `computeVisibleTileRange`,
`ZOOM_STEPS` 0.5×/1×/2×, `clampCenter`, drag→pan conversion), `MapScreen` with
`MapGrid`/`MapTile`/`MapMarkers`, `terrainPalette.ts`, `useMapQuery` (TanStack Query against
`GET /api/map`), `useElementSize`. The bottom nav now actually switches Base ↔ Map (local
state, **no router dependency added**); Reports stays disabled until its step. Terrain is
derived client-side via `terrainAt(config, world.seed, x, y)` — the payload carries none.
Flat palette-coloured placeholder tiles per §11 (real art slicing stays M6), markers tinted
by faction/side with a distinct own-settlement marker, oasis markers, jump-to-coordinates,
recentre, and 3 zoom steps with drag + pinch pan clamped at the grid edge.

**Orchestrator-required fix, applied before acceptance:** with a settlement near the east
edge the out-of-grid region rendered as a flat black rectangle, which reads as "the map
failed to render" rather than "this is the edge of the world". Since the bounded map is a
deliberate design decision (§1: the wasteland having an *edge* is thematically right), the
void now gets a hatched treatment plus a rust boundary line, asserted by its own test.

**Verification (run by the orchestrator):** lint / typecheck clean, `pnpm test`: web **71
passed** (was 39, +32), game-core **280** and server **123** unchanged; clean-tree build
clean. Beyond the suite, I drove the **real app in Chrome** at a phone-width column against
a live server seeded with 135 NPCs: culling holds (**266** tile elements in a 448×480
viewport — the 61×61 grid's 3 721 tiles are never all mounted), markers carry faction/side
classes and proper labels ("Ваше поселение", "Поселение «…»", "Оазис"), the controls work,
and the browser console is clean of errors.

**Owner decision needed (flagged, not invented):** the NPC name generator produces
Latin-script names ("Wolfe Reyes", "Rust Osei") next to an all-Cyrillic UI. Nothing in the
design record specifies the language of NPC names. Left as-is pending the owner's call.

### M2c.2 — web: tile info sheet, send-scout flow, movements overlay ✅ (2026-08-16)

`TileInfoSheet` (bottom sheet, `role="dialog"` + `aria-modal`, focus moves to close,
Escape and backdrop close it) branching on four tile kinds via the pure `classifyTile`:
empty, oasis (public card, no scout action — §8), another player's settlement (public fields
+ scout action), own settlement (no scout action). `scoutEligibility.ts` mirrors
`buildEligibility`'s "disabled control + explicit reason" shape, so "no scouts at home" and
"this target cannot be scouted" read differently. `ScoutForm` picks a count bounded by
scouts actually at home and previews travel time from `travelTimeMs(config,
chebyshevDistance(...), slowestTroopSpeed(...))`. `MovementsOverlay` lists the caller's own
movements with live countdowns against the server clock, outbound vs returning, and a cancel
button only inside `config.movement.cancelWindowMs`.

**Verification (run by the orchestrator):** lint / typecheck clean, `pnpm test`: web **83
passed** (was 71, +12), game-core **280** and server **123** unchanged. In the **real
browser** against a live server: tapping an NPC settlement opened the sheet (18:22, owner,
faction, side), the picker showed "Доступно дома: 3" and a preview of **10:36** — which I
re-derived by hand (Chebyshev 6 from (24,21) to (18,22); falconer speed 17 × `SPEED.travel`
2 = 34 tiles/h → 6/34 h = 10 min 35.3 s → ceil 10:36); sending created the movement and the
overlay showed «В ПУТИ · Цель: 18:22 · Прибытие через 10:36 · Сокольничий ×3 · ОТМЕНИТЬ
ПОХОД»; ~100 s later the countdown read 08:43 and the cancel affordance had correctly
disappeared with the 90 s window.

*Known debt (recorded, not fixed):* tile selection is pointer-only — there is no keyboard
path to *open* a tile's sheet (the sheet itself is fully keyboard-operable). Wiring
"jump to coordinates" to also select that tile would close this cheaply.

### M2c.3 — web: the Reports tab and live WebSocket updates ✅ (2026-08-16)

New `apps/web/src/reports/` (list with unread state and cursor "load more", detail view,
one body component per report type, `reportPayload.ts` turning the server's structured
ids/numbers into RU prose through i18n — M1 §15's "the server ships keys/ids, the client
renders prose") and `apps/web/src/realtime/` (a single shared socket.io client on `/ws`
invalidating the reports queries on `reportArrived`). The Reports tab activates with an
unread badge; Vite's dev proxy gained a `/ws` entry with `ws: true`, without which the
handshake never reaches the API server in development. `socket.io-client` added to
`apps/web`, matching the server's `socket.io` major.

**Verification (run by the orchestrator):** lint / typecheck clean, `pnpm test`: web **97
passed** (was 83, +14), game-core **280** and server **123** unchanged;
`pnpm install --frozen-lockfile` clean. In the **real browser** against the live server, the
report produced by my earlier scouting run rendered end to end: the nav badge read «Отчёты
1», the list showed «Разведка · Цель: 18:22 · НОВЫЙ», and the detail read «Отправлено:
Сокольничий ×3 / Вернулось: ×3 / Потери: ×0», the target's four resources against their
caps, «Войск не обнаружено», and — the tier message I specifically wanted to see —
«Радиовышка слишком слаба, чтобы разведать постройки» rather than an empty building list.
Opening it dropped the badge to «Отчёты», so read-on-open works against the real API.

*Note on a scare that was not a bug:* mid-check the UI sat on «Загрузка…» for a while. It
was the local Mongo container's connection pool recovering from a `server monitor timeout`
under load (the scheduler logged the error each tick and kept running — the resilience
working as designed); once the pool recovered the app loaded normally and every endpoint
answered in ~50 ms.

### M2c.4 — web: scout training on the Barracks card + the Influence panel ✅ (2026-08-17)

`TrainingSection.tsx` on the Barracks card (count picker, batch cost/time from
`calcTrainCost`/`calcTrainTimeMs`/`calcTrainBatchTimeMs`, home-troop list, live countdown to
the next unit, **no cancel** — §7 defines none), `trainEligibility.ts` mirroring
`buildEligibility`'s disabled-with-a-reason shape for all five gates (no Barracks, no
faction, order already running, would-starve via `wouldStarveWithTroops`, unaffordable
against *live* resources), `InfluencePanel.tsx` (§9, display-only — no founding action) and
a shared `CostList.tsx`.

**Defect found by the orchestrator in the live acceptance run, and fixed:** the training
countdown **froze at «Следующий через: 00:00»** forever — the unit was credited server-side
on schedule, but the client never refetched, so the player was left staring at a finished
order. `BuildQueueList` had solved this long ago (grace period past zero, refetch, bounded
retry — the scheduler polls once a second, so a completion can land ~1s late); the training
section had the countdown and none of that. This is the project's own standing lesson —
*test time-driven UI at the boundary, not just the slope* — reproducing exactly. The fix
**extracted the pattern into a shared `useRefetchOnExpiry` hook** used by both, rather than a
second copy that would drift, including the subtle part: a multi-unit training order keeps
one id across several expiries, so the re-arm key must include the changing timestamp or the
guard fires only once. Boundary tests were added on both sides.

**Verification (run by the orchestrator):** lint / typecheck clean; web **110 passed** (was
97). Live in the real browser: «Влияние · 17 из 90 — основание поселения откроется при 90»
(17 = Command Center 3 ×3 + Greenhouse 8, matching `calcInfluence`), and after the fix a
second scout trained with **no reload** — the order disappeared on its own and home troops
went «Сокольничий 1» → «Сокольничий 2».

### M2b.4 reopened — the change stream died permanently, now self-healing ✅ (2026-08-17)

I had accepted "a non-resumable change-stream error logs and stops until restart" as M2 debt.
**That judgement was wrong and the live run proved it.** During a long session the Docker
Mongo hit a `PoolClearedOnNetworkError: server monitor timeout` under load;
`ReportsRealtimePublisher` logged one error at 23:14 and **never emitted another
`reportArrived` for the rest of the process's life** — an hour later a real scouting arrival
wrote a real report (server-side `unreadCount: 1`) while the browser's socket sat connected
and the badge never moved. One transient blip on a dev laptop permanently broke realtime; on
the 1-core VPS across a 3-week round that is a certainty, not a risk.

The publisher is now a small supervisor: any `error`/unexpected `close` schedules exactly one
reconnect after exponential backoff (1 s → 30 s cap, mirroring the scheduler's own curve),
indefinitely — realtime has no "give up and mark failed" state to fall back to — never
overlapping two streams or two timers, resetting the backoff and **logging the recovery** on
success, and stopping cleanly on `onModuleDestroy`. It reopens **fresh** rather than resuming
from a token, deliberately: a resume can be refused once the point ages out of the oplog
(`ChangeStreamHistoryLost`), which is exactly the long-outage case, so resuming would need a
fresh-reopen fallback behind it anyway. The stated cost: **a report inserted while the stream
is down gets no push**, and the client's own refetch is the backstop. Seven tests cover
recovery, backoff/reset, error+close not double-scheduling, and no leaked timer after
shutdown. Server **123 → 130**.

### M2c.2 reopened — the movements overlay froze at zero ✅ (2026-08-17)

Same class as the training defect, found in the same live run: the overlay counted down to
«Прибытие через 00:16» and stayed there while the server had already flipped the movement to
`returning`. Fixed by reusing `useRefetchOnExpiry` (a movement expires **twice** under one id
— arrival, then return — so the `watchKey` nuance matters here too), with boundary tests for
outbound → returning and returning → gone. Web **110 → 112**.

*Not a defect, worth knowing:* while the tab was backgrounded Chrome throttled the countdown
timer, so the client clock lagged the server by ~14 s and the row briefly showed "arriving in
00:14" after the server had resolved the arrival. The grace-period-plus-retry refetch
corrected it on its own — which is precisely why that shape matters.

## ✅ M2c — Map & Reports UI: COMPLETE (awaiting owner review/commit)

The M2 record §13 acceptance criterion for M2c, run end to end in **real Chrome at a
phone-width column** against a live server with 135 seeded NPCs (throwaway
`last-signal-m2c-smoke` database):

| Criterion | Result |
|---|---|
| register | ✅ fresh guest → name + faction (Nomads) → settlement founded at (21, 3) through the UI |
| build to Barracks | ✅ queued from the Barracks card, «Осталось: 05:58», completed by the **real scheduler** |
| train a scout | ✅ trained twice through the UI; the second resolved **with no reload** (troops 1 → 2) |
| scout an NPC from the map | ✅ jump-to-coords → tile sheet → «Отправить в разведку» with 2 Сокольничих |
| the travel preview matches the actual arrival | ✅ client preview **05:18**, server's own `arriveAt − departAt` **05:18** — exact |
| the report appears in Reports **without a reload** | ✅ nav badge «Отчёты 1» → «Отчёты 2» on the WS push, no reload; the overlay flipped to «ВОЗВРАЩАЮТСЯ» on its own |
| and reads in Russian | ✅ «Отправлено / Вернулось / Потери: Сокольничий ×2 / ×2 / ×0», target resources vs caps, «Войск не обнаружено», «Радиовышка слишком слаба, чтобы разведать постройки» |
| Influence and threshold progress visible | ✅ «Влияние · 17 из 90 — основание поселения откроется при 90» |

*Honest scope note:* the pre-Barracks economy (Command Center to level 3 + a Greenhouse +
starting resources) was written directly into the throwaway database rather than played out —
that grind is M1c functionality already accepted, and playing it would have cost hours of
real build timers. **Everything from the Barracks build onward was done through the real UI
against the real scheduler**, with no shortcuts.

Final gate for M2c: **522 tests** (game-core 280, server 130, web 112), lint / typecheck /
build clean from a `pnpm clean` tree.

