# M1 — Economy Core: design decisions (RESOLVED)

**Status: every item below is DECIDED** — settled with the owner in the design session of
2026-08-15 (two-round structured Q&A over the original open-questions version of this
file). This document is now the **binding design record for M1**; `IMPLEMENTATION_PLAN.md`
has been updated to match. If the two ever disagree, this file wins for M1 scope.

**Numbers vs shapes.** Curve *shapes* and mechanics are final. Specific *numbers* (base
cost vectors, growth ratios, production rates, Influence thresholds) are first-pass
drafts: they must be sanity-checked against Kirilloid where a Travian analog exists,
written into `game-core` as an injectable config (§9), and tuned by `tools/sim` in M4
against the §0 contract. No number below is sacred; every shape is.

---

## 0. Progression contract (the anchor)

Three named reference players form the **balance contract**. `tools/sim` (M4) must
reproduce these trajectories; they are the pass/fail criterion for every balance pass.

| | Day 7 (end of Act 1) | Day 14 | Day 21 (round end) |
|---|---|---|---|
| **Casual** (2 logins/day, no night play) | resource buildings ~6–8, CC 4–5, Barracks unlocked | resource ~9–11, settlement #2 ~day 13–15 | top resource ~12–13, 2 settlements |
| **Regular** (4–6 logins/day) | resource ~8–10, CC 5–6, first oasis raids | resource ~12–13, settlement #2 ~day 10–11 | top resource ~15–16, 2–3 settlements |
| **Hardcore** (near-constant, farms NPCs) | resource ~10–11, active raiding | resource ~14, settlement #3 ~day 16–18 | top resource ~17–18, 3 settlements |

Fairness rules (fixed, not tunable):

- **Level 20 is a theoretical ceiling.** Nobody reaches it in a round except possibly one
  "showcase" building for a hardcore player.
- **Hardcore economy ≤ ~2–2.5× casual** by day 21. Raid share of income: hardcore
  ~40–50%, casual ~10%. Raiding dominating for hardcore is intended (Travian DNA); the
  cap on the gap is enforced via Hidden Cache, NPC defenses, and protection rules.

## 1. Resource roles

**Model B + element of C** (role-based + tier gating):

| Resource | Role — "what you spend it on" | Production |
|---|---|---|
| Scrap | Mass & structures: the bulk of every building/unit cost | Normal |
| Fuel | Vehicles & speed: Machine Shop units, movement-related costs | Normal |
| Electronics | Tech gate: Machine Shop, Radio Tower, high building levels, advanced units | **Deliberately slowest — the bottleneck currency** |
| Food | Upkeep & expansion: in every build cost + hourly upkeep (§4) | Normal |

Electronics gates the upper half of the tech tree, making Electronics Workshop a
deliberate investment and the Market strategically necessary (access, not just volume).

## 2. Cost curves & prerequisite graph

- **Two curve families**, as in Travian: resource buildings = cheap base / steep growth
  (Travian fields ≈ ×1.67/level — verify vs Kirilloid); functional buildings = dearer
  base / flatter growth (≈ ×1.28 — verify).
- **Shared growth ratio `k` per family** for the first pass; per-building `k` only if the
  simulator demands it. Base cost vectors are per-building, expressing the §1 roles.
- **Level caps:** all buildings 1–20, except **Hidden Cache 1–10**.
- All constants live in one config table (§9) so `tools/sim` can sweep them.

**Prerequisite graph (13 buildings; CC = Command Center, exists at L1 on settlement
creation):**

| Building | Requires |
|---|---|
| Scrap Yard, Fuel Refinery, Greenhouse Farm | — |
| Warehouse, Cold Storage, Hidden Cache | — |
| Wall | CC 1 |
| Barracks | CC 3 |
| Market | CC 3, Warehouse 3 |
| Electronics Workshop | CC 3 |
| Machine Shop | CC 5, Barracks 3, Fuel Refinery 5 |
| Radio Tower | CC 5, Electronics Workshop 3 |

Logic: week one is resources and defense; Electronics and vehicles are a conscious
mid-game unlock; Machine Shop is additionally tied to Fuel (vehicle resource, §1).
The level numbers are config knobs.

## 3. Speed model

Base tables are authored at **classic x1**; speed is applied on top via an explicit
`SPEED` config object with **independent per-domain multipliers**:

```
SPEED = { build: 5, production: 5, training: 5, travel: ~2–3 }
```

`travel` is lower and tuned to the locked "2–4 h across half the map" — the 61×61 map is
small, full ×5 movement would erase geography. Each knob is independently sweepable by
the simulator. Command Center reduces build time via a Travian-style divisor curve
(verify shape vs Kirilloid); the Engineers' faction bonus is their second active build
slot (§6), not a stacking time modifier.

## 4. Food: build cost + upkeep (full Travian model)

**Both A and B — as Travian actually works:**

- Food is part of **every building's build cost** (the 4th resource in every cost vector).
- **Every building level consumes Food per hour** (upkeep). Net Food production =
  Greenhouse output − Σ building upkeep − troop upkeep (troops from M3).
