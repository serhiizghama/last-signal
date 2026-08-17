# Last Signal — Implementation Plan

A browser-based, mobile-first, real-time strategy game inspired by classic Travian mechanics,
re-themed as a post-apocalyptic world. Players (and indistinguishable NPC accounts) develop
settlements, raid each other, pick a global side — **Beacon** or **Silence** — and fight over
the **Signal Source** that surfaces in the heart of the settled world in a 3-week seasonal
round.

Solo pet project, portfolio-grade quality. No monetization, ever.

---

## 1. Locked decisions

| Topic | Decision |
|---|---|
| Audience | Self + ~15 friends per world; public GitHub repo, CI, version tags |
| Platform | Mobile-first web app; architecture ready for a Telegram Mini App wrapper later |
| World size | 61×61 grid (3,721 tiles), ~150 total accounts (~15 human + ~135 NPC) |
| Round | 3 weeks; three acts; full world wipe at the end. Speed: base curves at classic x1, per-domain `SPEED` multipliers on top (`build`/`production`/`training` = 5, `travel` = 2 — pinned draft, config knob, tuned to "2–4 h across half the map"; see `docs/M2_DESIGN_DECISIONS.md` §0) |
| Persistence across rounds | Account keeps history, medals, past-season contribution ratings |
| Factions (race analog) | Raiders (cheap mass army), Engineers (expensive strong units, fast builds), Nomads (fast, defensive) |
| Resources | Scrap, Fuel, Electronics, Food. Role-based (Scrap = mass/structures, Fuel = vehicles/speed, Electronics = scarce tech gate, Food = upkeep/expansion). Food is in every build cost AND consumed hourly by building levels + troops; troop starvation kills (weakest first) |
| Sides (global war) | **Beacon** (answer the alien Signal) vs **Silence** (silence it forever). Chosen at registration, switchable with 48h cooldown; switching resets personal contribution score |
| Victory | King-of-the-hill over the Signal Source: both sides accumulate hold-time toward their goal; first to target wins, else larger accumulation at round end |
| PvP | Full PvP (anyone can attack anyone, incl. own side). Raids + building destruction. **No village capture in v1** |
| NPCs | Full game accounts, indistinguishable from humans, play by identical rules via the same service layer. Behavior profiles + scheduled ticks |
| Content scope | 13 building types, 5 units per faction + a faction-neutral Settler and two wildlife defender types (16 trainable unit types in total; the two wildlife types are never trainable — see `docs/M3_DESIGN_DECISIONS.md` §1) |
| Stack | TypeScript monorepo: NestJS backend + React/Vite frontend + shared `game-core` package |
| Database | MongoDB 7+ (single-node replica set; **multi-document transactions available and used**). Custom event scheduler collection, no Agenda/Redis |
| Auth | Telegram Login (+ guest login in dev mode only) |
| Notifications | Telegram bot: incoming attack, build queue finished (toggleable) |
| i18n | RU default, all strings through i18n keys, EN later |
| Hosting | Existing VPS (1 core, 2 GB RAM, Ubuntu 20.04), pm2, Caddy reverse proxy |
| Art | Warm 16-bit pixel art generated via ChatGPT; pipeline in `docs/ASSET_PROMPTS.md`; the mockups in `art/reference/` are the art & UI reference |

Out of scope for v1: village capture/loyalty, heroes & items, artifacts, clans/alliances
(sides fill that role), premium features, sounds, PWA/TMA packaging, MongoDB migration
(tracked separately outside this project).

---

## 2. Game design

### 2.1 Lore

Decades after the Collapse, survivors intercept a repeating extraterrestrial transmission —
the Signal — coming from a colossal crashed antenna array in the heart of the wasteland.
**Beacon** believes answering it will summon salvation. **Silence** believes whoever answered
it last time caused the Collapse — and wants the antenna dead. Both sides are sincerely
saving the world. Neither is the villain.

