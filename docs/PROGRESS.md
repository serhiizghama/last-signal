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

**M3.0** ✅ and **M3a** ✅ (M3a.1–M3a.7) are complete, verified and **committed (`6dc6d54`)**;
all five M3a acceptance criteria were met against the real HTTP API, real Docker Mongo and the
real scheduler. Gate at commit: **606 tests** (game-core 327, server 166, web 113), lint /
typecheck / build clean from a `pnpm clean` tree.

**M3b** ✅ (M3b.0–M3b.3) is complete and verified — the battle engine, the deterministic roll,
loot behind the Hidden Cache and the siege pass, all pure `game-core`, all five §20 acceptance
criteria met. **The M3b tree is uncommitted and ready for the owner's review.** Gate:
**737 tests** (game-core 458, server 166, web 113), lint / typecheck / build clean from a
`pnpm clean` tree, with no warnings anywhere in the output.

**Next: M3c — attack, support & oases (server).**

**All four open owner decisions are closed (2026-08-17)** and recorded verbatim in the design
record's new **§24**, which amends §4 and §5:

| # | Question | Decision |
|---|---|---|
| A | siege starves before cheap infantry (M3a.3) | **Siege dies last, alongside Settlers** — a dies-last rank in `starvationOrder` |
| B | troops that starve in transit are resurrected on return (M3a's live run) | **`awayTroops` are exempt from starvation** — they still *pay* upkeep, they just cannot die. Owner accepted the flagged cost: a marching army is immortal to the tick, so home troops and guests die instead |
| C | §5's contingent-loss rule is self-contradictory (found while briefing M3b) | **Uniform loss fraction — Travian's actual rule.** The defPts-weighted casualty budget reading is superseded |
| D | §1's faction-identity claims are false against §1's own numbers (M3a.1) | **Defer every retune to M4's `tools/sim`.** Nothing is hand-tuned before then; §0 stays the fixed contract |

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

### ⚠️ Defect found by the live acceptance run — ✅ RESOLVED by owner decision (record §24 B)

> **Closed 2026-08-17: the owner chose option 2 — `awayTroops` are exempt from starvation.**
> They still pay Food upkeep (the M3a.4 exploit fix stands); they simply cannot die, so there
> is nothing left to resurrect. Implemented in M3b.0. The consequence was flagged before the
> decision and accepted: a marching army is immortal to the tick, so a starving settlement's
> home garrison and its guests die instead, and "march to dodge the tick" still works at the
> price of your home defence, manual re-sending each round trip, and a frozen economy. Full
> reasoning in `docs/M3_DESIGN_DECISIONS.md` §24 B. The analysis below is kept as written.

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

### M3b.0 — the two starvation amendments (record §24 A and B) ✅ (2026-08-17)

The owner's answers to the two questions M3a left open, applied before any M3b engine code so
that no later step is written against a rule that is about to change. Both are recorded in the
design record's new §24; this entry records the implementation.

**A — siege dies last, alongside Settlers.** `compareStarvationOrder` gained a `diesLastRank`
(settler 2 > siege 1 > everything else 0) compared **before** the combat-weight sum, rather
than a tweak to the weight itself — the weight is also the battle-strength expression, and
bending it to fix a starvation ordering would have moved a shared formula for a local reason.
The pre-existing settler special case was folded into the rank, not left running alongside it.
Verified by driving the built package: the order is now `lookout falconer surveyorDrone
feralDog brute scavengerGang torcher hunterSniper skirmisher bulwark exoTrooper duneBuggy
biker armoredQuad | ballistaWagon railSling ramTruck | settler` — every siege unit after every
non-siege combat unit, the Settler last.

**B — `awayTroops` are exempt from starvation.** `StarvationInput.awayTroops` stays (it is
part of the upkeep union, so a marching army still *pays*: M3a.4's exploit fix is untouched),
but it is simply absent from the target list, and `killed.awayTroops` / `remaining.awayTroops`
were **removed from `StarvationResult` entirely** — under this rule they would be a constant
empty list and a verbatim echo of the input, and keeping them is an open door for the
resurrect-on-return defect to walk back through. There is now nothing for a caller to
resurrect. Server side: the handler no longer writes `awayTroops` back and the starvation
report payload lost `killedAwayTroops`.

**Verified numerically by the orchestrator, against the built package, not on report.** Same
buildings (CC 1 + Greenhouse 1) and 60 home Brutes: net Food **−31.00**, and 31 home Brutes
die. Add 20 in-transit Brutes and net Food is **−51.00** — a delta of exactly 20.0000, their
upkeep — and **51** home Brutes die. That single pair of runs proves both halves at once: the
in-transit army still raises the deficit, and its 20 units of upkeep are paid for with 20 extra
*home* casualties. That is precisely the consequence flagged to the owner before the decision
and accepted (record §24 B). A deficit driven entirely by in-transit upkeep (500 away Brutes,
no home troops) returns `killed: []`, `resolved: false`, `netFoodPerHourAfter: −471.00` — no
kill, no spin.

**The no-progress path, the risk this step actually carried, confirmed by reading the code.**
`resolved: false` is newly reachable, so the handler had to be checked, not assumed. Two
branches, both already correct: the trigger-no-longer-holds branch returns before
`resolveStarvation` is called and re-derives its deadline from `computeStarvationDeadline`
(anchored on `event.dueAt`, never the wall clock, returning `null` when Food has recovered);
and `writeReports` gates on `anyKilled`, so a tick that kills nothing writes **no** report for
the owner or any supporter. The re-arm is `event.dueAt + HOUR_MS`, driven by
`result.netFoodPerHourAfter < 0` and **not** by whether anything died — so a stuck
`resolved: false` settlement re-ticks on the ordinary hourly cadence forever, never
immediately. One cheap settlement write per hour (to advance `lastStarvationTickAt`, the
idempotency guard), no report storm, no busy loop.

**One error caught in review and sent back:** the new doc comment called the Settler "a
4000-resource investment" — 4000 is its `baseTrainTimeSec`; the cost is **2500**
(900 + 700 + 400 + 500). Fixed. (The record's own §4/§13 prose says "2100", stale since M3.0
flagged it; §1's stat table remains the authoritative draft.)

**Verification (orchestrator-run, not taken on report):** `starvationOrder` and the
deficit/casualty arithmetic driven directly against `dist/` as above; server suite **19 files
/ 166 tests green** on my own run (Mongo up on 27117); game-core green (see M3b.1's entry for
the combined count). The two edited integration assertions now check that `awayTroops` is
**byte-identical** after a tick and that `killedAwayTroops` is absent from the payload.

### M3b.1 — game-core: `resolveBattle`, the deterministic roll, the §0 contract ✅ (2026-08-17)

The battle engine, pure — **zero server code**, which is exactly why record §20 makes M3b its
own sub-milestone: it can be verified entirely against §0. New `packages/game-core/src/combat/`
with `battle.ts` (`resolveBattle`, `BattleKind`, `BattleContingent`, `BattleInput`,
`BattleContingentOutcome`, `BattleResult`) and `roll.ts` (`battleRoll`). Config gained
`combat.randomFactor` (draft 0.05) and a new **top-level** `wall: { defenseRatioPerLevel: 1.03 }`.
`configVersion` stayed **7**, per the M3a.1 policy.

**Config-block placement (technical micro-decision, recorded).** §5/§6/§7 name their knobs
`wall.defenseRatioPerLevel`, `hiddenCache.base`, `siege.resistanceBase` — with the `config.`
prefix the record uses elsewhere, that reads as *top-level* blocks. They are top-level, each
with a doc comment stating it is battle tuning and is distinct from the same-named entry in
`buildings` (the cost/level curve). Following the record's own names beats a tidier nesting
that would drift from the document every reader will have open beside the code.

**The §0 contract reproduces exactly**, `randomFactor` pinned to 0 — all four battle rows with
their hand-computed loss counts (7/20, 7/19 with the one surviving Torcher that makes a raid a
*partial* engagement, 11/20 behind a L10 wall, and 10 Brute + 4 Biker/30 for the
infantry/cavalry split), plus the fifth row's `lootCapacity` of **5580**. Those expectations
are hardcoded on purpose and the spec says so: §0 *is* the contract, and this is the one place
where a hardcoded expectation is right rather than a change-detector.

**Owner decision §24 C is implemented and documented in the code:** defender losses use the
**uniform loss fraction** (Travian's real rule) across every contingent and unit type, not a
defPts-weighted casualty budget. The rounding is `Math.round(fraction × count)` per unit type
independently, clamped — the exact convention `scouting/combat.ts` already ships, reused rather
than re-invented, so one loss curve and one rounding rule cover both systems.

**Verification (orchestrator-run).** Beyond re-running build / typecheck / suite
(**434 tests**, game-core, up from 327 — M3b.0's +6 and M3b.1's +107), I drove the built
package on a case I hand-derived **before** looking at the output: 100 Brutes raiding a target
holding 20 Torchers with an ally's 100 Lookouts stationed. Predicted `defPts` 2700,
`x = 0.5545691`, defender fraction `0.6432651`, attacker fraction `0.3567349` → 36 Brutes lost,
64 surviving → capacity 3840; 13 Torchers and 64 Lookouts dead. The engine produced exactly
that, and the result is **byte-identical** (`JSON.stringify` equality) with the two contingents
passed in reverse order — the replay-determinism property, confirmed independently rather than
only in the subagent's own test. `battleRoll` is stable across repeat calls, differs per
`movementId`, and lands inside `[−1, 1)` across 2000 keys (min −0.9999, max 0.9997).

**Recorded for M3c:** `resolveBattle` deliberately does **not** compose the loot and siege
passes, though §5 phrases them as one function. Each is a separate pure function
(`resolveLoot`, then the siege pass) and the arrival resolver composes them, because the
composition needs the *defender's settled resources* and *building levels* — state that belongs
to the caller's transaction, not to a battle calculation. `lootCapacity` and `attackerPrevailed`
are carried on `BattleResult` precisely so the composition cannot silently skip §6's
"an unsuccessful attacker loots nothing".

### M3b.2 — game-core: loot, the Hidden Cache and the §0 loot row ✅ (2026-08-17)

`combat/loot.ts` — `hiddenCacheProtection` and `resolveLoot` — plus a top-level
`hiddenCache: { base: 200, ratio: 1.35 }` config block, sibling to `wall` and following the
same convention. `configVersion` stayed 7.

**The signature carries the rule.** `resolveLoot(config, battle, target)` takes
`battle: Pick<BattleResult, 'lootCapacity' | 'attackerPrevailed'>` rather than a bare capacity
number, so §6's "an unsuccessful attacker loots nothing" cannot be forgotten by the M3c caller
— omitting it becomes a compile error instead of a runtime bug found in a live raid. The same
self-enforcing shape is now the house pattern for the whole `combat` module.

**Level 0 is special-cased to 0 protection, not the raw formula.** `base × ratio ** (level - 1)`
evaluates to `200 × 1.35 ** -1 = 148.15` at level 0 — a protection reading for a building that
does not exist. A settlement with no Hidden Cache protects nothing; negative levels fold into
the same branch defensively rather than extrapolating the curve into territory it was never
meant to cover. This is the kind of off-by-one that would have quietly given every settlement
in the world 148 free protected units of each resource.

**Verified by the orchestrator against the hand-computed §0 row before reading the spec's
assertions:** protection at L5 = `200 × 1.35^4` = **664.30125**; available =
2335.69875 / 535.69875 / **0** / 1335.69875 = **4207.09625**, below the 5580 capacity, so all of
it is taken and the cache saves the Electronics *entirely*. The spec asserts exactly those
numbers, and — the part that matters — the **5580 is derived from a real `resolveBattle` call**
for §0 row 1 rather than typed in a second time, so the loot row genuinely tests the wiring
between the two modules instead of restating a constant. Cherry-picking is disproved
properly: in the capacity-bound case each resource's share of `taken` is asserted equal to its
share of `available`, so a raider cannot skim Electronics and leave the bulk behind.

Resources stay **floats** end to end (no rounding, no flooring — the M1 numeric convention),
and clamping the credited loot to the attacker's storage caps is documented as the M3c
caller's job, not this function's. Gate: **445 tests** green (game-core), lint/typecheck/build
clean, prettier clean on all five touched files.

### M3b.3 — game-core: the siege pass, the resistance curve, the CC floor ✅ (2026-08-17)

`combat/siege.ts` — `siegeResistance` and `resolveSiegePass` — plus a top-level
`siege: { resistanceBase: 6, resistanceRatio: 1.18, commandCenterFloor: 1 }` config block, the
third sibling of `wall` and `hiddenCache`. `configVersion` stayed 7. `resolveSiegePass` takes
`Pick<BattleResult, 'attacker' | 'attackerPrevailed'>`, the same self-enforcing shape
`resolveLoot` established, so §7's "a defeated attacker never gets a siege pass" cannot be
forgotten by M3c.

**Two pools, spent one level at a time, nothing carried over.** Wall points (`Σ wallDamage`)
and building points (`Σ buildingDamage`) come only from **surviving** siege units. The wall is
always breached first; building points reach `siegeTarget` **only** if the wall reaches 0 in
this pass (or was already 0), and if `siegeTarget === 'wall'` they are wasted — the attacker's
choice, not an error. A level only ever drops when its full `resistanceBase × resistanceRatio
** (L - 1)` cost is paid; leftovers are discarded, and no partial-level state is ever stored.

**Verified by the orchestrator against the built package, all six cases hand-derived first:**

| Case | Result |
|---|---|
| §7's worked draft — 10 Ram Trucks (80 pts) vs a L10 wall | **L10 → L7**, 68.27872 spent, 11.72128 discarded; the L7 step needs 16.19732 ✔ |
| building phase — 10 Ram Trucks (30 pts) vs a L5 Barracks, wall already down | **L5 → L2**, 29.84526 spent, 0.15474 discarded ✔ |
| the wall gate — 1 Ram Truck (8 pts) vs a L20 wall | wall unmoved, `wallBreached: false`, **every** building point discarded, Barracks untouched ✔ |
| the CC floor — a L3 Command Center under 1500 points | **L3 → L1, never 0**, 1484.57 discarded ✔ |
| a Command Center already at its floor | absorbs nothing, spends 0, discards all 1500 ✔ |
| defeated attacker / no siege units among survivors | complete no-op in both cases ✔ |

**One interpretation call the subagent flagged, checked and accepted.** On
`attackerPrevailed === false` it zeroes `wallPoints`/`buildingPoints` outright rather than
tallying them and then spending nothing. That is not a divergence: `attackerPrevailed` is
`x < 1 && !attackerWiped`, and on an **assault** — the only kind that may carry siege units
(§6) — a false value means the attacker was wiped, so the surviving-unit tally is 0 anyway. The
one shape that could differ, a raid clamped at `x = 1` with survivors, cannot carry siege by
validation. Equivalent in every reachable state; the simpler branch stands.

### ✅ M3b — The battle engine (pure): COMPLETE (uncommitted, ready for owner review)

Record §20's M3b acceptance criteria, every one met — and M3b was deliberately specified as a
**pure** sub-milestone, so all of it is verifiable against §0 with zero server code:

| Criterion | Result |
|---|---|
| the §0 table (four battle rows + the loot row) reproduced **exactly** with `randomFactor: 0` | ✅ rows 1–4 with their hand-computed loss counts, plus the loot row's `lootCapacity` 5580 → 4207.09625 taken behind a L5 cache |
| the roll proven deterministic across two runs from the same `(seed, movementId)` | ✅ in the spec and re-confirmed by the orchestrator across 2000 keys, always inside `[−1, 1)` |
| property test: losses never exceed the army | ✅ a fixed scenario × kind × wall × roll matrix, both sides |
| property test: an attacker with 0 attack points is rejected | ✅ throws, for a zero-count army and a genuinely empty one |
| property test: defender losses split across contingents | ✅ proportional to body count per owner decision §24 C, and byte-identical under reversed contingent order |

**Gate, from a `pnpm clean` tree: 737 tests** (game-core **458**, server 166, web 113) —
lint / typecheck / build clean. I read the full stdout, not just exit codes: **no warnings, no
deprecations, no ignored build scripts** anywhere in the run. Repo-wide Prettier flags only the
two pre-existing static mockups (`apps/web/public/_mockup.html`, `_preview.html`), untouched by
M3b and already recorded as pre-existing in M3a.1.

**What M3b deliberately did not build**, so M3c does not have to guess: no composition of
battle → loot → siege into one call (the caller owns that, because it needs the defender's
settled resources and building levels inside its own transaction); no send-time validation
(scouts barred from armies, `atkPts > 0`, siege only on assaults, protection checks); and no
persistence of any level change, storage clamp or build-queue adjustment — §7 resolves those
rules, but they belong to M3c's arrival resolver.

### M3c — plan (2026-08-17)

Record §20's M3c is the largest sub-milestone in M3: attack/support movements and their
arrival resolvers, the two-document transaction of §18, loot on the return leg, siege with the
Command Center floor and the storage clamp, support recall/evict, oasis live state and
raiding, beginner protection, and `GET /api/movements/incoming`. Decomposed into eight steps:

| Step | Scope | Depends on |
|---|---|---|
| **M3c.1** | `game-core`: oasis target defenders + lazy `settleOasis`, `incomingDetailTier`, the protection predicate, and the `oasis` / `radioTower` / `protection` config blocks | — |
| **M3c.2** | schemas: widen `MovementType` (all six) and `ReportType`, movement `toOasisId` / `loot` / `siegeTarget`, oasis live state, `account.protectedUntil` + stamping it | — |
| **M3c.3** | send commands: `raid` / `assault` / `support` with §9's validation, `awayTroops` accounting, the uniform 90 s cancel, **and all of §11's send-side enforcement** (see the re-cut below) | 1, 2 |
| **M3c.4** | the per-type arrival-resolver registry (§9) + the §18 two-document battle arrival, defender/stationed losses, battle reports | 3 |
| **M3c.5a** | the **whole** loot pass: computed and deducted from the defender at arrival, carried on `movement.loot`, credited and storage-clamped on the return leg, overflow reported | 4 |
| **M3c.5b** | siege application (CC floor, the storage clamp after a destroyed Warehouse/Cold Storage, the build-queue `min(target, current+1)` rule) + the `buildingDestroyed` report | 5a |
| **M3c.6** | support arrival → `stationedTroops`, the recall/evict pair, stationed scouts counting for scout defence and detection | 4 |
| **M3c.7** | oases: lazy live state, raiding and scouting them | 4 |
| **M3c.8** | `GET /api/movements/incoming` with its Radio Tower tiers + §11's "the map marks the settlement as protected" flag | 3 |

**Two orchestrator re-cuts of this table, decided when M3c.3 was briefed (both structural, no
design reopened).** (1) **§11's send-side enforcement moved out of M3c.8 and into M3c.3.**
Both halves of §11 — rejecting a foreign movement aimed at a protected account, and lifting
the sender's own protection on their first `raid`/`assault` at another account — live in the
same method, in the same validation pipeline, in the same transaction as the send. Splitting
them across two steps would have meant re-opening that method a second time to thread one more
check through an ordering whose every position is already justified by a comment. M3c.8 keeps
what is genuinely its own: the incoming endpoint and the map-side protected marker. (2) **The
arrival-dispatch guard moved out of M3c.4 and into M3c.3.** `MovementArriveHandler`
unconditionally runs `resolveScouting` today, so the moment M3c.3 can send a `raid`, an
arriving raid would silently resolve as a scouting mission — a wrong battle written to two
players' report inboxes. M3c.3 therefore adds the type check that makes the handler *fail
loudly* (the event retries, then dead-letters, and the movement stays `outbound` and
recoverable) until M3c.4 replaces it with §9's real per-type resolver registry. A dead-lettered
event is recoverable; a raid resolved as a scout is not. (3) **The loot pass moved wholly into
M3c.5.** The table's original split — arrival in M3c.4, "loot credited on the return leg" in
M3c.5 — would have put loot's *computation and defender deduction* in one step and its
*crediting* in the next, splitting a single §6 rule across two subagents and two review passes.
M3c.4 therefore resolves the battle and writes nothing about loot at all; M3c.5 owns §6
end to end, alongside §7's siege pass, which is the other "after the battle" pass over the
same defender document.

**One design reading recorded, not asked** (§11 vs §19.2): **NPC accounts get no beginner
protection.** §11 says "NPCs are covered too", which reads two ways — that NPCs *hold*
protection, or that NPCs must *respect* it. The sentence's own continuation settles it ("M4's
Marauder must respect `protectedUntil` … because it goes through the same command service"),
and §19.2 removes all doubt from the other direction: it extends the NPC seeder bands with
real defenders and Hidden Caches precisely because "135 free farms with zero defence would
hand every player the §0 raid-income bound on day one". Protecting all 135 NPCs for 72 h would
instead make the entire world un-raidable for the first three days and break §0's raid-economy
bounds outright. This falls out of the code for free — `NpcSeederService` writes settlements
via `insertMany` and never touches `createSettlement`, which is the only path that stamps
`protectedUntil` — and the reasoning is recorded at the stamping site so nobody later "fixes"
the asymmetry.

**One technical necessity recorded** (§10): the oasis carries **two** regeneration timestamps,
not the one §10's field list names. Food is continuous, so `lastRegenAt` advances to `now`
exactly like `SettlementResources.lastCalcAt`; defenders are discrete (one unit per 2 h), so
`lastDefenderRegenAt` may only advance in whole intervals. Sharing one timestamp would discard
the remainder on every settle, and an oasis settled every few minutes by passing scouts would
regenerate its garrison *never*. The second field is what makes §10's own stated mechanic
work.

### M3c.1 — game-core: oasis live state, incoming tiers, the protection predicate ✅ (2026-08-17)

`map/oasis-state.ts` (`oasisTargetDefenders`, `settleOasis`), `scouting/incoming.ts`
(`incomingDetailTier`) and `protection.ts` (`isBeginnerProtected`,
`beginnerProtectionUntil`), plus three top-level config blocks — `oasis`, `radioTower`,
`protection` — siblings of M3b's `wall` / `hiddenCache` / `siege`. `configVersion` stayed 7.

**The two-timestamp decision, proven rather than argued.** I drove the built package through
the failure mode the second timestamp exists to prevent: an oasis raided down to 1 defender of
each type, then **settled every 60 seconds** across three regeneration intervals — the traffic
pattern a few passing scouts would produce. It regenerated to **4 of each**, exactly matching a
single settle at the same instant. Under one shared timestamp it would have sat at **1 and 1
forever**, because every settle would have seen `elapsed < interval` and credited nothing. The
remainder-preservation identity also holds directly: settling at 1.5 intervals then 3 equals
settling once at 3.

**The off-by-one guard held.** `rollRange` is the count of distinct values (13 Feral Dogs,
7 Scavenger Gangs), not the maximum — the reading that would silently narrow every garrison in
the world. Swept all 3721 grid coordinates: Feral Dogs land in **12–24** and Scavenger Gangs in
**4–10**, both inclusive bounds actually reached, not merely never exceeded.

Also verified against the built package: a never-settled oasis materialises at full target with
an empty pool (so world generation keeps writing nothing but coordinates — no migration);
Food accrues at exactly 120/h and clamps at 4000; a backwards clock is an exact no-op;
tiers resolve `0 → existence, 1 → kind, 4 → kind, 5 → full, 20 → full`; protection is 72 h and
`now === protectedUntil` reads as **already expired**, matching the codebase's existing
duration-boundary convention.

**Two behaviours recorded, neither blocking.** (1) The subagent chose to apply the
remainder-preserving formula uniformly rather than special-casing "already at target" — I
checked, and the defender counts are identical either way since growth is capped; only the
stored timestamp differs and nothing else reads it. (2) A backwards clock *rewinds* the
timestamps to `now`, which can slightly over-credit a later settle. That is exactly what
`settleResources` has always done for settlement resources, the magnitude is bounded by the
target composition and the Food cap, and diverging here would have been a new inconsistency
rather than a fix.

Gate: **485 tests** green (game-core, up from 458), build / typecheck clean, prettier and
eslint clean on all 11 touched files.

### M3c.2 — schemas: the six movement types, the six new report kinds, oasis live state, `protectedUntil` ✅ (2026-08-17)

Persistence only, no behaviour: `MovementType` widened to all six (§9) and `ReportType` to ten
of §15's eleven kinds (`settle`/`trade` wait for M3d, which produces them); `Movement` gained
`toOasisId`, `loot` and `siegeTarget`; `Oasis` gained `defenders` / `loot.food` /
`lastRegenAt` / `lastDefenderRegenAt` / `version` (§10); `Account` gained `protectedUntil`
(§11), stamped by `SettlementsService.createSettlement` on an account's **first** settlement,
inside the same transaction as the settlement write, reusing the `existingSettlements` array
the Influence check had already fetched — no second count query.

**The union widened once, not six times.** All six types land in this one pass even though
`settle`/`trade` have no send path until M3d: it is the command layer, not the schema, that
decides what a player can produce, and the schema only has to be permissive enough to store
what the command layer is willing to write. This is exactly what M2's own comment on the field
anticipated when it chose a union over a hardcoded literal.

**`toSettlementId` is now optional, with the xor stated as an invariant, not a validator** —
exactly one of `toSettlementId` / `toOasisId` is ever set, `target` (the coordinates) is
always set either way. Enforcement sits at the command layer, matching this codebase's
existing convention for cross-field invariants on these schemas (`BuildingSlot`'s "16 slots
max … enforced by the application layer, not the schema").

**Verified by the orchestrator.** Full gate from a `pnpm clean` tree: **766 tests** (game-core
485, server **168** — up from 166, the two new integration tests — web 113), lint / typecheck /
build green, and I read the whole stdout: no deprecations, no ignored build scripts, no
warnings beyond the `ReportsRealtimePublisher` reconnection lines its own spec deliberately
provokes. Prettier clean on every touched file. The two new tests run against the real Docker
Mongo: a fresh account's first settlement stamps `protectedUntil` inside `[before + 72 h,
after + 72 h]`, and all **135** freshly seeded NPC accounts carry no `protectedUntil` at all.

**The "no migration" claim was checked, not assumed.** The dev database has no oases to read,
so I inserted exactly what M2's `generateOases` writes — `{x, y, type}` and nothing else, as a
**raw** insert bypassing the Mongoose schema — into a throwaway scratch database on the local
Docker Mongo, read it back through the new schema, and dropped the database. It hydrates as
`defenders: []`, `loot: {food: 0}`, `lastRegenAt: null`, `lastDefenderRegenAt: null`,
`version: 0` — precisely the "never settled" shape M3c.1's `settleOasis` materialises at full
target on first contact. Every M2-era oasis document is therefore valid as-is.

**One trap recorded for M3c.3 / M3c.7, deliberately not fixed here.** `toMovementView`
(`movements/movements.view.ts`) still does `toSettlementId: String(doc.toSettlementId)` into a
non-optional `string` field, so an oasis-targeted movement would serialise the literal string
`"undefined"`; `MovementArriveHandler` reads the same field the same way. Nothing can produce
such a movement yet — no command writes `toOasisId` — so this is not a live defect, but the
step that first sends a movement at an oasis owns widening the view (and the handler's target
resolution) rather than discovering it in a raid report.

### M3c.3 — send commands for `raid` / `assault` / `support`, §11 enforced at send ✅ (2026-08-17)

`sendScouts` became `sendMovement`, widened to `scout | raid | assault | support` (§9);
`settle`/`trade` still bounce off `errors.movement.unknownType` — M3d owns them. The DTO
(`dto/send-movement.dto.ts`, renamed) gained an optional `siegeTarget`; `movements.util.ts`
gained `isSendableMovementType` and `sumAttackPoints`; ten new i18n keys landed with their
Russian strings, and `emptyUnits`/`insufficientTroops`/`targetIsOwnSettlement` stopped talking
about "разведчиков" now that armies march through the same command.

**The validation pipeline was extended in place, not rewritten** — the M2 ordering (origin
settle → empty list → count shape → strip/merge → identity+role → availability → target) and
its per-step reasoning comments survive intact, with the new checks slotted where their cost
puts them: everything config-only (role legality, `atkPts`, `siegeTarget` shape) before the
troop-availability read, and the two checks that need a second collection read (the target's
owner, then the caller's own account) last.

**Per-type rules as shipped.** Wildlife and Settlers are barred from every type this command
produces (technical safety: wildlife is never player-ownable, Settlers are §13's `settle`
payload). Scouts are barred from `raid`/`assault` (§9/§1) but allowed on `support` — §8 is
explicit that stationed scouts count for the host's scout defence. Siege units may only ever
leave on an `assault`. `support` may target the caller's own settlement (§8), so the
own-settlement rejection is skipped for it alone. A `siegeTarget` is rejected outright on a
non-assault, must be `'wall'` or a real building type, and is **required** when an assault
actually carries siege units — never silently defaulted to `'wall'`, because §7 makes the
target the attacker's decision. An assault with a valid `siegeTarget` but no siege units is
accepted and the field is **not persisted**: there is no siege pass to aim it at.

**§11 enforced at send, both halves, in one transaction.** A foreign movement — `scout`
included — aimed at a still-protected account is rejected with `errors.movement.targetProtected`;
a `raid`/`assault` at another account lifts the *caller's* own protection by setting
`protectedUntil = now` (not `$unset`: the instant it lifted stays on the record, and
`isBeginnerProtected` already treats `now === protectedUntil` as expired). Scouting and support
deliberately do not lift it — M2c's onboarding loop is "train a scout, send it", and a rule
that strips a new player's protection for following the tutorial is a trap, not a feature.

**The temporary arrival guard.** `MovementArriveHandler` throws on any non-`scout` arrival,
naming the movement and pointing at the §9 registry. I checked the systemic consequence myself
rather than assuming it: `SchedulerService.recordFailure` pushes the failed event's `dueAt`
forward with exponential backoff and `claimNextDueEvent` sorts by `dueAt` among `status: 'due'`
events, so a permanently-failing raid arrival **cannot** head-of-line block anyone else's build
queue or starvation tick — it retries, then lands in `failed` after `maxAttempts`, leaving the
movement `outbound` and resolvable once M3c.4 lands.

**Verification (orchestrator-run).** Full gate from a `pnpm clean` tree: **794 tests**
(game-core 485, server **196** — up from 168 — web 113), lint / typecheck / build green,
stdout read in full: no deprecations, no ignored build scripts, no warnings beyond the
`ReportsRealtimePublisher` reconnection lines its own spec provokes. Prettier clean across
every touched file.

Beyond re-running the delivered suite I wrote a **throwaway probe suite of six cases the
delivery does not cover**, ran it against the real app, and deleted it. All six pass:
(1) protection is an *account* property — the protected account's **second** settlement is
just as unattackable as its first; (2) a target whose `protectedUntil` is 1 ms in the past is
attackable, matching §11's boundary convention; (3) a raid rejected for insufficient troops
leaves the sender's `protectedUntil` **byte-identical** and writes no movement — the lift is
inside the transaction, not before it; (4) an **assault** lifts protection too (§11 names both)
and the account reads as unprotected immediately afterwards; (5) `awayTroops` is **unioned**
with what was already in flight rather than overwritten (`brute 3 + 4 → 7`, `lookout 2`
untouched, `biker 2` added) and a mixed Brute/Biker army travels at the **Brute's** speed;
(6) the 90 s cancel works for an `assault` — status `returning`, every unit alive in
`survivors`, the pending `movementArrive` deleted and exactly one `movementReturn` scheduled.
One probe assertion failed on its first run and the failure was **mine, not the delivery's**:
I asserted the event collection held only `movementReturn`, forgetting M3a.6's lazily-armed
`starvationTick`; scoped to this feature's own event types, it passes.

**Judgment calls reviewed and accepted.** (1) A new `errors.movement.unknownUnitType` key was
minted — for `scout`, an unrecognised unit type is still reported as `notScout` (unchanged
wire behaviour), but the other three types need a key of their own before indexing
`config.units`. (2) `sumAttackPoints` was extracted so the `noAttackPower` rejection has direct
unit coverage: it is unreachable through today's real catalogue, since every
offense/defense/fast/siege unit has `attack > 0` — the guard stays anyway so a future 0-attack
combat unit cannot slip a toothless army through. (3) `'wall'` is already a member of
`BUILDING_TYPES`, so the explicit `'wall'` branch in the siege-target check is redundant as
logic; it was kept because `combat/siege.ts` types the same value as `'wall' | BuildingType`
and matching that reads clearer than a bare `isBuildingType`.

**Recorded as debt, deliberately not fixed here.** `siegeTarget` is not exposed on
`MovementView`, so the client cannot read back what an assault was ordered against — M3e's
attack flow needs it, and it is one field on a pure reshape. Whether the defender may see it
is already settled and is *not* a free addition: §12 gates the siege target behind Radio Tower
level 5 on `GET /api/movements/incoming` (M3c.8), so it must be added to the owner's own view
without leaking into the incoming payload's lower tiers.

### M3c.4 — the per-type arrival-resolver registry + the raid/assault battle arrival ✅ (2026-08-17)

§9's registry, built the way §9 asks for it: `MovementArriveHandler` shrank to the shared
preamble (load the movement, apply §18.4's `status !== 'outbound'` replay guard, settle the
target, dispatch) and now holds a `Map<MovementType, MovementArrivalResolver>` assembled at
construction, throwing on a duplicate registration exactly as `EventHandlerRegistry` already
does for event types. `ScoutArrivalResolver` is M2's scout logic moved out unchanged;
`BattleArrivalResolver` is new and covers `raid` + `assault`; `support`/`settle`/`trade` keep
the loud throw, its comment narrowed to name only those three.

**The battle itself.** Defence is assembled per §5 from the target's own `troops` plus every
`stationedTroops` contingent — keyed with the same `stationedContingentKey` helper
`StarvationTickHandler` already uses for that array — and **never** from `awayTroops`. Wall
level feeds `resolveBattle` directly; the roll is `battleRoll(world.seed, movementId)`, never
`Math.random()`; the return leg's `dueAt` comes off `event.dueAt`, never the wall clock (§18).
The two settlement writes are version-guarded and issued in **ascending `_id` order** (§18.3),
decided at runtime from the actual ids rather than from "defender first" — the whole point of
the rule is that two concurrent arrivals must never grab the same pair in opposite orders.

**Reports (§15), all three kinds.** The attacker gets `raid`/`assault` with both armies, the
defender's merged losses and `BattleResult`'s numeric internals; the defending owner gets
`defense` with the same battle from their side plus which contingents took losses, addressed by
real owner/origin ids; every supporter with casualties gets `supportLoss` carrying **only**
their own contingent's losses. No loot or destruction fields anywhere — that is M3c.5, and the
payloads are shaped so those fields are additions, not renames.

**Verification (orchestrator-run).** Full gate from a `pnpm clean` tree: **801 tests**
(game-core 485, server **203** — up from 196 — web 113), lint / typecheck / build green, stdout
read in full, no new warnings.

The delivery flagged a possible flake — the world seed is random per suite boot, so a marginal
army could in principle have an assertion flipped by the ±5 % `combat.randomFactor`. I ran the
movements integration suite **five times end to end: 52/52 every run**, so no assertion in it
sits close enough to a threshold for the roll to matter. (The delivery's own one-in-ten failure
was an `ECONNRESET` from the in-memory replica set, which I did not reproduce.)

Then a **throwaway probe of four cases the delivery does not cover**, run against the real app,
three consecutive clean runs, deleted afterwards:
(1) **an undefended target** — the degenerate `defPts = 0` battle that is also the most common
raid in a real round: resolves with a finite `x`, the attacker loses nothing, the defender
still receives their `defense` report (§15's "both parties always");
(2) **a defender whose entire army is in `awayTroops` and whose `troops` is empty** defends
with **exactly 0** points and its in-transit army is untouched — §5's "troops that are away do
not defend" isolated so that a defence accidentally summing `awayTroops` could not hide behind
home troops;
(3) **two consecutive raids on the same settlement compound** — the second meets the first's
survivors, and I recomputed that second battle independently from `game-core` against the
persisted state: the stored survivor count matches `resolveBattle` exactly, which tests the
serialization property of §18 and the persistence in one shot;
(4) **`supportLoss` leaks nothing** — its payload has exactly four keys (`movementId`,
`hostSettlementId`, `at`, `losses`), carries no host losses and no battle internals, the
reported loss plus the survivors still on the host document add back up to the contingent's
original size, and the attacker's own report never names the supporter's account.

**Judgment calls reviewed and accepted.** (1) The home contingent's key is the literal
`'home'`; `stationedContingentKey` always produces `"<24-hex>:<24-hex>"`, so a collision is
structurally impossible — checked, not taken on faith. (2) §18.3's ordering was applied to the
two settlement writes only, with the movement write left last; the rule exists to prevent two
multi-document commands from deadlocking on the same *pair*, and the movement document is never
part of another arrival's pair. (3) The missing-target turn-around was factored into one shared
`turnAroundOutboundMovement` helper instead of being duplicated per resolver — the brief said
scout logic moves "verbatim", and this is the one place that was read as *identical mechanics*
rather than identical bytes. The scout suite passes unchanged, which is the property that
mattered. (4) A `raid`/`assault` whose target vanished now gets a report of its **own** type
with `reason: 'targetNotFound'` rather than the scout's `scoutFailed` — §9 describes the
turn-around *shape*, §15 assigns the report *type* per movement kind, and a raider receiving a
`scoutFailed` would be a wire-level lie.

**Still standing, still M3c.7's to fix:** the preamble resolves the target with
`String(movement.toSettlementId)`, which becomes the literal `"undefined"` for an
oasis-targeted movement. Unreachable today; the step that first sends a movement at an oasis
owns it.

### M3c.5a — the loot pass, end to end ✅ (2026-08-17)

§6 wired from the defender's storeroom to the raider's warehouse. At arrival
`BattleArrivalResolver` calls `resolveLoot` against the **already-settled** defender snapshot
and deducts `taken` inside the *same* version-guarded write that already sets
`troops`/`stationedTroops` — one write per document, `resources.lastCalcAt` untouched so
production is not double-counted — and stores `movement.loot` only when something was actually
taken. On the return leg `MovementReturnHandler` credits it, clamped per resource to the
raider's **own** storage caps, and whatever overflows is lost rather than banked.

**The return handler now settles the home settlement** (`settleSettlementDocUnchecked`, to
`event.dueAt`) instead of loading it raw: loot is credited onto `resources.values` and clamped
against caps, and doing either against a stale figure would be wrong. This also settles home on
every *scout* and *support* return, which is a behaviour change beyond raids — accepted, and
recorded here because it was not asked for: settling earlier is never incorrect (it is exactly
what any command touching the settlement would have done a moment later), it is driven off
`event.dueAt` rather than the wall clock, and no existing scout assertion moved.

**The overflow is reported on the raid's own report, not a new one** — §15 allocates one
`raid`/`assault` report per raid and §6 requires the loss to be visible, so the return handler
adds `lootDelivered`/`lootLost` to the report the arrival already wrote, in the same
transaction. A second report would double every raid in the player's inbox.

**Verification (orchestrator-run).** Full gate from a `pnpm clean` tree: **810 tests**
(game-core 485, server **212** — up from 203 — web 113), lint / typecheck / build green,
prettier clean, no new warnings. The movements integration suite run **three more times end to
end by me: 61/61 each** (the delivery reported five clean runs of its own).

Then a **throwaway probe of five cases**, run against the real app, deleted afterwards:
(1) **a replayed `movementReturn` driven through the real scheduler** — re-arming the very same
event document as `due` and running the scheduler again, which is what a crash between the
handler's commit and the event's `done` mark actually looks like — credits the loot **once**
and brings the army home once. This is the one bug in this step that would have printed free
resources, and the delivery's own replay test called the handler directly, which does not
exercise the scheduler's claim/mark path;
(2) **conservation across the whole round trip** — what the defender lost equals
`lootDelivered + lootLost`, both non-negative, and equals `movement.loot`;
(3) **a target with no Hidden Cache protects nothing** — level 0 is the special case whose raw
curve would otherwise evaluate to ≈148 free protected units per resource for *every settlement
in the world*; asserted live, against a victim deliberately stocked below that number, so the
raid must come home non-empty and the report's `hiddenCacheProtection` must read exactly 0;
(4) **a raid cancelled inside the 90 s window returns clean** — no loot, no arrival report, and
the return handler's "no raid report found" throw does not fire (that throw is reachable
precisely if loot were ever set without a report);
(5) **the clamp uses the raider's own caps** — a raider parked just under the 4000 base cap
ends exactly at cap with the remainder reported lost.

Two of those five failed on their first run and **both failures were mine**: I seeded raiders
with zero Food, so the starvation tick — correctly, per M3a.4 — ate the very army under test
(an army in `awayTroops` still eats), and I assumed a level-1 settlement's storage cap was
small when the base is 4000, so my "overflow" case had no overflow. Both fixtures were wrong,
not the code; fixed and re-run three times clean.

**One hardening item handed to M3c.5b.** The credit computes `delivered = min(cap, stored +
loot) − stored`, which goes **negative** if `stored > cap` — a returning raid would then quietly
shave the settlement back down to its cap and report a negative delivery. It is unreachable
today (production halts at cap, NPC seeding fills to a ratio *of* cap, loot itself clamps), but
M3c.5b is the step that makes a cap *shrink*, so its brief carries the requirement: clamp
stored resources to the new cap inside the destruction transaction (§7 demands it anyway) and
floor `delivered` at zero so the two rules cannot ever disagree.
