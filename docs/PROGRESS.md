# Last Signal — Progress Log

Single running log of what has actually been built and verified. Maintained by the
orchestrator. Nothing is written here without a green check executed in-session.

Source of truth for design: `docs/IMPLEMENTATION_PLAN.md` + the binding milestone records
(`docs/M1_DESIGN_DECISIONS.md`, `docs/M2_DESIGN_DECISIONS.md`,
`docs/M3_DESIGN_DECISIONS.md` — each wins over the plan for its milestone's scope).

**Format rule (2026-08-16).** Only the current milestone carries detailed per-step
entries here. When a milestone is reviewed and committed, its per-step log moves
**verbatim** to `docs/archive/` (`archive/PROGRESS_M0_M1.md`, `archive/PROGRESS_M2.md`)
and is replaced by the condensed summary below. Detail is never deleted, only relocated.

---

## Current position

**M0 — Scaffold**, **M1 — Economy core** and **M2 — Map & movement** are ✅ **COMPLETE,
reviewed and committed** (`d794a3e`, `78b0ffd`, `b947f7f`, `a9f246e`), including the post-M1
debt sweep. Condensed summaries below; full step-by-step logs with verification evidence:
`docs/archive/PROGRESS_M0_M1.md` and `docs/archive/PROGRESS_M2.md`.

Verified baseline on the committed M2 tree, re-run from a `pnpm clean` tree at the start of
M3: **522 tests** (game-core 280, server 130, web 112), lint / typecheck / build clean.

**M3 design session — ✅ done (2026-08-17):** `docs/M3_DESIGN_DECISIONS.md` exists, status
RESOLVED (binding for M3, beats the plan on conflict).

**Now: M3 — Combat, expansion & trade.** Sub-milestones **M3a** → **M3b** → **M3c** →
**M3d** → **M3e**, per the decomposition in the record's §20, opened by **M3.0** (the ten
plan edits listed in that record's §21, applied before the first line of M3 code — the way
M2.0 applied M2's §15).

**M3.0** ✅ and **M3a** ✅ (M3a.1–M3a.7) are complete and verified; all five M3a acceptance
criteria were met against the real HTTP API, real Docker Mongo and the real scheduler. **The
M3a tree is uncommitted and awaiting the owner's review.** Gate: **606 tests** (game-core 327,
server 166, web 113), lint / typecheck / build clean from a `pnpm clean` tree.