### 2.2 Factions

Any faction can join either side.

| | Raiders | Engineers | Nomads |
|---|---|---|---|
| Identity | Cheap, fast-trained mass army; aggression | Expensive, powerful units; faster construction | Fast movement; strong defense; efficient scouts |
| Analog | Teutons | Romans | Gauls |
| Emblem | Red skull flag | Blue gear flag | Green bull flag |

Units per faction (5 roles each — stats live in `game-core` constants, tuned via simulation):

| Role | Raiders | Engineers | Nomads |
|---|---|---|---|
| Offense infantry | Brute | Exo-Trooper | Skirmisher |
| Defense infantry | Torcher | Bulwark | Hunter-Sniper |
| Fast (cavalry analog) | Biker | Armored Quad | Dune Buggy |
| Scout | Lookout | Surveyor Drone | Falconer |
| Siege | Ram Truck | Rail Sling | Ballista Wagon |

Plus a 16th unit shared by all three factions: the **Settler**, trained at the **Command
Center** (not the Barracks — that is exactly why it lives there), consumed three at a time
to found a new settlement. Farm oases are held by two **wildlife** defender types (Feral
Dog, Scavenger Gang) that no account can train. Full stats: `docs/M3_DESIGN_DECISIONS.md` §1.

### 2.3 Resources & economy

- Four resources with distinct roles: **Scrap** (mass/structures), **Fuel** (vehicles &
  speed), **Electronics** (scarce, slowest-produced; gates the upper half of the tech
  tree), **Food** (upkeep & expansion).
- Food works as in Travian, both ways: it is part of every building's build cost AND
  every building level consumes Food per hour (upkeep). Net Food production =
  Greenhouse output − building upkeep − troop upkeep. An upgrade that would push net
  Food negative is blocked; buildings never starve — negative Food balance starves
  troops only (weakest die first, M3).
- Production comes from four resource buildings inside the settlement. No separate field
  ring (simplification vs Travian): resource buildings are regular buildings.
- Lazy evaluation: `current = stored + rate × (now − lastCalcAt)`, capped by storage.
  Nothing ticks in the background.
- Warehouse caps Scrap/Fuel/Electronics **per resource** (cap N = N of each); Cold
  Storage caps Food. Production halts at cap (nothing is wasted retroactively).
- Market (M3, both halves): **player↔player offers** at limited exchange ratios (an offer
  must stay inside a 1:2 weighted-value band), and a faceless **world exchange post** that
  converts one resource into another at a fixed weighted rate with a spread — it cannot
  print value, so it needs no cap or cooldown. No named NPC counterparties before M4.
  **Merchants are not trained units**: a settlement's merchant count is derived from its
  Market level, and merchants travel on the map like armies (capacity and speed are
  faction-flavoured). Detail: `docs/M3_DESIGN_DECISIONS.md` §14.

### 2.4 Buildings (13 types)

| Building | Purpose |
|---|---|
| Command Center | Build speed; prerequisite hub (HQ); trains Settlers |
| Scrap Yard | Scrap production |
| Fuel Refinery | Fuel production |
| Electronics Workshop | Electronics production |
| Greenhouse Farm | Food production |
| Warehouse | Scrap/Fuel/Electronics storage cap |
| Cold Storage | Food storage cap |
| Barracks | Trains infantry & scouts; level reduces training time |
| Machine Shop | Trains vehicles (fast + siege units); level reduces training time |
| Wall | Defense bonus; must be breached by siege |
| Market | Trading, merchants |
| Radio Tower | Scouting ops, intel level, incoming-attack visibility detail |
| Hidden Cache | Cranny analog: hides N of each resource from raids (effect active from M3) |

Levels 1–20 (Hidden Cache: 1–10), costs/times exponential — two curve families as in
Travian (resource buildings: cheap base / steep growth; functional buildings: dearer
base / flatter growth), shared growth ratio `k` per family for the first pass, verified
against Kirilloid. Prerequisite graph and per-building base cost vectors live in
`docs/M1_DESIGN_DECISIONS.md` §2.