- An upgrade that would push net Food production **negative is blocked** (Travian-style
  free-crop gate). Buildings never starve; starvation only ever kills troops (M3,
  weakest first).

This kills the "dead resource in M1" problem completely: the Greenhouse Farm is a real
decision from minute one, and the classic expand-vs-starve tension exists before combat.

**Starting composition of a settlement (decided 2026-08-16, after M1 shipped).** A new
settlement is created with the **Command Center at level 1 and nothing else**. Since the
Command Center has Food upkeep and nothing produces Food yet, a fresh settlement is
net-negative on Food, so the gate above makes the **Greenhouse Farm the only legal first
build**. That is intended, not a gap: "secure food first" is the authentic Travian opening
and it teaches the upkeep rule by making the player feel it. The gate stays **absolute**
(blocking any result that is net-negative), not relative — a relative gate would let a player
dig the hole deeper. Recorded because the emergent single-choice opening is a consequence
worth owning deliberately; the alternatives considered were starting with a Greenhouse L1 and
making the gate relative, both rejected.

## 5. Storage

- Two storage buildings, as in Travian and the plan: **Warehouse** (Scrap/Fuel/
  Electronics) and **Cold Storage** (Food).
- Warehouse cap is **per resource**: cap 800 = 800 of *each* of the three.
- **Production halts at cap** — nothing accrues past it, nothing is wasted retroactively.
  Overflow-time ("full in 02:14") must be computable exactly for the UI (§10).
- **Hidden Cache added as the 13th building** (cranny analog): hides N of each resource
  from raids, N grows per level, cheap, no prerequisites, cap level 10. In M1 it is just
  another row in the constants table; its protective effect activates with combat in M3.
  Rationale: without it, small players can be farmed to zero permanently once M3 lands —
  unacceptable for a 15-friends casual world.

## 6. Build queue

- **One active build + a 2-slot waiting queue, for everyone.** Deliberate deviation from
  Travian: the audience is casual friends across time zones.
- **Engineers**: a second genuinely **parallel active** build (their faction identity),
  on top of the shared waiting queue.
- Resources are **deducted at enqueue** (atomic, predictable, one concurrency pattern).
- **Cancellation refunds 100%** (simplicity; no exploit surface in M1 — revisit if combat
  creates one).
- **No owner demolition/downgrade in v1.** Schema stays append-only per level except for
  M3 siege damage.
- Resources stolen in a raid never affect an in-progress build (already spent).

## 7. Influence

- **Formula: static weighted sum** of building levels across **all** the account's
  settlements; Command Center weighted **×3**, everything else ×1. Pure function in
  `game-core` with unit tests.
- **Threshold, not spent** — a permanent gate (Travian culture-point style), easy to show
  the player "how much is missing".
- **Hard cap: 3 settlements** per account per round in v1.
- Thresholds calibrated to the §0 contract: settlement #2 reachable by a Regular player
  ~day 10–11 (Casual ~day 13–15); settlement #3 realistically hardcore-only, ~day 16–18.
- **M1 ships the formula + tests only.** No UI, no gating until M2 (founding needs settler
  convoys, which need the map).

## 8. Base layout & settlement schema

- M1 UI is a **list/cards** presentation (honest about missing art), but the schema is
  **spatial-ready from day one**:

```
buildings: [{ id, type, level, slot }]   // fixed 16 slots per settlement
```

- **One instance per building type in v1** (multi-instance off — simpler balance and UI).
  The per-building `id` makes enabling multi-instance later a config change, not a data
  migration.
- Slot assignment is automatic/cosmetic in M1; a spatial base screen can reuse the same
  data later without touching documents.

## 9. Config injection

- Every `game-core` formula takes an injected config: `calcBuildCost(config, type, level)`.
- `DEFAULT_CONFIG` is exported so normal call sites stay short.
- The config carries a **`configVersion`**, stored on each `seasons` archive entry so past
  rounds remain interpretable after rebalancing.
- This is what makes `tools/sim` (M4) able to sweep parameters without editing source.

## 10. Numeric conventions

- Resources stored as **float**, displayed **floored**. (IEEE 754 is deterministic and
  identical in Node and browsers — client preview and server result cannot drift.)
- Time is **milliseconds everywhere** internally; production rates are **per hour**
  internally; conversion at the edges only.
- Costs: **round to nearest integer**. Build/training times: **ceil to whole seconds**.
- Overflow/ETA times (e.g. "warehouse full in 02:14") computed exactly from the lazy
  formula, same rounding on both sides.
- These rules live as a short "numeric conventions" section enforced by unit tests in
  `game-core`.

## 11. Concurrency playbook (MongoDB 7)

**Context.** MongoDB 7+ on a single-node replica set — multi-document transactions are
available and are the chosen mechanism for multi-step flows. Transactions give atomicity,
but not by themselves race-safety (two transactions can both read "enough resources"
before either commits) nor crash-safety of event processing. Hence the playbook:

- **Command pattern:** every command (start build, later: train, trade, move) runs inside
  a transaction; within it, the settlement mutation is a **version-guarded
  `findOneAndUpdate`** (expected `version` + affordability in the filter) so racing
  transactions conflict and retry instead of double-spending.