**Two owner decisions are pending** (neither blocks M3b): the §1 faction-identity claims that
the draft stats do not support (M3a.1's entry), the siege-before-infantry starvation order
(M3a.3's entry), and — found by M3a's live acceptance run — **troops that starve in transit
are resurrected when the movement returns** (the M3a summary below, with three options and a
recommendation).

### Known debt carried out of M2 (none of it blocking)

1. **A report inserted while the realtime change stream is down gets no push** — the stream
   now self-heals (see the reopened M2b.4 entry), but the outage window itself is covered by
   the client's own refetch, not by a resume-token replay. Deliberate, reasoned in code.
2. **Tile selection is pointer-only** — no keyboard path to open a tile's info sheet (the
   sheet itself is fully keyboard-operable). Wiring jump-to-coordinates to also select the
   tile would close it cheaply.
3. **`§5`'s "WS event when a settlement appears"** is not implemented — it would have meant
   editing settlement creation from the realtime step; the map query's `staleTime` covers it
   for now.
4. **NPC band membership is not stored** — M4 must infer "which band was this NPC seeded
   into" from building levels/Barracks presence, or add a field.
5. **Stale comments** referencing the deleted `placement.constants.ts` / "outer-ring"
   placement remain in `settlements.constants.ts`, `settlements.module.ts`,
   `dev-seed.controller.ts` and `dev-seed.dto.ts`.
6. **Nomad settlements and oases share the toxic-green marker colour** on the map,
   distinguished only by shape (square vs circle) — tight at 0.5× zoom.
7. **Owner decision pending:** NPC names are Latin-script ("Wolfe Reyes") next to an
   all-Cyrillic UI. Nothing in the design record specifies their language.
8. **The training count picker has no client-side upper bound** — the server's
   `MAX_TRAIN_COUNT` (200) is not exposed through `game-core`, so an oversized batch surfaces
   as an ordinary unaffordable/would-starve reason, or as a server rejection if it slips past
   both. Correct, just not pre-empted client-side.

### Notes on two deliberate implementation choices (recorded, both accepted)

- **`useRefetchOnExpiry` lives in `apps/web/src/hooks/`**, generalized over the query key and
  element type, with three call sites (build queue, training order, movement row). It started
  as build-queue-local logic; the two boundary defects are what forced it to become shared.
  Its correctness rests on the watch-key rule documented in the file: anything that expires
  more than once under the same id must fold the changing timestamp (or status) into the key.
  The training fix was validated by **temporarily disabling the hook and confirming both new
  tests fail** — they are not accidentally-passing tests.
- **Read-on-open fires from `ReportsScreen`, not `ReportDetail`.** List rows already carry the
  full payload (`GET /api/reports` returns the same shape as `GET /api/reports/:id`), so the
  detail view is purely presentational and only the mark-read side effect is real — fired via
  a mutation only when the cached copy still shows `read: false`. Behaviourally verified live:
  opening a report drops the unread badge.
- **The Influence panel generalises across every configured threshold**, not only settlement
  #2 as §9's example literally phrases it — `settlementsAllowed`/`maxSettlements` (3) clearly
  anticipates a #3 threshold, and showing nothing between #1 and #2 would read as a bug. The
  #2 case is the one verified live.

### Environment (this machine)

- Node v24.11.1, pnpm 10.29.2, Docker 29.4.0 available.
- `gh` CLI is **not** installed — GitHub Actions state is checked via the Actions API.
- **Host port 27017 is occupied** by an unrelated Mongo container; Last Signal's Mongo
  binds host port **27117** (already wired in `docker-compose.yml`).

---

## Technical decisions (orchestrator-level, non-design)

- **Node 22+ / pnpm 10**, `packageManager` pinned in the root `package.json`.
- **Vitest everywhere** (server included) — one runner across all three packages.
- **`game-core` is built with `tsup`** to dual ESM + CJS + `.d.ts` (NestJS is CJS, Vite
  is ESM; the dual build removes all interop friction).
- **NestJS stays on its default CommonJS build** — friendliest to pm2 on the VPS.
- Package scope `@last-signal/*`. Server on port 3000 (prefix `/api`), web dev server on
  5173 proxying `/api` → 3000. Mongo via Docker Compose on host port 27117.
- **TypeScript pinned to `^5.9.3`** — typescript-eslint@8's peer range excludes TS 7;
  revisit when it catches up.
- **`apps/server` Vitest config is `vitest.config.mts`, not `.ts`** — the package is CJS,
  so a `.ts` config loads as CJS and Vite warns on ESM syntax. Do not "normalise" it.
- Root `prepare` script builds `game-core` after install so `typecheck`/`test` work from
  a clean tree (CI and fresh clones depend on it).

## Standing process lessons (M0–M1)

The four recurring ones are already baked into `docs/ORCHESTRATOR_PROMPT.md` (verify from
a `pnpm clean` tree; read stdout, not just exit codes; probe files by glob; a silent
subagent is not a dead one). Additional ones worth keeping:

- **Never dispatch a second subagent onto file paths the first may still hold** — confirm
  completion via its report or an explicit stand-down first (M1a.4a write collision).
- **Confirm the probe before believing the defect** — one "bug" was an insert into the
  wrong collection (M1a.6), another was the test suite's own fixture (M1a.7).
- **Test time-driven UI at the boundary, not just the slope** — the M1c countdown test
  asserted the timer decreased and missed that nothing updated at zero.
- **Derive test expectations from `game-core` at assertion time** — hardcoded cost
  constants in specs broke on every rebalance (M1a.7).

---

## ✅ M0 — Scaffold: COMPLETE (committed `d794a3e`)

pnpm TypeScript monorepo with three wired packages — `packages/game-core` (pure,
clock-free, dual ESM+CJS), `apps/server` (NestJS 11, `GET /api/health`), `apps/web`
(React 18 + Vite, mobile-first shell) — plus ESLint 9 + Prettier + Vitest, root scripts,
GitHub Actions CI. Acceptance ("CI green, dev servers boot, web calls API") verified:
full gate from a cold `--frozen-lockfile` install, runtime smoke over HTTP, web checked
in real Chrome at a phone viewport. All M0 debts were closed by M1 + the debt sweep
(i18n migration, `CORS_ORIGINS` env, `SERVER_VERSION` constant, CI has since run green
on GitHub — verified via the Actions API on `78b0ffd`).

## ✅ M1 — Economy core: COMPLETE (committed `78b0ffd`)

| Area | Delivered |
|---|---|
| `game-core` | `GameConfig`/`DEFAULT_CONFIG` (configVersion 2), 13-building catalogue, cost/time/production/upkeep/storage/prerequisite/Influence formulas, lazy `settleResources` + exact ETA helpers, 21-day reference-player harness tuned against the §0 contract |
| Server | MongoDB 7 single-node replica set (Docker, port 27117), 4+ schemas with indexes, event scheduler (claim → handle → commit-in-one-transaction, lease/sweep, dead-letter, `dueAt`-order replay), build command flow (transactions + version guard, i18n error keys) |
| Auth (M1b) | Guest auth, httpOnly cookie + Mongo sessions (TTL), registration + faction choice, ownership-checked settlement endpoints (404-not-403), deterministic outer-ring placement on the 61×61 grid centred at (0,0) |
| Web (M1c) | i18n scaffold (RU, key-typed `t()`), typed API client, onboarding, base screen: live resource bar (client-side `settleResources` against server clock), 13-building list with costs/reasons, build queue with countdowns + cancel |
| Docs | `docs/CONCURRENCY_PLAYBOOK.md` — the command recipe every later milestone copies |

**Acceptance criteria — all three verified end to end** (real Mongo over HTTP for M1a/b;
real Chrome at a phone viewport for M1c, through to a build completing without reload).
Final gate after the debt sweep: **248 tests** (game-core 144, server 66, web 38), lint /
typecheck / format / build clean, CI green on GitHub for the full M1 tree.

**Open debt entering M2:**

1. **Reference profiles compressed** (Casual ~1 level hot, Hardcore 1–2 short; queue
   idle ~85% for everyone) — deferred to **M4**, where `tools/sim` models raid income,
   the differentiator the §0 contract assumes.
2. **Influence UI/gating and Market** — routing now decided by the M2 record: Influence
   *display* ships in M2 (§9), founding gate + settler convoy and all trading are **M3**.
3. **Telegram auth is a stub** behind the real `AuthProvider` interface; guest auth
   carries M1–M6, TG smoke-tested on the VPS before M7.

## ✅ M2 — Map & movement: COMPLETE (committed `b947f7f`, `a9f246e`)

Design record: `docs/M2_DESIGN_DECISIONS.md` (RESOLVED, binding for M2). Its §15 plan edits
were applied in M2.0. Full per-step log with verification evidence:
`docs/archive/PROGRESS_M2.md`.

| Area | Delivered |
|---|---|
| `game-core` (M2a.1–2, M2b.1) | Bounded 61×61 grid + Chebyshev distance, seed-derived `terrainAt` (no tile documents), `travelTimeMs`/`slowestSpeed`, center-out expanding spawn annulus, oasis placement, deterministic `rng` (FNV-1a + mulberry32), the three-scout unit catalogue + training formulas + troop Food upkeep, scout-vs-scout resolution (1.5-power loss curve) and Radio Tower intel tiers |
| Server (M2a.3–6) | `world` singleton bootstrap on an empty DB, `oases` collection, the new placement policy replacing M1b's outer ring, ~135 real inert NPC accounts seeded in three archetype bands, `GET /api/map` with a public-fields leak guard |
| Server (M2b.2–4) | `trainScouts` (playbook recipe, chained one-unit-at-a-time `trainingComplete` events), `sendMovement`/`cancelMovement` with the 90 s window, `movementArrive`/`movementReturn` handlers (idempotent by movement status), reports collection + cursor API + unread counts, socket.io `/ws` gateway with a self-healing change-stream publisher |
| Web (M2c.1–4) | Map tab (viewport-culled DOM grid, 3 zoom steps, pan/pinch, placeholder tiles, hatched out-of-world edge), tile info sheet + send-scout flow with a client-side travel preview, movements overlay with live countdowns and cancel, Reports tab (unread badge, read-on-open, RU prose from structured payloads), live WS updates, scout training on the Barracks card, Influence panel, `useRefetchOnExpiry` shared boundary hook |

**Acceptance criteria — all three verified end to end**: M2a and M2b over the real HTTP API
against real Mongo with the real scheduler; M2c in real Chrome at a phone-width column
against a live server seeded with 135 NPCs (register → build → train → scout → report with
no reload, the client travel preview matching the server's own `arriveAt − departAt`
exactly). Final gate from a `pnpm clean` tree: **522 tests** (game-core 280, server 130,
web 112), lint / typecheck / build clean, Prettier clean, `--frozen-lockfile` reproducible.

**Two defects the live runs caught that the suite did not**, both recorded in full in the
archive: a permanently dead realtime change stream after one transient Mongo blip (now a
supervised reconnect with backoff), and two time-driven UI surfaces frozen at zero (now the
shared `useRefetchOnExpiry` hook). Both are the project's own standing lesson — *test
time-driven behaviour at the boundary, not just the slope* — reproducing.

**Open debt entering M3** is listed under "Known debt carried out of M2" above; item 1 (the
change-stream outage window) is scheduled for closure in **M3e** by the M3 record §16, and
item 4 (NPC band membership not stored) is M4's.

## Owner decisions (closed; reasoning archived)

- **New settlement starts with Command Center L1 only** — the Food gate making the
  Greenhouse the only legal first build is intended. Recorded in
  `docs/M1_DESIGN_DECISIONS.md` §4 (2026-08-16).
- **Progression-band compression stays deferred to M4** — tuning without the raid-income
  differentiator would be redone anyway (2026-08-16).

---

## Log — M3 (design)

### M3 design session ✅ (2026-08-17)

Two rounds of structured Q&A with the owner per `docs/M2_DESIGN_SESSION_PROMPT.md` (reusable
for later milestones), producing **`docs/M3_DESIGN_DECISIONS.md` (RESOLVED, binding for
M3)**. Documentation only — no code, no dependencies, no schema changes.

**Owner decisions (round 1):** full plan scope for M3 split into **M3a–M3e**; the battle
model is the **Travian T3.6 shape with our numbers** (points vs points, infantry/cavalry
defence split, wall multiplier, the same 1.5-power loss curve already shipped for scouts —
no morale, no bash points); founding costs **3 faction-neutral Settlers trained at the
Command Center**; **no razing — the Command Center floors at level 1**, a settlement always
survives. **(Round 2):** the Market ships **P2P offers + a faceless world exchange** (no
named NPC counterparties before M4); **the host settlement feeds stationed support**;
starvation is an **hourly tick killing the weakest first** until net Food ≥ 0; Telegram
notifications ship as a **provider interface with an in-app/WS provider live and a logging
TG stub**, the real bot smoke-tested before M7 (same treatment TG auth got in M1 §13).

**§0 anchor contract** is a battle reference table: four hand-computable battle rows plus a
loot row, reproduced exactly by `game-core` tests, and five sim-checkable bounds (raid income
share against M1 §0, Hidden Cache protecting ≥ 8 h of a Casual player's production, offence
stacks paying for themselves, M2 §0's travel bounds still holding with the real roster, no
unbeatable wall). **I re-derived every row numerically before writing it down** and corrected
five figures that were wrong in the 3rd–4th digit (rows 3 and 4's `x`, the cache values at L5
and L10, and the Barracks L20 speed-up, which is 6.0× not ~6.4×). Prettier clean on the file.

**Consequences worked out rather than assumed** (record §19, the part that earns the
session): M2b.3 deducts units at send, so **in-flight troops currently eat no Food** — a real
exploit once armies exist, closed by the `troops` / `awayTroops` / `stationedTroops` split
that keeps upkeep a pure function of one document; M2a.5's NPC bands have **no defenders**,
so 135 free farms would break the §0 raid-income bound on day one — the seeder gains defence
stacks and Hidden Cache levels; `config.scouting.lossExponent` is promoted to a shared
`config.combat.lossExponent` (one curve family for the whole game); the battle random factor
must be **derived from `hash(seed, movementId)`, never `Math.random()`**, or a crash-replay
would produce a different battle than the report already describes; destruction needs an
explicit build-queue rule (`level = min(targetLevel, current + 1)`) and a storage clamp; the
scheduler's strict `dueAt` ordering becomes a **load-bearing** property (it is what serialises
battles); and M2b.4's change-stream resume debt is pulled into M3e because notifications make
push delivery load-bearing.