Build queue: **one active build + a 2-slot waiting queue for everyone** (deliberate
deviation from Travian — the audience is casual friends across time zones); Engineers
get a second *parallel active* build. Resources are deducted at enqueue; cancellation
refunds 100%; no owner demolition in v1.

Settlement expansion: an **Influence** score (static weighted sum of building levels
across all settlements, Command Center weighted ×3) is a permanent threshold (not
spent) gating founding new settlements with settler convoys; hard cap 3 settlements
per account per round in v1.

### 2.5 Map & world

- 61×61 grid, **bounded** (coordinates −30..30, no wrap-around); the distance metric is
  **Chebyshev** (`d = max(|dx|, |dy|)`). Terrain: wasteland variants, ruined city, dead
  forest, toxic lake, broken highway, rocky hills — derived from the world seed, cosmetic
  in v1 with one exception: toxic lake tiles cannot host a settlement.
- **Signal Source**: no location until the Act 2 reveal, which places it at a computed
  balanced point (roughly the population-weighted middle of the settled world). The
  placement algorithm, the reveal event and what the tile blocks are owned by M5; until
  then `world.source` is null and the map centre is ordinary, settleable terrain.
- **Farm oases**: NPC-held surviving farms scattered on the map — raid targets with
  Food loot (**not annexable in v1**, no ownership, no bonus to a nearby settlement).
  Placed at world generation, inert in M2. From **M3** each oasis carries **wildlife
  defenders** (composition derived deterministically from the world seed and the oasis
  coordinates) and a **Food pool that regenerates lazily**, and can be raided, assaulted
  and scouted (M3 record §10).
- **Spawn — one policy for everyone:** a settlement is placed at random inside an annulus
  of Chebyshev radius that expands from the centre outwards as the world fills
  (Travian-style ring growth). NPCs are seeded through this same policy first, at world
  start, so humans registering later land in the outer band as an emergent property
  rather than a special rule.
- Travel time = distance / unit speed (slowest unit in the army), ~2–4 h across half
  the map for average units. **Siege units (speed 3–4) sit deliberately outside that
  band** — 3 h 45 m – 5 h across half the map — because slow siege is what makes an
  assault a planned operation rather than an impulse. This is an explicit extension of the
  M2 §0 travel contract, not a violation of it (M3 record §0, bound 4).

### 2.6 Combat

Adapted classic Travian battle system (public Kirilloid formulas as the base), simplified.
The model below is **resolved** in `docs/M3_DESIGN_DECISIONS.md` §5–§7, which wins over
this section for M3 scope:

- **Points vs points, T3.6 shape.** `atkPts = Σ (attack × count)` over the arriving army;
  `defPts` = the defenders' infantry/cavalry defence weighted by the *attacker's own*
  infantry/cavalry attack split, summed over every defending contingent (the target's own
  home troops plus every stationed support contingent — troops that are away do not
  defend). No morale, no bash points.
- **The Wall is a multiplier** on `defPts` (`ratioPerLevel ** wallLevel`), no flat bonus,
  no per-faction wall.
- **A deterministic ±5 % roll** on `atkPts`, derived from `hash(world.seed, movementId)` —
  **never a wall-clock random**: battle resolution runs inside a replay-safe scheduler
  handler and inside `tools/sim`, so a crash-replay must produce the battle the report
  already described.
- **One shared casualty curve for the whole game**: `x = min(1, (defPts/atkPts) ** 1.5)` —
  the same constant and curve family already shipped for scout-vs-scout in M2, promoted to
  `config.combat.lossExponent`. Losses round to the nearest whole unit and are distributed
  proportionally across unit types; defender losses are split across contingents
  proportionally to each contingent's contribution to `defPts`.