- **Resource settlement:** `{values, lastCalcAt}` is **materialised at the start of every
  command transaction** (one canonical "settle" step), never computed-on-read-only.
- **Event processing:** claim (`due` → `processing` with `processingStartedAt`) → handle,
  with the handler's effects + the `done` mark committed in **one transaction**. Handlers
  stay **idempotent** anyway: a crash between claim and commit must be safely replayable.
- **Stuck events:** `processingStartedAt` lease with a timeout + a recovery sweep that
  returns expired `processing` events to `due`.
- **Ordering:** single process today, but handlers must be safe under concurrent
  processing of same-settlement events regardless.

This is written up as a standalone **concurrency playbook doc during M1a**; every later
milestone (training, trades, movements, combat) copies it verbatim.

## 12. Scheduler failure semantics

- **Overdue events after downtime** (a restart during a 21-day round on the 1-core VPS is
  certain): replay strictly in **`dueAt` order** with their original timestamps — lazy
  resources make catch-up cheap, and arrivals resolve correctly "in the past". No
  collapsing, no fast-forward.
- **Handler throws:** retry with backoff ×3, then `status: 'failed'` (dead-letter) + log.
- Every event payload carries a schema **version field** so a deploy never breaks
  in-flight events.
- Poll interval: **1 s** (fine for ~150 NPCs ≈ 0.2 events/s).

## 13. Auth & sessions

- **Guest auth for all of M1–M6.** Telegram Login implemented behind the **same service
  interface** and smoke-tested once on the VPS before M7 — auth never blocks economy work.
- **Sessions: httpOnly cookie + server-side session stored in Mongo** (easy to revoke;
  Mongo is there anyway). No JWT.
- Cross-round identity key: **`tgId`**. Dev guest accounts are flagged and wiped on round
  end; they may coexist with real accounts in a dev world only.
- Bot token: owned by the user, injected via env, **never committed** (committed samples
  contain placeholders only).

## 14. Settlement placement before the map

- M1 assigns **real coordinates from day one** via a trivial deterministic rule on the
  outer ring (matching the locked "humans spawn in the outer ring"). No nullable `x/y`.
- M2 replaces only the *placement policy* (terrain-aware), never the schema.

## 15. i18n

- **The server returns i18n keys + params, never prose** — for errors and (from M3)
  reports. Impossible to retrofit later; decided now.
- Namespaces: `common`, `buildings`, `resources`, `units`, `errors`, `reports`.
- `game-core` stays display-free: it exposes stable ids only; the client maps id → key.
- RU is default (3 plural forms — keys authored for i18next pluralisation); M0's
  hardcoded RU strings in `App.tsx` migrate in M1c.

## 16. M1 split

- **M1a — Economy foundations:** Mongo 7 + schemas, concurrency playbook (§11), lazy
  resources incl. Food upkeep (§4), storage caps (§5), event scheduler (§12), all 13
  buildings' formulas + Influence formula in `game-core` behind injected config, unit
  tests. UI only as far as needed to prove it.
- **M1b — Auth & account lifecycle:** guest auth + sessions (§13), registration, faction
  choice, settlement creation with outer-ring placement (§14).
- **M1c — Base screen & i18n:** building list UI on the spatial schema (§8), build queue
  UI, live resource bar, i18n scaffold + M0 string migration (§15).

Deferred out of M1: Influence UI/gating (M2), Market functionality (M2 — needs movement).
Food upkeep is **in** M1a (it is part of the production formula, not extra scope).

## 17. Checklist — all resolved

- [x] §0 progression contract (three reference players, fairness rules)
- [x] §1 resource roles (B+C, Electronics bottleneck)
- [x] §2 curve families + prerequisite graph + level caps
- [x] §3 per-domain SPEED over x1 base tables
- [x] §4 Food = build cost + hourly upkeep, upgrades gated on net Food
- [x] §5 per-resource caps, halt at cap, Hidden Cache added (13th building)
- [x] §6 one active + 2 waiting; Engineers parallel; deduct at enqueue; 100% refund
- [x] §7 Influence: static weighted sum, threshold, hard cap 3, M1 formula-only
- [x] §8 spatial-ready schema `{id, type, level, slot}` ×16, list UI, single-instance
- [x] §9 injected `GameConfig` + `DEFAULT_CONFIG` + `configVersion`
- [x] §10 numeric conventions
- [x] §11 concurrency playbook on Mongo 7 transactions
- [x] §12 scheduler: dueAt-order replay, 3 retries → dead-letter, payload version, 1 s
- [x] §13 guest-first auth, cookie + Mongo session, `tgId`
- [x] §14 real outer-ring coordinates from M1
- [x] §15 server returns keys+params; namespaces; id-only game-core
- [x] §16 M1a / M1b / M1c split

**Follow-up work owned by the agent (before/during M1a), no user decisions required:**
draft the numeric constants tables (base cost vectors, production rates, upkeep values,
Influence weights/thresholds) as arithmetic against the §0 contract; verify curve shapes
against Kirilloid; write the standalone concurrency playbook doc.