**Not done here, on purpose:** the ten plan edits listed in the record's §21 are **not yet
applied** to `docs/IMPLEMENTATION_PLAN.md` — they are M3.0's job, the way M2.0 applied M2's
§15. No verification gate was run in this session because nothing executable changed.

---

## Log — M3 (implementation)

<!-- Newest entries at the bottom. Per-step entries for M3 accumulate here. -->

### M3.0 — plan edits from the M3 record §21 + M2 log archived ✅ (2026-08-17)

Documentation only — no code, no dependencies, no schema changes. Two jobs, both due before
the first line of M3 code.

**All ten §21 edits applied to `docs/IMPLEMENTATION_PLAN.md`:** §1 content scope (+ Settler,
+ two wildlife types, 16 trainable); §2.2 units (the Settler is trained at the Command
Center and shared by all factions, wildlife are untrainable); §2.3 Market (both halves —
P2P offers *and* the faceless world exchange with a spread; merchants derived from Market
level, not trained); §2.4 buildings (Command Center trains Settlers; Barracks and Machine
Shop levels reduce training time); §2.5 oases (wildlife defenders + a lazily regenerating
Food pool from M3, still not annexable); §2.5 travel (siege at speed 3–4 sits *deliberately*
outside the 2–4 h band — an explicit extension of the M2 §0 contract, not a violation);
§2.6 combat (the whole resolved model: T3.6 points with the infantry/cavalry split, the wall
as a multiplier, the shared 1.5-power curve, raid vs assault loss formulas, the
**deterministic** ±5 % roll and why it can never be `Math.random()`, loot behind the Hidden
Cache, the siege pass with the Command Center floor at 1 and no razing); §2.6 protection
(72 h from first settlement, blocks *all* foreign movements including scouting, broken only
by the holder's own first raid/assault — scouting and oasis raids do not break it); §5's M3
line (rewritten as the M3a–M3e split; the acceptance criterion loses "TG push received" and
gains "an in-app notification fires and the Telegram provider logs the identical payload");
§3.2 collections (`tradeOffers`, `notifications`, the three settlement troop lists,
`account.protectedUntil`, oasis live state).

**M2's per-step log archived** to `docs/archive/PROGRESS_M2.md` — 599 lines moved
**verbatim** (verified with `diff` against the extracted range, not eyeballed) and replaced
here by a condensed summary, per the format rule. M2 is committed (`b947f7f`, `a9f246e`),
which is what makes the move due.

**Verification:** Prettier clean on all three touched files. The M2 baseline was re-run from
a `pnpm clean` tree before any edits and is green — **522 tests** (game-core 280, server 130,
web 112), lint / typecheck / build clean — so M3 starts from a known-good line.

**One inconsistency in the record, recorded not silently fixed:** §4 and §13 both describe
the Settler as "a 2100-resource investment", while §1's stat table gives it
900 + 700 + 400 + 500 = **2500**. The table is the authoritative draft (every number in it is
a `GameConfig` draft for `tools/sim` to tune in M4 anyway), so the catalogue will carry 2500;
the prose figure is stale. Flagged for the owner, no design consequence either way.

### M3a.1 — game-core: the full 18-unit roster, widened `UnitDef`, config v7 ✅ (2026-08-17)

`game-core` knew 3 units (the M2 faction scouts); it now knows all **18** — offence infantry,
defence infantry, fast and siege for each faction (the 12 M3 adds), the faction-neutral
**Settler**, and the two **wildlife** oasis defenders. `UnitDef` gained `attack`,
`defInfantry`, `defCavalry`, `carry`, `splitClass`, `trainedIn?`, and siege-only
`wallDamage?`/`buildingDamage?`; `UnitRole` widened to seven roles; `faction` became
`Faction | null`. The three shipped scouts kept every M2 value byte-identical and only gained
the new fields (`attack: 0`, `defInfantry: 20`, `defCavalry: 10` — record §1's "a scout at
home now contributes a little real defence"). `config.scouting.lossExponent` was promoted to
the shared **`config.combat.lossExponent`** (§5, §19.3) and `scouting/combat.ts` reads it;
`configVersion` 6 → 7. RU names for all 15 new units were added to
`apps/web/src/i18n/locales/ru/units.json` — required, not optional: the web app's i18next
setup is key-typed, so widening `UnitType` breaks `apps/web` typecheck without them.

**Two technical micro-decisions** (design record silent; recorded here and in code comments):

- **`trainedIn`, not `faction`, decides trainability.** The record fixes the type as
  `Faction | null` but also says the Settler is trainable by everyone — which leaves no room
  for an "any" sentinel. So both the Settler and the wildlife carry `faction: null`, and the
  Settler carries `trainedIn: 'commandCenter'` while wildlife carry none. The faction-lock
  rule reads as "a unit with a `faction` must match yours; a trainable unit without one is
  open to everybody".
- **`scoutAttack`/`scoutDefense` are 0 on every non-scout**, required rather than optional.
  A garrison now mixes combat units with scouts, and `calcTroopScoutAttack`/`Defense` sum
  the whole list — 0 keeps them total *and* keeps M2's shipped scout-vs-scout maths
  bit-identical. A regression test asserts exactly that: `resolveScoutCombat` against
  `[falconer 2, brute 50, torcher 30]` equals the result against `[falconer 2]` alone.

**`configVersion` policy for M3** (orchestrator decision, in a comment on the field): all of
M3 lands under **7**; later M3 steps add blocks (`combat.randomFactor`, `wall`, `hiddenCache`,
`siege`, `training`, …) without bumping again. The field exists so an *archived season* stays
interpretable, not to track in-development edits.

**A review correction applied before acceptance.** The first pass mirrored all 18 units'
stats into a ~250-line `EXPECTED` literal in the spec. That is a change-detector: transcribed
from the same source in the same sitting it catches nothing at authoring time, while forcing
a lockstep two-file edit on every M4 tuning pass — the exact drag the standing lesson
("derive test expectations from `game-core` at assertion time") exists to avoid. It was
narrowed to the three units a **shipped contract** depends on — **Brute, Torcher, Biker**,
the units §0's four hand-computed battle rows were derived from — with the reason in the
comment. Everything else is covered by structural property tests (roster shape, trainability,
training-building mapping, split class, siege damage, scout fields, carry), which are immune
to rebalancing by construction.

**Verification (run by the orchestrator, not taken on report):** every one of the 18 stat
blocks checked against record §1 row by row; full gate from a `pnpm clean` tree — lint /
typecheck / build clean, **537 tests** (game-core **295**, was 280; server 130 and web 112
unchanged); Prettier clean on all eight touched files.

**⚠️ Finding for the owner — the §1 "faction identity check" does not hold against the §1
draft numbers.** The record asserts: *"Raiders are cheapest per attack point and train
fastest; Engineers cost the most, pay Electronics, and hit hardest per unit; Nomads are the
fastest and the best per Scrap spent on defence."* Computed from the shipped catalogue:

| Claim | Verdict |
|---|---|
| Engineers cost the most | ✅ costliest in all five roles |
| Engineers pay Electronics | ✅ highest Electronics in all five roles |
| Engineers hit hardest per unit | ✅ highest attack in offence inf (70), fast (120), siege (75) |
| Raiders train fastest | ✅ in 4 of 5 roles (defence inf goes to Nomads, 340 s vs 380 s) |
| **Raiders cheapest per attack point** | ❌ **only for cavalry.** Offence infantry: Skirmisher 2.846 total/atk < Exo 3.357 < Brute 3.375 (same order per Scrap). Siege: Ballista cheapest |
| **Nomads are the fastest** | ❌ **only scouts and cavalry.** Nomad offence infantry is the *slowest in the game* (Skirmisher 6 vs 7/7); Nomad siege ties last (3 vs Ram Truck's 4) |
| **Nomads best per Scrap on defence** | ❌ **false on every measure.** vs infantry: Bulwark 1.769 < Torcher 2.000 < Hunter-Sniper 2.125. vs cavalry: Torcher 1.167 < Hunter-Sniper 1.700 < Bulwark 3.286. Torcher strictly dominates Hunter-Sniper on *both* axes — the aggression faction has the most Scrap-efficient defensive infantry, against the Nomads' plan-locked "strong defense" identity |

**Nothing was changed to make a claim true** — the numbers shipped exactly as recorded,
because §0's battle-contract table was hand-computed from them and M3b must reproduce it
exactly. The useful part: **all three failures are repairable without invalidating §0**,
because §0's rows only involve Brute, Torcher and Biker. Raising Skirmisher's and
Exo-Trooper's cost (claim 1), raising Skirmisher's speed and Ballista Wagon's speed
(claim 2), and making Hunter-Sniper cheaper or tougher (claim 3) all leave §0 untouched.
Weakening Torcher would *not* — it is the defender in all four contract rows. Owner's call
whether to retune now or leave it to M4's `tools/sim` pass, where §22 already puts it.

**Two pre-existing issues found while verifying, neither caused by this step:**

1. **`npx prettier --check .` is not clean on the committed tree** — `apps/web/public/_mockup.html`
   and `_preview.html` fail, and did so on `HEAD` before any M3 change (verified by checking
   the committed blobs directly). The M2 log's "Prettier clean across every project file" was
   inaccurate for these two. They are mockup scratch files; either format them or add them to
   `.prettierignore`.
2. **The `startBuild` concurrency race test is load-sensitive.** It failed once during a gate
   run that overlapped a second full test run on the same machine, and passed on every
   isolated run before and after. Under CPU starvation the losing request can exhaust
   `MAX_COMMAND_ATTEMPTS` and return **409 `conflictRetryExhausted`** instead of the 400 the
   test demands — legitimate behaviour the assertion does not allow for. Worth widening the
   assertion to "one 200 and one rejection that is either 400-insufficientResources or
   409-conflictRetryExhausted" when that file is next touched.

### M3a.2 — game-core: training generalized, time scales with the training building ✅ (2026-08-17)

`config.training = { buildingTimeRatio: 0.91 }` (record §2, draft) and
`calcTrainTimeMs` / `calcTrainBatchTimeMs` gained a **required** `trainingBuildingLevel`:
`timeFactor = buildingTimeRatio ** (level − 1)`, the same shape as the Command Center's
build-time divisor. Barracks levels stop being dead weight. Two new accessors —
`canFactionTrain` and `unitsTrainableAt(config, building, faction)` — encode the §1/§2
trainability rule in one place: a unit needs a `trainedIn` to be trainable at all (wildlife
have none), a unit with a `faction` is faction-locked, and a trainable unit with
`faction: null` is open to everybody (today exactly the Settler, which is why it lives on the
Command Center). Call sites updated: the server's `trainScouts` passes the Barracks level,
and the web's `computeTrainEligibility` does too.

**The level parameter is required, not optional-with-a-default** — recorded because it is the
opposite of what the economy formulas do. An implicit "level 1" default would silently apply
wherever a caller forgot the real level, and the resulting bug (training that never speeds
up) is invisible rather than loud; required turns it into a compile error. The economy
formulas' optional `troops` parameters are a documented sharp edge in this codebase, and this
function deliberately does not repeat it. Sub-level-1 throws a `RangeError`: a level-0
building does not exist and cannot train, so a caller passing 0 has a bug.

**A regression caught in review and fixed before acceptance.** The first pass made the
web's no-Barracks branch return `unitTimeMs: 0, batchTimeMs: 0` (to avoid calling the new
throwing formulas with level 0). But `TrainingSection` renders on the Barracks card
**unconditionally** — `BuildingList.tsx:123`, and the base screen lists all 13 building types
whether built or not — and it renders both times unconditionally too. So every player who had
not yet built a Barracks would have seen «Время обучения: 00:00», which reads as a bug and
destroys the preview that tells them what a Barracks buys. Fixed by previewing at
`Math.max(1, barracksLevel)`: a freshly built Barracks *is* level 1, so it is a real number
rather than a placeholder, and since `0.91 ** 0 === 1` it reproduces the pre-M3a.2 display
byte for byte. A new `trainEligibility.test.ts` pins it. The `noFaction` branch keeps its
zeros — there is no unit to preview at all in that case.

Also corrected a docstring that M3a.1 had silently invalidated: `unitsForFaction` claimed
"one scout each until M3" and implied it answered "what can this faction train". It returns
5 units per faction now, and it filters on `faction` alone — so it *excludes* the Settler,
which every faction can train. It now says what it does and points at
`unitsTrainableAt`/`canFactionTrain` for the real question.

**Verification (run by the orchestrator).** Full gate from a `pnpm clean` tree: lint /
typecheck / build clean, **551 tests** (game-core **308**, was 295; web **113**, was 112;
server 130 unchanged), Prettier clean on all seven touched files. Beyond the suite I
exercised the built package directly and confirmed: `calcTrainTimeMs(brute, 1)` is exactly
`ceil(300/5)s = 60 000 ms` — level 1 changes not one shipped number; the level-20 ratio is
**6.0000** against the record's headline 6.0×; `calcTrainBatchTimeMs` is exactly `count ×`
the single-unit time; `unitsTrainableAt` returns exactly **3 at the Barracks** (offence
infantry, defence infantry, scout), **2 at the Machine Shop** (fast, siege) and **1 at the
Command Center** (the same Settler for all three factions) per faction; no wildlife type is
trainable at any building by any faction; and level 0 throws `RangeError`.

### M3a.3 — game-core: three-list troop accounting + the starvation math (pure) ✅ (2026-08-17)

`unionTroops(...lists)` (catalogue order, zero entries dropped, never mutates) plus a new
`units/starvation.ts` carrying `starvationOrder` and `resolveStarvation`. Pure `game-core`
only — the schema and the handler that use them are the next two steps.

**Why `unionTroops` exists at all**, recorded in its docstring: record §3 requires Food upkeep
to stay a pure function of **one** settlement document, so the three lists
(`troops` / `awayTroops` / `stationedTroops`) are unioned locally and handed to the *unchanged*
`calcNetFoodPerHour` / `calcNetRates` / `settleResources` / `wouldStarve*`, which still take a
single `TroopCounts`. No cross-document reads; the M1 lazy-resource model survives untouched.

`resolveStarvation` implements §4: guests (`stationed`) die before `awayTroops`, which die
before home `troops`; within a scope, weakest first by `starvationOrder`; only as many die as
it takes to bring net Food back to ≥ 0. Two determinism properties are load-bearing and are
built in deliberately, because the scheduler may hand the same tick to a handler twice and a
replay that killed a *different* unit than the report already described would be a real bug:
ties between contingents holding the same unit type break by **ascending `key`, never array
position** (array order is an accident of how the caller assembled the document), and both
`killed.stationed` and `remaining.stationed` are returned sorted by `key`. An emptied
contingent stays in `remaining` as `{key, troops: []}` — dropping it would lose the owner/
origin tag the caller needs to write that supporter's loss report (§15).

The kill loop batches (`ceil(deficit / upkeepPerUnit)` per target, clamped to what exists)
over a **fixed, finite target list** visited once each, so it cannot spin even if a config
retune ever gave some unit `foodUpkeepPerHour: 0`; exhausting the list *is* "a full pass freed
nothing", and it returns `resolved: false`.

**Verification (run by the orchestrator).** Full gate from a `pnpm clean` tree: lint /
typecheck / build clean, **570 tests** (game-core **327**, was 308; server 130, web 113
unchanged); Prettier clean on all five touched files. Beyond the suite I drove the built
package with a real deficit (net Food −38.4964, two stationed contingents, army at home and
away) and **hand-derived the expected sequence before looking at the output**: 6 Lookouts from
contingent `A:acct1` (scouts are weakest, and A sorts before B), then A's 20 Torchers, then 13
of B's 30 Torchers — 39 upkeep points for a 38.4964 deficit, the minimum. The implementation
produced exactly that, left `awayTroops` and home `troops` untouched, returned
`netFoodPerHourAfter` **exactly equal** to a fresh `calcNetFoodPerHour` over `remaining`
(no floating-point drift from the incremental accounting), and returned a **byte-identical
result when the `stationed` array was passed reversed** — the replay-determinism property,
confirmed independently rather than only in the subagent's own test.

**Confirmed from the record's own prediction:** §4 claims "scouts die before combat units by
the sum rule anyway". They do — all three scouts have combat weight 30, and the lowest
non-scout is the Brute at 65.

**⚠️ Second finding for the owner — the death order is economically inverted for siege.**
`starvationOrder` sorts by `attack + defInfantry + defCavalry`, which is exactly what §4
specifies, and siege units have deliberately poor defensive stats. The consequence:

| Dies at | Unit | Stat sum | Training cost |
|---|---|---|---|
| 10th | **Ballista Wagon** (siege) | 125 | **645** |
| 11th | Bulwark (defence inf) | 130 | 220 |
| 12th | Exo-Trooper (offence inf) | 135 | 235 |
| 13th | **Rail Sling** (siege) | 145 | **790** |
| 14th | Dune Buggy (fast) | 155 | 535 |
| 16th | Biker (fast) | 215 | 520 |

So the **most expensive unit in the game after the Settler (Rail Sling, 790) starves before
every cavalry unit and before infantry costing a quarter as much.** The record already
recognised this failure mode once — it exempts the Settler by name, "a 2100-resource
investment ... losing them to a Food dip would be brutal" — but did not extend the reasoning
to siege, which is 620–790 per unit. Implemented exactly as recorded; not changed. If the
owner wants it fixed it is a one-line change (either exempt `role: 'siege'` alongside
`'settler'`, or make total training cost the primary sort key and the stat sum the
tie-break). Otherwise it is M4 `tools/sim` material.

### M3a.4 — server: `awayTroops` / `stationedTroops`, upkeep from all three lists ✅ (2026-08-17)

**The exploit is closed.** `Settlement` gained `awayTroops` and `stationedTroops` (a new
`StationedContingent` sub-schema tagged with `ownerAccountId` + `fromSettlementId`), both
`default: []` so no migration is needed anywhere (record §19.10). A single
`upkeepTroopsOf(doc)` helper returns `unionTroops` of all three lists and now feeds **every**
upkeep call site: `settleDoc`'s `settleResources`, `startBuild`'s Food gate, `trainScouts`'s
Food gate, and the wire view's `calcNetRates`/`calcNetFoodPerHour`. One named helper rather
than four inline unions, precisely because the bug class this step exists to kill is "one call
site forgot a list".

Two call sites stay **home-only on purpose**, both now carrying a comment saying so: the
send-time troop-availability check (you can only send what is physically at home) and
scout-vs-scout `defenderHomeTroops`. The latter also records a **future obligation** — record
§8 requires stationed scouts to count for the host's scout defence and detection, which M3c
must wire once `support` can actually populate the list.

The movement lifecycle maintains `awayTroops` inside the same version-guarded transaction as
everything else: send moves `troops → awayTroops`; arrival subtracts combat losses (or the
whole army on a total wipe, where nobody is coming home); return subtracts the survivors it
credits back into `troops`. Cancel and the `targetNotFound` turn-around change nothing — the
units are still genuinely in transit — and both carry a comment so the omission reads as
deliberate. I traced all six paths: they balance exactly (`losses + survivors = units`).

**A correctness call reversed in review.** The first pass had the subtraction helper **throw**
when `awayTroops` lacked enough of a unit type, reasoned as "the loud mechanism this codebase
has, since there is no logger". Both halves were wrong. There *is* a logger — `@nestjs/common`
`Logger` is used in five places including `SchedulerService` and `ReportsRealtimePublisher`,
and its output is visible in every server test run. And throwing trades away the wrong thing:
in `MovementReturnHandler` a throw fails the handler → the scheduler retries 3× → the event
dead-letters → **`movement.survivors` are never credited home and the player's returning army
is permanently destroyed**, in order to protect a Food number that was merely *wrong* for all
of M2. Worse, it was **guaranteed to fire on the first deploy against any world with a
movement already in flight**: those movements were debited from `troops` under the old code
and never recorded in `awayTroops`, so `awayTroops` is `[]` when they land. Now the helper
**clamps at zero and returns a `shortfall`**, and each of the three call sites logs it as an
error through its own `Logger` with the settlement id, movement id and shortfall. Drift is
loud and diagnosable from the pm2 log; it no longer eats armies. An `upgrade-boundary safety`
integration test pins it: a `returning` movement against an empty `awayTroops` credits its
survivors home, leaves `awayTroops` at `[]` rather than negative, and does not throw.

**A client-side drift the subagent found unprompted and fixed:** `useLiveResources` runs
`settleResources` locally against the server clock to drive the live resource bar, and was
feeding it home troops only. The moment the server started charging for `awayTroops`, the
client's Food number would have diverged from the server's the instant any army left home —
visible as drifting numbers, the exact failure the "both sides import the same formula" rule
exists to prevent. It now uses a client mirror of `upkeepTroopsOf`. `ScoutForm` correctly
still uses home-only ("what can I send right now").

**Verification (run by the orchestrator).** Full gate from a `pnpm clean` tree: lint /
typecheck / build clean, **578 tests** (server **138**, was 130; game-core 327 and web 113
unchanged), Prettier clean on every touched file. The record §20 acceptance criterion —
*"sending an army away leaves upkeep unchanged (gap #1 closed, asserted numerically)"* — is
met by an integration test over the **real HTTP API against real Mongo** that reads
`netFoodPerHour` before and after a send and asserts `toBe`, bit-identical, not
`toBeCloseTo`; it also asserts the counts moved `troops → awayTroops`. I checked that the test
genuinely discriminates: under the pre-M3a.4 behaviour `netFoodPerHour` would rise to the
buildings-only value after a send, so the assertion fails without the fix. Four more tests
cover the round trip, losses leaving `awayTroops` with the upkeep delta derived from
`game-core`, the total wipe, and the upgrade boundary; both existing replay tests were
extended to assert `awayTroops` idempotency too, not just movement status.

### M3a.5 — server: `trainUnits` generalized to three training buildings ✅ (2026-08-17)

`trainScouts` → `trainUnits`. The playbook recipe is untouched (settle → validate → deduct
the whole batch at enqueue → version-guarded write → chained `trainingComplete` events
crediting one unit at a time); only what it accepts widened. Three substantive changes:

- **One `canFactionTrain` call replaces the "is this the faction's own scout" check.** It
  covers both gates at once — a unit with no `trainedIn` (the two wildlife types) is rejected
  regardless of faction, and everything else must either belong to the caller's faction or be
  faction-neutral. That last clause is the whole reason the Settler works from all three
  factions without a special case.
- **The training building is resolved from `config.units[unitType].trainedIn`**, and the
  level-≥1 structural check is now against *that* building. `errors.training.noBarracks`
  became `errors.training.buildingMissing` with a `{ building }` param — the old key was
  simply wrong for two of the three buildings.
- **One active order per building, not per settlement.** `MAX_ACTIVE_TRAINING_ORDERS` became
  `MAX_ACTIVE_ORDERS_PER_BUILDING`, and an existing order's building is derived from its own
  `unitType` rather than stored on the queue item — **no schema change**, exactly as §2
  anticipated ("the `trainingQueue` array already tolerates more than one entry").

The Food gate now measures against `upkeepTroopsOf` (the M3a.4 union), so an army already in
transit counts against your next training order — which, with cavalry at upkeep 3 and siege at
3–4, is precisely the intended constraint on army size. `TrainingCompleteHandler` needed **no**
change: it reads `item.unitType`/`item.unitTrainTimeMs` generically and was already
roster-agnostic (verified by inspection, not "improved"). The route path is unchanged
(`POST /settlements/:id/train`), so no client contract broke.

**Client kept honest but deliberately not rebuilt:** `TrainBlockReason.noBarracks` became
`buildingMissing { building }`, and the client's queue-busy mirror now scopes to the *same*
building — without that it would have greyed out the button while a legitimately parallel
order ran elsewhere. The Barracks card still trains only the faction scout; that is the
**M3e boundary**, stated in a comment so it reads as deliberate.

**Verification (run by the orchestrator).** Full gate from a `pnpm clean` tree: lint /
typecheck / build clean, **583 tests** (server **143**, was 138; game-core 327 and web 113
unchanged), Prettier clean on every touched file. The §20 acceptance criterion — *"a Barracks
order and a Machine Shop order run simultaneously"* — is covered over the real HTTP API: both
orders return 200, `trainingQueue` holds two entries whose derived buildings are exactly
`['barracks', 'machineShop']`, and a *second* order at either building is still rejected with
`queueBusy` carrying the right `building` param, so the parallelism is per-building rather
than unlimited. Two other tests are worth calling out as genuinely discriminating: the
Settler case loops over **all three factions** and asserts each can train one at the Command
Center; and the Food-gate test asserts the union property **against the formula directly**
(`wouldStarveWithTroops` is safe with no troops and unsafe with `awayCount` away) *before*
asserting the HTTP rejection — so it proves the settlement starves specifically *because* of
`awayTroops`, not incidentally.

**Recorded judgement (not a defect):** the RU text for `buildingMissing`/`queueBusy` stays
generic rather than interpolating the `{ building }` param, matching how every other
multi-param server error in this codebase words its Russian. The param is on the wire, so
M3e's Units tab can render a translated building name when it has a place to put one.

**Small debt introduced, recorded:** the new `wideRosterBuildings()` test fixture pins the
Greenhouse Farm at `maxLevel` for a generous Food margin instead of deriving the minimal safe
level the way the rest of that file does — the Machine Shop has a nonzero `foodUpkeepWeight`
(0.3) that the existing `foodSafeBuildings()` margin does not account for. Correct, just less
tight than the file's own convention.

### M3a.6 — server: the `starvationTick` handler and its lazy scheduling ✅ (2026-08-17)

Troops now starve. `StarvationTickHandler` settles the settlement **to `event.dueAt`** (never
the wall clock — the shipped replay rule), re-checks the trigger (net Food < 0 **and** stored
Food ≤ 1e-6), calls `game-core`'s `resolveStarvation`, persists `remaining` to all three
lists in one version-guarded write, writes the reports, and reschedules at exactly
`event.dueAt + 1 h` while the balance is still negative. `ReportType` widened with
`'starvation'`. New settlement fields `lastStarvationTickAt`, `pendingStarvationEventId`,
`pendingStarvationDueAt`, all `default: null` — no migration.

**Lazy scheduling, not a background sweep** (§4, and the plan's "nothing ticks in the
background"): `ensureStarvationSchedule` reconciles *one* pending tick per settlement —
schedule when it starts starving, cancel when it recovers, cancel-and-reschedule when the
deadline genuinely moves (guarded by a 1 s epsilon so `Math.ceil` noise between back-to-back
commands doesn't churn the event). ~150 settlements generate no background load.

**A subtle bug the subagent found and fixed while testing, worth keeping in the log.** The
first draft ran the ensure-check inside `settleDoc`, i.e. as a side effect of *every* settle
— which the brief had suggested as the natural choke point. That made `StarvationTickHandler`
trip it during its own self-settle: the handler anchors on `event.dueAt`, which after a
scheduler backoff no longer equals the stored `pendingStarvationDueAt` (`recordFailure`
reassigns `event.dueAt` independently of anything on the settlement), so the "deadline moved"
branch fired and **cancelled the very event the handler was mid-way through applying**,
leaving stray duplicates. Four tests failed on it. The fix scopes the generic ensure-check to
the ownership-checked `settleSettlementDoc` only, and has the starvation handler manage its
own follow-up explicitly using the same shared `computeStarvationDeadline` formula — so the
two paths can never disagree about *where* the deadline is, while never fighting over *whose
event* is in flight.

**A gap I found in review and sent back.** That fix was correct but dropped the other half of
§4's rule — *"when a command **or handler** settles a settlement and sees net Food < 0"*. With
the check scoped to account commands only, **no handler armed a tick**, and a settlement can
enter the starving state from a handler path via ordinary play: the build gate evaluates
against the troops as they are *now*, and the training gate against the buildings as they are
*now*, so a queued upgrade (+3 upkeep, allowed) plus a training batch (+3 upkeep, allowed)
can cross zero only when `BuildCompleteHandler` applies the level. Food would then drain to 0
and **no troop would die until the owner next issued a command** — an unbounded grace period
for offline players, which is exactly what §4 rejected, and worst precisely when starvation is
supposed to bite. Closed by making `ensureStarvationSchedule` public and calling it from
`BuildCompleteHandler` and `TrainingCompleteHandler` after they apply their effects. The
self-cancellation hazard cannot apply to those two, and the comment says why: the scheduler
claims and dispatches **one event at a time**, so a `buildComplete` can never be in flight
alongside that settlement's own `starvationTick`. A test reproduces the exact cross-zero
sequence and asserts the tick is armed by the build handler.

**Idempotency — the hard part of this step.** Unlike a build (queue item gone) or a training
order (`remainingCountAtSchedule` vs the document), a starvation tick has **no natural
"already applied" marker**, and killing troops twice is silently plausible and destroys player
property. The guard is `lastStarvationTickAt >= event.dueAt`, checked immediately after
loading the document and **before the settle call**, so a replay is a true no-op with zero
writes. Both exit paths stamp it, so a run that killed nothing still closes the door. I
walked the state machine myself: a replay of the same tick returns early; a stale *older*
event returns early (so out-of-order replay after downtime cannot double-kill); the legitimate
follow-up at `dueAt + 1 h` proceeds; and a scheduler retry after a throw proceeds correctly,
because handler effects and the `done` mark commit in one transaction, so a failed attempt
applied nothing.

**Verification (run by the orchestrator).** Full gate from a `pnpm clean` tree: lint /
typecheck / build clean, **595 tests** (server **155**, was 143; game-core 327 and web 113
unchanged), Prettier clean on every touched file. Nine integration tests over the real HTTP
API cover the §20 criterion end to end — scheduling at `now + msUntilEmpty` derived from
`game-core`, exactly one pending tick under repeated commands with the deadline updating
rather than duplicating, the kill hitting the weakest first and only as deep as needed,
**guests consumed before `awayTroops` and before home troops**, the owner's report plus a
supporter's own contingent-scoped report, rescheduling at exactly `dueAt + 1 h`, no follow-up
after recovery, buildings untouched, and the replay killing nothing the second time.

**A Mongoose trap found here that would have bitten M3c:** `reportModel.create(docs, { session })`
throws unless `ordered: true` is set whenever more than one document is created in one call.
Every previous handler wrote exactly one report, so it had never surfaced. M3c writes an
attacker report, a defender report and a per-supporter loss report from one battle — it would
have hit this immediately.

### M3a.7 — server: NPC seeder bands gain defenders and a Hidden Cache ✅ (2026-08-17)

Record §19 integration point 2: M2a.5 seeded NPC bands with 0–6 *scouts* and nothing else,
because nothing could attack them. Raiding lands in M3c, so **135 undefended farms would have
handed every player the §0 raid-income bound on day one**. `NpcBandDef` gained `defenders` and
`hiddenCache` ranges — young: neither; developed: **10–20** defence infantry + Cache **2–3**;
veteran: **30–60** + Cache **4–6**. Placement still goes through `missingPrerequisites` for
legality, and the defender unit is resolved from the catalogue **by `role`, per faction**
(Torcher / Bulwark / Hunter-Sniper), never by a hardcoded name.

**The draw order (scouts, then defenders) is part of the world's determinism contract** and is
commented as such — the RNG is a stream, so reordering it would change every NPC in a world
regenerated from the same seed.

**The Food question, answered numerically rather than assumed.** Defenders eat Food, and M3a.6
now kills troops on a negative balance — so a seeder that over-stacked a settlement would
produce NPCs that quietly starve their own army to death, surfacing much later as "why do the
NPCs have no troops by day 3". I recomputed the worst case independently of the subagent, at
the true combinatorial extreme (max Command Center level for peak upkeep, **minimum**
Greenhouse Farm roll for minimum output — each resource building is drawn independently, so
they can land at opposite ends — max other resource buildings, max cache, max defenders *and*
max scouts together): **developed +46.43 Food/h, veteran +70.19 Food/h**, identical across all
three factions (every defence-infantry unit has `foodUpkeepPerHour: 1`). No clamp needed, and
the margin is comfortable. Both a pure property test (100 seeds × 3 bands × 3 factions) and an
integration test over the real 135-NPC batch assert net-Food-non-negative at genesis.

**The counts are justified against §0, not guessed.** Sanity-checked with the record's own
reference raider (100 Brutes, `atkPts` 4000) against the *toughest* faction's defender
(Bulwark, `defInfantry` 65), using the raid loss formula `x/(1+x)`: 10 defenders → attacker
loses ~6 (a cheap starter target); 20 → ~16 with the defender losing ~85 % (raidable but with
real cost); 30 → ~25; 60 → `defPts` 3900 vs `atkPts` 4000 puts `x` at 0.963, so a bare
100-Brute raid loses ~49 of its 100 and is no longer viable — a veteran needs a genuinely
committed army, which is §19's stated intent. NPCs never build a Warehouse or Cold Storage, so
caps stay flat at 4000 and a 50 %-filled NPC holds ~2000 per resource: Cache 3 protects ~365
(~18 %), Cache 6 protects ~897 (~45 %).

**Verification (run by the orchestrator).** Full gate from a `pnpm clean` tree: lint /
typecheck / build clean, **606 tests** (server **166**, was 155; game-core 327 and web 113
unchanged), Prettier clean on every touched file. I reproduced the genesis-Food arithmetic
myself against the built package and got the same figures.

**One test failed once and did not reproduce — diagnosed, not waved away.**
`settlement-creation.integration.spec.ts`'s ~30-settlement placement property test failed on
one full-gate run and then passed on four consecutive re-runs (twice server-only, twice the
whole monorepo). It is **structurally impossible for M3a.7 to have caused it**: that spec sets
`WORLD_NPC_COUNT = '0'` in its own `beforeAll`, so it seeds no NPCs at all, and this step
changed nothing outside NPC generation. Its annulus assertions are also robust to the only
thing that could have shifted (RNG-stream ordering), since a larger effective `n` only pushes
the annulus outward and the assertion is a lower bound. That leaves the same cause as the
known-flaky `startBuild` race spec — 30 sequential HTTP settlement creations, each a real
transaction, timing out under CPU starvation. **Recorded as a second load-sensitive spec**
alongside the race test; both deserve a tolerance pass when that area is next touched.

## ✅ M3a — Roster, training & the truth about upkeep: COMPLETE (awaiting owner review/commit)

The record §20 acceptance criteria for M3a, run end to end over the **real HTTP API against
the real Docker Mongo with the real scheduler running** (throwaway `last-signal-m3a-smoke`
and `last-signal-m3a-npc` databases, both dropped afterwards):

| Criterion | Result |
|---|---|
| a Barracks order and a Machine Shop order run **simultaneously** | ✅ 4 Brutes and 2 Bikers both accepted, `trainingQueue` held both; a *second* Barracks order was rejected with `errors.training.queueBusy` / `params.building = "barracks"` |
| Food upkeep rises by exactly the catalogue values | ✅ two Brutes credited by the real scheduler moved `netFoodPerHour` 3012.15198056 → 3010.15198056 — a delta of **exactly 2.000000** |
| sending an army away leaves upkeep unchanged (**gap #1 closed**) | ✅ **3006.15198056 before and after**, bit-identical, with the counts moving `troops → awayTroops` |
| forcing net Food negative fires the tick, kills the weakest first, writes the report, stops on recovery | ✅ see below |
| a freshly regenerated world's NPCs have defenders | ✅ 135 seeded; **85 (63 %)** carry defence infantry *and* a Hidden Cache — matching the 60 % developed+veteran band weight; defender counts 10–59 and cache levels 2–6, both inside their configured ranges; a Raiders NPC held Torchers, its own faction's unit |

**The starvation run, in detail.** With net Food at **−8.848** and stored Food at 0, the real
scheduler fired the tick on its own. It killed the **3 Lookouts that were away first** — they
are both the weakest units (combat sum 30 vs the Brute's 65) *and* in the scope that starves
before home troops — then exactly **6 Brutes**, for 9 upkeep points against an 8.848 deficit:
the minimum. Net Food landed at **+0.152** and the report carried the structured payload
(`killedTroops`, `killedAwayTroops`, `killedStationed`). I had hand-derived that exact
sequence before running it.

Then something better happened: the Barracks credited another Brute a moment later, pushing
net Food to −0.848, and **a second tick fired ~2.4 s later and killed exactly one Brute**,
restoring +0.152. That is the M3a.6 gap I sent back — *"no handler ever arms a tick"* —
working live: `TrainingCompleteHandler` armed it itself. Without that fix the settlement would
have sat net-negative with no tick until the player next opened the app.

The genesis-Food property also holds against the **real** seeded world, not just the fixtures:
across all 135 NPCs the minimum net Food is **+26.50/h** and **zero** starvation ticks are
armed.

Final M3a gate from a `pnpm clean` tree: **606 tests** (game-core 327, server 166, web 113),
lint / typecheck / build clean.

### ⚠️ Defect found by the live acceptance run — needs an owner decision (blocks nothing yet)

**Troops that starve to death while in transit come back to life when the movement returns.**

Reproduced live: the 3 Lookouts starved out of `awayTroops` were still listed on the movement
document, so `MovementArriveHandler` resolved scouting with all 3, wrote `survivors: 3`, and
`MovementReturnHandler` credited 3 Lookouts back into home `troops`. The settlement ended with
Lookouts it had already lost.

**Why this matters:** it makes starvation escapable — send your army out, and any starvation
deaths among it are undone on return. That is a variant of the exact exploit M3a.4 closed
("marching an army out protects it"), reintroduced through a different door.

**Why the design record does not settle it:** §3 defines `awayTroops` as a *denormalized
counter* of in-transit units, and §4 says losses "are removed from whichever list holds them"
— but nothing says the **movement document** must be updated to match, and §18 designs
cross-document writes only for *arrivals*, not for starvation. So the invariant "`awayTroops`
equals the sum of in-flight movements' units" is broken by design, not by a coding mistake.

**The diagnostic worked exactly as intended.** The clamp-and-log I required in M3a.4 (instead
of the original throw) is what surfaced this — the server logged:
`MovementReturnHandler: awayTroops drifted below zero crediting movement … — clamped at zero, shortfall: [{"unitType":"lookout","missing":3}]`
and credited the survivors home rather than dead-lettering the event. Had it thrown, this
would have shown up as a mysteriously vanished army instead of a precise log line.

**Three options, for the owner to choose (this is a design decision, not a technical one):**

1. **Starvation also debits the movements** — walk the settlement's outbound movements and
   reduce their `units`/`survivors` to match. Correct and faithful to §4's kill order, but it
   needs a cross-document write and a policy for *which* movement loses units when several are
   in flight (deterministically — e.g. ascending movement `_id`, mirroring §18's lock order).
2. **Exempt `awayTroops` from starvation** — in-transit troops still *pay* upkeep (so the M3a.4
   fix stands untouched) but cannot die; only stationed contingents and home troops starve.
   Simplest, no cross-document write, and arguably fair ("they're carrying their own rations").
   Deviates from §4's stated three-scope kill order.
3. **Starve them but have the return credit `min(survivors, awayTroops)`** — rejected in my
   view: `awayTroops` is an aggregate across all movements, so it cannot say *which* movement
   lost units, and the result would be order-dependent and non-deterministic on replay.

My recommendation is **option 1** if the owner wants §4 honoured literally, **option 2** if
they want the simplest thing that cannot break replay determinism. Either is a small change;
option 1 belongs in M3c (where two-document arrival transactions already exist), option 2 is a
few lines in `resolveStarvation`'s caller. **Nothing downstream is blocked by it** — the
exploit requires deliberately starving an army that is already marching.
