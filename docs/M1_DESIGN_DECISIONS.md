# M1 — Economy Core: design decisions required

**Purpose.** `docs/IMPLEMENTATION_PLAN.md` locks the *shape* of the economy but not its
*content*. This document lists everything that must be decided before M1 can be built
without inventing design. It is written to be handed to a stronger model / a design
session: each item states the problem, why it matters, the realistic options, and a
recommended default so the discussion starts from an anchor instead of a blank page.

**Status of every item here: OPEN.** Nothing below has been decided by the orchestrator.

**How to read.** §0 is the one question that unblocks all the numeric ones. §1–§7 are game
design. §8–§12 are decisions that look technical but change what the game *is*, so they
need a product answer. §13–§16 are sequencing problems created by M1 arriving before the
map (M2) and combat (M3). §17 is a summary checklist.

A note on the reference numbers below: classic Travian values are quoted only as *shape*
(growth ratios, curve families), from memory, and must be verified against Kirilloid
before being written into `game-core`. Do not treat any specific number here as authoritative.

---

## 0. THE ANCHOR: what does progression look like over a 3-week round?

**Problem.** Every cost, time and production curve is meaningless without a target
progression. "Levels 1–20, exponential, x5 speed" does not say whether level 20 is
reachable, aspirational, or impossible in 21 days.

**Why it matters.** This single answer determines all ~200 numbers in §2–§4. Decide it
first; everything else becomes arithmetic against it.

**What must be specified:**

- By end of **Act 1 (day 7)**: what does a competent active player have? (e.g. resource
  buildings ~level 8–10, first army, HQ ~level 5)
- By end of **Act 2 (day 14)**: ?
- By **round end (day 21)**: what is the realistic max level? Is level 20 ever reached, or
  is it a theoretical ceiling nobody touches (as in Travian, where top fields hit ~level
  15–18 in a normal-speed round)?
- What does a **casual** player (2 logins/day, no night play) reach vs a **hardcore** one?
  The gap between them is a core fairness decision.
- How much of progression is meant to come from **raiding** vs **own production**? In
  Travian at higher speeds, raiding dominates. Is that intended here?

**Recommendation.** Define three named reference players (Casual / Regular / Hardcore) with
target building levels at day 7 / 14 / 21. Write them into the plan as the balance contract
that `tools/sim` (M4) must reproduce. Without this, M4's balance pass has no pass/fail
criterion.

---

## 1. Resource identity — what are the four resources *for*?

**Problem.** The plan names Scrap, Fuel, Electronics, Food but never assigns them distinct
economic roles. If every building costs roughly equal amounts of all four, then four
resources are decorative complexity — one resource with a x4 multiplier would play
identically.

**Why it matters.** Determines the whole cost matrix, whether the Market is interesting,
and whether trade-offs exist at all.

**Options:**