- Attack types differ in exactly three things — casualties, siege, and whether the wall
  must fall: **Raid** (attacker loses `x/(1+x)`, defender loses `1/(1+x)`, no siege units
  allowed — a genuinely partial engagement) and **Assault** (attacker loses `x`, defender
  loses everything, siege pass runs). Both loot up to surviving carry capacity.
- **Loot** = `Σ (carry × surviving count)`, taken from what the Hidden Cache does not
  protect (`base × ratio ** (level − 1)`, **per resource**), distributed proportionally to
  availability so a raider cannot cherry-pick Electronics. Loot rides home on the movement
  and is credited on return, clamped to the attacker's storage caps.
- **Siege pass (assault only):** the **Wall is always breached first**; only once it is at
  0 do building-damage points go to the named target building. Knocking one level off level
  `L` costs `base × ratio ** (L − 1)` points; leftovers are discarded, never carried over.
- **No razing, no capture.** Every building can be knocked to 0 and rebuilt, but the
  **Command Center floors at level 1** — a settlement always survives.
- Scouting: scout-vs-scout resolution; report shows resources, troops, buildings
  depending on Radio Tower differential. Resolved detail (M2 record §8): attacker
  losses follow a 1.5-power casualty curve `min(1, (defPts/atkPts)^1.5)`, defender
  scouts never die on defence; the base report always carries the target's resources,
  storage caps and home troop counts, and a Radio Tower differential ≥ 1 adds the
  building list; the defender gets a counter-report only if they had a scout at home;
  a mission that loses every scout still returns an empty "no survivors" report
  (deliberate deviation from Travian, which returns nothing).
- Defenders can station support troops in other settlements (own or anyone's). Stationed
  troops defend every battle at the host and are **fed by the host settlement**; either
  side can end the arrangement instantly — the owner recalls, or the host evicts.
- **Beginner protection: 72 h** from the moment the account's first settlement is created.
  It blocks **all** foreign movements at that account's settlements — raid, assault,
  **scouting** and support alike — and ends early **only** on the protected account's own
  first raid or assault against another account. Scouting somebody, and raiding an **oasis**,
  do *not* break it: the onboarding loop is "train a scout, send it", and a rule that
  strips protection for following the tutorial is a trap (M3 record §11).
- Battle reports for both parties, plus a loss report to every supporter who lost units.
- **Notifications** (M3 record §16): an outbox written in the same transaction as the event
  that caused it, drained through a `NotificationProvider` interface. In-app/WS provider
  live from M3; the real Telegram bot is wired and smoke-tested on the VPS before M7 —
  the same treatment Telegram *auth* already has.

### 2.7 Round structure — three acts

| Act | When | Content |
|---|---|---|
| 1. Survival | Days 1–7 | Build-up, NPC raider pressure, scouting, first raids |
| 2. Escalation | Days 8–14 | Sides formalize war goals; side quests/objectives; Source area reveals; NPC armies mobilize |
| 3. The Source | Days 15–21 | Source becomes capturable; hold-time accumulation; final battles |

**Endgame:** a side "holds" the Source while a garrison of that side occupies it.
Beacon accumulates *transmission hours*, Silence accumulates *dismantling hours*.
First side to reach the target total (tuned in simulation, ~72 h) wins immediately;
otherwise the side with more accumulated hours at round end wins. Personal
**contribution score** (troops sent to Source battles, waves repelled, support fed)
forms the individual season ranking and medals.

**Side switching:** allowed once per 48 h; resets personal contribution to zero
(settlements and troops are kept).

### 2.8 NPC design

- NPC = regular account + `npcState` (profile, knobs, memory, nextTickAt). The NPC brain
  is a pure function `(state) → actions` living in `game-core`; it calls the **same
  domain services** as player request handlers. No direct DB shortcuts, no free resources.
- Profiles:
  - **Settler** — follows a build-order template, trades surplus, never attacks.
  - **Marauder** — build-order + target selection: nearby settlements scored by
    `expected loot / estimated defense` using its own scout reports; respects beginner
    protection.
  - **Side Soldier** — in Acts 2–3 responds to side "war calls": joins attack waves on
    the Source or reinforces it when their side holds it.
- Human-likeness knobs: 6–9 h sleep window, jittered reaction delays, per-NPC skill
  (build-order quality), activity level.
- Scheduling: each NPC wakes every 10–30 min (jittered) via the global event scheduler.
  ~150 NPCs ≈ 0.2 events/sec background load — negligible on 1 core.

---

## 3. Architecture

### 3.1 Monorepo layout (pnpm workspaces)

```
last-signal/
├── apps/
│   ├── server/          # NestJS: API, WS gateway, event worker, NPC module, TG bot
│   └── web/             # React + Vite, mobile-first pixel-art UI
├── packages/
│   └── game-core/       # ALL game formulas, constants, types, NPC brain, battle engine
├── tools/
│   ├── assets/          # slicing/normalization scripts (sharp): raw sheets → sprites
│   └── sim/             # headless balance simulator (see §4)
├── docs/                # this plan, ASSET_PROMPTS.md, design notes
└── art/
    ├── reference/       # binding UI/style mockups (mockup_ui_pixel.png is the art director)
    └── raw/             # accepted generated sheets (source of truth for slicing)
```

`game-core` is the heart: deterministic, side-effect-free, fully unit-tested. Both server
(authoritative) and client (previews, countdowns, production display) import the same
formulas — they can never drift.

### 3.2 Data model (MongoDB 7+)

MongoDB 7+ on a single-node replica set: multi-document transactions are available and
are the mechanism for multi-step command flows (e.g., deduct resources + append to build
queue + schedule event). Single-document atomic ops (`findOneAndUpdate`, `$inc`) remain
the natural path where one document suffices. Event handlers (e.g., battle resolution)
stay idempotent and re-check state — transactions don't replace crash-safety.

Collections:

- `accounts` — tgId, name, faction, side, sideChangedAt, contribution, medals, settings;
  `protectedUntil` (beginner protection, M3)
- `settlements` — accountId, x, y, buildings[{type, level}], resources snapshot
  (`{values, lastCalcAt}`), buildQueue, trainingQueue, influence, and **three** troop
  lists (M3): `troops` (own, at home), `awayTroops` (own, in transit) and
  `stationedTroops` (foreign support, tagged with owner and origin). Food upkeep is the
  **union of all three**, which is what keeps a marching army from being free
- `movements` — from, to, type (raid/assault/scout/support/settle/trade), units,
  departAt, arriveAt, status, survivors, loot; processed by the scheduler at `arriveAt`
- `oases` — farm oases placed at world generation (`{x, y, type}`); from M3 also
  `defenders`, `loot`, `lastRegenAt`, `version`, all accruing lazily like settlement
  resources
- `tradeOffers` (M3) — `{accountId, fromSettlementId, give, want, merchantsNeeded,
  createdAt, expiresAt}`; the offered resources are deducted at creation
- `notifications` (M3) — outbox `{accountId, kind, payload, createdAt, deliveredAt,
  provider}`, written in the same transaction as the event that caused it
- `events` — `{type, dueAt, payload, status}`, index `{status, dueAt}`; the single
  source of "things that happen at a moment in time" (arrivals, build completions,
  NPC ticks, act transitions, starvation checks)
- `reports` — battle/scout reports per account
- `world` — singleton: seed (terrain is derived from it, never stored per tile), round
  number, act, source control state `{holderSide, holderSince, accumulated: {beacon,
  silence}}` (null until the Act 2 reveal places the Source), timeline
- `seasons` — archived final rankings per round

### 3.3 Event scheduler

A ~30-line worker inside the server process: every second,
`findOneAndUpdate({status: 'due', dueAt: {$lte: now}} → status: 'processing')` in a loop,
dispatch to a handler by type, mark done. Crash-safe (events persist), idempotent handlers.
Single process — no distributed locking needed.

### 3.4 API & realtime

- REST (NestJS controllers) for all commands and views; game state responses include
  server time so the client can run countdowns locally via `game-core`.
- WebSocket gateway (socket.io): push "report arrived", "incoming attack", "queue done",
  "world/act changed". No resource ticks over the wire — the client computes production
  itself from the same formulas.
- Telegram bot (same server process): auth (Login Widget validation) + notifications.

### 3.5 Frontend

- React 18 + Vite, Zustand for state, TanStack Query for API, i18next (RU default).
- Map: viewport-culled tile grid (DOM/canvas, `image-rendering: pixelated`), pan/zoom,
  61×61 fits comfortably.
- UI follows the pixel-art mockup `art/reference/mockup_ui_pixel.png` (top resource bar, left/bottom nav:
  Map, Base, Units, Market, Reports, Side, Settings).
- Design tokens from the art palette (see ASSET_PROMPTS.md §Palette).

### 3.6 Deployment

- pm2 app `last-signal` (NestJS serves API+WS; Caddy serves the built web bundle and
  reverse-proxies `/api` and `/ws`).
- GitHub Actions CI: lint, typecheck, unit tests, build — required green before any tag.
- Expected footprint: ~150–250 MB RAM, negligible CPU (VPS currently has ~900 MB free).

---

## 4. Balance simulation harness (`tools/sim`)

Headless fast-forward of a whole world: instantiate `game-core` with N virtual accounts
(all NPC brains, mixed profiles/factions/sides), run 21 game-days of scheduler events in
minutes with a mocked clock, output metrics: resource curves, army sizes over time, raid
profitability, act-3 Source hold distribution, win-rate per side/faction.

Used to: tune unit stats and costs, verify the endgame doesn't stalemate, catch runaway
strategies — without waiting for real weeks. Runs in CI as a smoke test (short horizon).

---

## 5. Milestones

Each milestone ends with: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green
+ a runtime smoke check. Nothing is "done" without that.

**M0 — Scaffold.** pnpm monorepo, NestJS + Vite + game-core wired, ESLint/Prettier,
Vitest/Jest, GitHub Actions CI, README. *Accept: CI green, dev servers boot, web calls API.*

**M1 — Economy core**, split into three sub-milestones (each ends with the same green
bar; all design inputs are fixed in `docs/M1_DESIGN_DECISIONS.md`):

- **M1a — Economy foundations.** MongoDB 7 (single-node replica set) + schemas, the
  concurrency playbook (transactions + version-guarded updates, idempotent event
  handlers, lease/sweep), lazy resources incl. Food upkeep, per-resource storage caps,
  event scheduler wiring, all 13 buildings' formulas (costs, times, production,
  prerequisites, Influence) in game-core behind an injected `GameConfig`, with unit
  tests. *Accept: formula tests green; a build starts and completes through the API
  against a real Mongo.*