| Model | Description | Consequence |
|---|---|---|
| A. Symmetric | All buildings cost all four, roughly evenly (Travian's model) | Simple, proven, but resources are interchangeable in feel; Market is about *volume*, not *access* |
| B. Role-based | Scrap = structure/mass, Fuel = vehicles & speed, Electronics = tech/high tiers, Food = upkeep & expansion | Real trade-offs, distinct build orders, Market becomes strategically necessary |
| C. Tiered gating | Electronics only appears in tier-2+ buildings and advanced units | Creates a clear mid-game "unlock" moment |

**Recommendation.** B with a dash of C: Electronics should be scarce and mostly gate the
advanced half of the tech tree, making the Electronics Workshop a deliberate investment
rather than a default. Explicitly write down, per resource, "this is what you spend it on".

**Also decide:** are the four resources produced at equal rates, or is Electronics
intentionally the slowest (making it the bottleneck currency)?

---

## 2. Building cost curves

**Problem.** "Costs exponential, classic Travian curves adapted" is not implementable.

**What must be specified per building (12 buildings):**

- base cost vector at level 1: `{scrap, fuel, electronics, food}`
- growth ratio `k` (Travian uses ≈1.28 for most buildings — verify)
- whether `k` is shared by all buildings or per-building (Travian varies it)
- rounding rule (floor to integer? round to nearest 5?)

**Open sub-questions:**

- Do the four **resource buildings** use a cheaper curve than the "functional" buildings
  (Barracks, Market, Wall …)? In Travian, fields and buildings use different families.
- Is there a **prerequisite tree** (e.g. Machine Shop requires Command Center ≥ 5)? The plan
  calls Command Center "prerequisite hub" but never lists the actual requirements. **This is
  a full dependency graph that must be written out — 12 nodes.**
- Is there a **max-level variance** — do all 12 buildings really go to 20, or do some cap
  lower (Wall at 20, Market at 20, Cold Storage at 20 … ) ?

**Recommendation.** One shared `k` for a first pass, per-building base vectors, everything
in a single constants table so `tools/sim` can sweep it. Do not hand-tune 12 curves before
the simulator exists.

---

## 3. Build time curve, and what "x5 speed" actually multiplies

**Problem.** The plan says "speed ~x5 vs classic Travian" but never defines the scope of
that multiplier. This is ambiguous in a way that changes the game by an order of magnitude.

**Must decide — does x5 apply to:**

- build times? (almost certainly yes)
- resource production rates? (if yes *and* build times are /5, progression is x5; if only
  times are /5, players become resource-starved and the game is a waiting game)
- troop training times?
- troop travel speed on the map? (affects whether raiding is viable — M2/M3, but the
  constant belongs in `game-core` now)
- Food consumption?

**Why it matters.** Getting this wrong makes the round either trivially fast or
permanently resource-starved, and it is very expensive to discover in M4.

**Recommendation.** Define a single explicit `SPEED` config object with a named multiplier
per domain (`build`, `production`, `training`, `travel`) rather than one global x5. Default
them all to 5, but make each independently tunable — the simulator will almost certainly
want them decoupled.

**Also:** how does **Command Center** reduce build time — a percentage per level, or the
Travian-style divisor curve? And is the Engineers' "faster construction" a flat %, a
multiplier on the HQ effect, or an extra queue slot only? (see §6)

---

## 4. Production curve and the Food problem

**Problem A — the curve.** Production per hour per level for the four resource buildings is
undefined. Travian's field output is a specific non-exponential table (roughly ×1.16–1.20
per level, flattening late). Need: base rate at level 1, growth shape, and whether all four
resources share the curve.

**Problem B — Food has no sink in M1.** This is the sharpest design hole I can see.

The plan says Food is consumed by troops, and starvation kills troops. But **troops arrive
in M3**. In M1, the Greenhouse Farm produces a resource that nothing consumes, and Cold
Storage caps a resource that only ever goes up. One of the four resource buildings is
functionally dead for the entire first milestone, and there is no reason to ever build it.

**Options:**