- **M1b — Auth & account lifecycle.** Guest auth (httpOnly cookie + Mongo-backed
  session), registration, faction choice, settlement creation with deterministic
  outer-ring placement; Telegram Login behind the same service interface (smoke-tested
  on the VPS before M7). *Accept: fresh account → faction → settlement via the API.*
- **M1c — Base screen & i18n.** Building list UI (spatial schema, list presentation),
  build queue UI, live resource bar, i18n scaffold (RU) + migration of M0's hardcoded
  strings. *Accept: a player can grow a settlement end-to-end in the browser.*

Deferred out of M1: Influence display (M2 — §9 of the M2 record), Influence-gated
founding with settler convoys and Market functionality (both M3 — they need movement
types M2 does not ship).

**M2 — Map & movement.** World generation (seed-derived terrain, farm oases, ~135 inert
NPC accounts seeded through the new center-out spawn policy), map UI with pan/zoom,
movements + arrivals via the scheduler — **scout is the only movement type** — a
scout-only slice of the training system (players build their own scouts), scouting with
reports, and Influence displayed on the base screen. All design inputs are fixed in
`docs/M2_DESIGN_DECISIONS.md`; the M2a/M2b/M2c split lives in its §13. *Accept: scout
another settlement from the map and read the report.*

**M3 — Combat, expansion & trade**, split into five sub-milestones (all design inputs are
fixed in `docs/M3_DESIGN_DECISIONS.md`; the M3a–M3e split with per-step acceptance criteria
lives in its §20):

- **M3a — Roster, training & upkeep.** The remaining 12 units + the faction-neutral
  **Settler** + two wildlife defender types (scouts shipped in M2), training generalized to
  three buildings with the training-building level reducing training time, the
  `troops`/`awayTroops`/`stationedTroops` split that makes **in-flight troops eat Food**,
  **starvation** (hourly tick, weakest first, guests before hosts), NPC seeder bands
  extended with real defenders and Hidden Cache levels.
- **M3b — The battle engine (pure, `game-core` only).** Raid/assault resolution, wall
  multiplier, deterministic roll, loot distribution behind the Hidden Cache, the siege pass
  and its resistance curve.
- **M3c — Attack, support & oases (server).** `raid`/`assault`/`support` movements and
  their arrival resolvers, two-document arrival transactions, loot on the return leg, siege
  application with the Command Center floor, support recall/evict, oasis live state with
  lazy regeneration, oasis raiding and scouting, beginner protection, incoming-movement
  visibility gated by Radio Tower level.
- **M3d — Founding & the Market.** Settler training, the `settle` movement with the
  Influence gate checked twice, `tradeOffers` with the 1:2 ratio cap, and the **world
  exchange post** with its spread.
- **M3e — UI, reports & notifications.** Units tab, attack flow, incoming panel, combat
  reports, Market tab, settle action, protection badges, the **notification layer**
  (outbox + provider interface, in-app provider live, Telegram provider a logging stub),
  the change-stream resume fix, RU i18n for all of it.

*Accept: two test accounts fight end to end in a real browser; results match hand-computed
formula cases; an in-app notification fires and the Telegram provider logs the identical
payload* (the real bot is smoke-tested before M7 — M3 record §16).

**M4 — NPCs.** Profiles (Settler/Marauder), tick scheduling, world seeded with ~135
NPCs, sim harness runs 21 days headless, first balance pass. *Accept: sim report looks
sane; a fresh player in a seeded world gets raided by a Marauder after protection ends.*

**M5 — Sides & endgame.** Side selection/switch (48h cooldown, contribution reset),
act timeline events, Source control + hold accumulation, Side Soldier NPC behavior,
contribution scoring, round end → season archive → world wipe/rollover. *Accept: sim
completes a full round with a winner; rankings archived.*

**M6 — Visual polish.** Slice & integrate the full asset set (tools/assets scripts),
UI kit (buttons/panels/frames), landing page, medals, EN locale, mobile UX pass.
*Accept: the game looks like the mockup on a phone.*

**M7 — Launch round.** Deploy via pm2 + Caddy, closed round with friends, log/monitor,
hotfix loop. *Accept: 15 humans playing round 1.*

---

## 6. Asset workflow

Art generation is **manual and owned by the user** (evening ChatGPT sessions); prompting
is owned by the agent. The complete prompt book with per-sheet status lives in
**`docs/ASSET_PROMPTS.md`**. Accepted raw sheets live in `art/raw/`; slicing/normalization
into game sprites is done in a dedicated session using `tools/assets` scripts (slice →
trim → nearest-neighbor resize → `apps/web/public/assets/`). The full-UI mockups in
`art/reference/` are the binding reference for style AND layout.