| Option | Description | Cost |
|---|---|---|
| A. Food as a build cost | Buildings cost Food alongside other resources | Simple, immediate purpose, but weakens Food's identity as military upkeep |
| B. Population/upkeep model | Buildings themselves consume Food per hour (Travian's crop-consumption-by-fields model) | Creates real economic pressure from minute one; more formula complexity |
| C. Accept it | Food is inert until M3 | M1 demo feels hollow; playtesting the economy is impossible |
| D. Pull starvation forward | Implement upkeep in M1 with a stub "population" | Extra M1 scope |

**Recommendation.** B, and it is worth the complexity: a settlement whose buildings consume
Food creates the classic "expand vs starve" tension that makes the early game interesting,
and it makes the Greenhouse Farm a real decision. If B is rejected, A is the minimum —
option C should be avoided, because M1's acceptance criterion is "a player can grow a
settlement end-to-end", and a dead resource undermines exactly that.

---

## 5. Storage caps — semantics, not just numbers

**Problem.** "Warehouse caps Scrap/Fuel/Electronics" is ambiguous in an important way.

**Must decide:**

- Is the Warehouse cap **per resource** (Travian: 800 capacity means 800 of *each*) or a
  **shared pool** across the three? These play very differently.
- Cap curve per level, and the level-1 cap (this sets the early-game overflow rhythm).
- **What happens at overflow** — production simply stops (Travian), or is wasted and logged,
  or does it back-pressure somehow? Player-visible behaviour, needs a decision.
- Does Food have a separate cap curve for Cold Storage, or the same one?
- Does anything **protect** resources from raiding (Travian's hidden-treasury / cranny)? The
  plan has no such building among the 12. Without one, small players may be farmed to zero
  permanently once M3 lands. **This may be a missing building.**

**Recommendation.** Per-resource caps (matches Travian intuition and is kinder to new
players), production halts at cap, and seriously consider whether the 12-building list needs
a raid-protection building — that omission is a balance risk for the whole PvP design.

---

## 6. Build queue semantics

**Problem.** "One build queue slot (Engineers: two)" underspecifies the mechanic.

**Must decide:**

- Is it "one build **at a time**" or "one building + a **waiting queue** you can stack"?
  Travian is the former (plus a premium queue, which this project won't have). A no-queue
  design punishes players who cannot log in often — relevant given the audience is ~15
  friends with jobs.
- For Engineers' second slot: is it **free** (any two buildings) or **restricted** (one
  resource building + one other, the Roman model)? Free is strictly stronger and needs a
  compensating cost.
- **Cancellation**: allowed? Refund percentage? Travian refunds fully before completion in
  some versions, partially in others.
- **Demolition**: can buildings be downgraded/destroyed by the owner? Affects schema
  (irreversible level-up vs. reversible) and matters once siege damage exists in M3.
- What happens to a build in progress when the required resources are later stolen in a
  raid? (Nothing — resources are already spent — but confirm.)

**Recommendation.** One active build + a short waiting queue (2 slots) for everyone, because
the target audience is casual friends across time zones; Engineers get a genuinely parallel
second *active* build. This deviates from Travian deliberately and should be a conscious call.

---

## 7. Influence and settlement expansion

**Problem.** "An Influence score (from building levels) gates founding new settlements" — the
formula, the thresholds, and the consumption model are all undefined.

**Must decide:**

- Exact formula. Sum of all building levels? Weighted by building type (Command Center worth
  more)? Non-linear?
- Thresholds for settlement #2 and #3, expressed against the §0 progression targets — i.e.
  *when in the round* should a good player found their second settlement? That is the real
  decision; the number follows from it.
- Is Influence **spent** (consumed on founding) or a **threshold** (permanent gate)?
- Do additional settlements produce Influence too, compounding expansion?
- Soft cap "~3 settlements" — what enforces it: hard block, or escalating cost?

**Sequencing note.** Founding requires settler convoys travelling on the map — that is M2/M3.
So in M1 Influence is a computed number with no consumer. **Decide explicitly whether M1
implements Influence at all**, or defers it to keep M1's scope honest. (Recommendation: put
the *formula* in `game-core` with unit tests — it is pure and cheap — but ship no UI or
gating until M2.)

---

## 8. Base layout — do buildings have positions? (schema-affecting, decide before any code)

**Problem.** The current planned schema is `settlements.buildings[{type, level}]` — a flat
list with no position. But `art/reference/mockup_ui_pixel.png` shows a **spatial isometric
base** with buildings placed on a grid, and the plan calls the mockup "binding for style AND
layout".

**These two are incompatible.** If the base screen is spatial, buildings need slots.

**Must decide:**

- Is the base a **list/grid of cards** (simple, mobile-friendly, fast to build) or a
  **spatial isometric scene** (matches the mockup, far more art- and code-expensive)?
- If spatial: how many building slots does a settlement have? Are slots typed (resource
  slots vs building slots, as in Travian)? Can players choose placement, or is placement
  automatic/cosmetic?
- Can there be **multiple instances** of the same building type (Travian allows several
  warehouses)? The current schema shape implies one-per-type. This is a real gameplay
  decision — multiple warehouses is a classic Travian strategy.

**Why it matters now.** Adding `slot` and multi-instance support to the schema later means
migrating every settlement document, and MongoDB 3.6 without transactions makes migrations
more painful. **Decide before M1 writes the schema.**

**Recommendation.** Ship M1 with a list-based UI (honest about missing art) but design the
schema *as if* spatial: `buildings: [{ id, type, level, slot }]` with a fixed slot count.
Costs nothing now, avoids a migration later.

---

## 9. Balance constants must be config-driven, not hardcoded (architecture-affecting)

**Problem.** `tools/sim` (M4) exists to sweep balance parameters across whole simulated
rounds. If `game-core` formulas import hardcoded constants directly, sweeping requires
editing source between runs — the simulator becomes nearly useless.

**Decision needed:** do `game-core` formulas take an injected `GameConfig` object
(`calcBuildCost(config, type, level)`), or read module-level constants
(`calcBuildCost(type, level)`)?

**Trade-off.** Injection is slightly more verbose everywhere and touches every signature;
module constants are cleaner to call but effectively unswept. Retrofitting injection later
means rewriting every formula signature and every call site in server, web and sim.

**Recommendation.** Injected config from day one, with a `DEFAULT_CONFIG` export so normal
call sites stay short. Also version the config (`configVersion`) and store it on the
`seasons` archive, so past rounds remain interpretable after rebalancing.

---

## 10. Determinism, rounding and units

**Problem.** `game-core` is shared by server and client precisely so they never disagree. Any
undefined rounding is a place where the client's preview differs from the server's result — a
visible bug class, and a trust problem in a PvP game.

**Must decide and document once:**

- Are stored resources **integers or floats**? (Recommendation: store as float, display
  floored — or store integers and accumulate fractional remainder. Must be one rule.)
- Rounding for costs, times, production: floor / round / ceil — specified per formula.
- Time unit everywhere: milliseconds (matches `Date.now()` and the existing `msUntil`
  helpers) — confirm and never mix seconds in.
- Are production rates **per hour** internally (Travian convention) while time is in ms?
  Define the canonical unit and convert at the edges only.
- What is the **rounding of the lazy resource formula** at the storage cap, and does
  overflow-time need to be computed exactly (for "warehouse full in 02:14" UI)?

**Recommendation.** Write a short "numeric conventions" section into the plan and enforce it
with unit tests in `game-core` — this is cheap now and expensive later.

---

## 11. Concurrency without transactions (the most important technical decision in M1)

**Problem.** MongoDB 3.6, no multi-document transactions. Starting a build means: compute
lazily-accrued resources → verify affordability → deduct → append to queue → schedule an
event. If two requests race (double-tap on mobile, or a player and their NPC-like automation),
a naive implementation double-spends.

**Why it is a design decision, not just an implementation detail.** The chosen pattern will
be copy-pasted into every subsequent feature — troop training, market trades, troop
movements, combat resolution. Getting it right once is worth real thought; getting it wrong
propagates through M2–M5.

**Must decide:**

- The canonical **optimistic-concurrency pattern**: `findOneAndUpdate` with a filter that
  encodes the precondition (expected `version`, and resource levels sufficient *as of*
  `lastCalcAt`), retried on mismatch. Exact shape needs to be written down and reused.
- Where lazy resource settlement happens: is `{values, lastCalcAt}` **materialised** on every
  mutation (recommended — makes the affordability check expressible as a filter), or computed
  on read only?
- Idempotency keys for **event handlers**: a build-completion event must be safe to process
  twice (crash between "apply" and "mark done").
- **Stuck `processing` events**: if the process dies mid-handler, the event is stranded.
  Needs a lease/timeout and a recovery sweep — decide the policy now.
- Ordering: can two events for the same settlement be processed concurrently? (Single process
  today — but the answer should be "handlers are safe regardless".)

**Recommendation.** Materialise resources on every write, express affordability as part of the
`findOneAndUpdate` filter, give every event an idempotency guard, and add a
`processingStartedAt` lease with a recovery sweep. Write this up as a short "concurrency
playbook" doc that every later milestone follows.

---

## 12. Event scheduler semantics

**Problem.** The plan describes the loop (poll `{status:'due', dueAt:{$lte:now}}`, dispatch,
mark done) but not its behaviour under stress or failure.

**Must decide:** poll interval (1s stated — confirm under ~150 NPCs); what happens to events
that are **overdue** because the server was down for hours (replay in order? collapse?
fast-forward?); retry policy and dead-letter handling for handlers that throw; whether
events carry a **version** so a payload schema change doesn't break in-flight events across a
deploy. The "server was offline" case matters: this is a 1-core VPS, and a restart during a
21-day round is certain.

---

## 13. Auth: Telegram Login in local development

**Problem.** Telegram Login Widget requires a bot token and a **domain bound to the bot** —
there is no such domain on `localhost`. The plan allows "guest login in dev mode only", which
implies TG auth is only ever testable on the VPS.

**Must decide:** is TG auth genuinely untested until M7 deploy, or do we tunnel
(ngrok/cloudflared) to test earlier? Who owns the bot token and how is it injected (env, never
committed)? What is the account identity key across rounds (`tgId`)? Are dev guest accounts
wiped between rounds, and can they coexist with real accounts in one world?

**Session strategy** is also open: JWT vs server-side session cookie. On a single-process
1-core VPS either works; JWT avoids a session store, a cookie is easier to revoke.

**Recommendation.** Guest auth for all of M1–M6, TG auth implemented behind the same service
interface and smoke-tested once on the VPS before M7. Do not let auth block economy work.

---

## 14. Where does a settlement live before the map exists? (sequencing)

**Problem.** M1 creates settlements. The world map, terrain and spawn placement are M2. A
settlement has `x, y` in the schema with nothing to assign them.

**Must decide:** does M1 assign placeholder coordinates (e.g. a deterministic spiral from the
centre) that M2 later replaces, or does M1 ship without coordinates and M2 backfills them?

**Recommendation.** Assign real coordinates in M1 using a trivial placement rule, keeping the
schema final and letting M2 replace only the *placement policy*. Avoid a nullable `x/y`.

---

## 15. i18n structure

**Problem.** RU is default, all strings behind keys, EN later — but no key scheme exists, and
M0 left hardcoded Russian strings in `App.tsx` that must migrate.

**Must decide:** namespace layout (`common`, `buildings`, `resources`, `errors` …); key naming
convention; where **building/unit display names and descriptions** live (they must NOT live in
`game-core` — it is pure logic and must stay display-free, so it exposes stable ids and the
client maps id → key); how **server-generated messages** (battle reports, error messages) are
localised — does the server send keys + params rather than text? (It should.) Also: RU
pluralisation rules (RU has 3 plural forms — i18next handles it, but the keys must be authored
for it), and number/date formatting conventions.

**Recommendation.** Server returns keys + params, never prose. This decision is cheap now and
almost impossible to retrofit once reports exist in M3.

---

## 16. M1 scope — it is currently too large

**Observation.** M1 as written bundles: Mongo schemas + lazy resources + 12 buildings with
full curves + build queue on the event scheduler + storage caps + Influence + Telegram/guest
auth + the Base screen UI + the i18n scaffold. That is several milestones of work by the
plan's own "30–90 minute step" standard, and the acceptance criterion ("a player can grow a
settlement end-to-end") only needs a subset.

**Recommendation — split M1 explicitly:**

- **M1a — Economy foundations:** Mongo connection + schemas, the concurrency playbook (§11),
  lazy resources, storage caps, event scheduler wiring, all formulas in `game-core` with unit
  tests. No UI beyond what proves it.
- **M1b — Auth & account lifecycle:** guest auth, registration, faction choice, settlement
  creation, placeholder placement (§14).
- **M1c — Base screen & i18n:** the building list UI, build queue UI, live resource bar,
  i18n scaffold + migration of M0's hardcoded strings.

Defer to later milestones: Influence gating (§7), Market functionality (needs M2 movement),
starvation (unless §4 option B/D is chosen).

---

## 17. Checklist

Blocking for M1 — cannot start without answers:

- [ ] §0 progression targets (day 7 / 14 / 21, casual vs hardcore)
- [ ] §1 resource roles
- [ ] §2 cost curves + **building prerequisite graph**
- [ ] §3 what x5 multiplies, per domain
- [ ] §4 production curve + **the Food sink problem**
- [ ] §5 storage cap semantics + **is a raid-protection building missing?**
- [ ] §6 queue semantics (single build vs stacked queue)
- [ ] §8 **building slots / multi-instance — schema-affecting, decide first**
- [ ] §9 **config injection — architecture-affecting, decide first**
- [ ] §10 numeric conventions
- [ ] §11 **concurrency playbook — decide first**
- [ ] §16 M1 split

Shapes M1 but can be decided during it:

- [ ] §7 Influence formula and thresholds
- [ ] §12 scheduler failure semantics
- [ ] §13 auth strategy and session model
- [ ] §14 placeholder placement rule
- [ ] §15 i18n key scheme + server-returns-keys rule

**Three items are worth deciding before a single line of M1 is written**, because retrofitting
them is expensive: §8 (building slots in the schema), §9 (config injection through every
formula signature), and §11 (the concurrency pattern that every later feature will copy).
