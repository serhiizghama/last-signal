# Last Signal — Implementation Plan

A browser-based, mobile-first, real-time strategy game inspired by classic Travian mechanics,
re-themed as a post-apocalyptic world. Players (and indistinguishable NPC accounts) develop
settlements, raid each other, pick a global side — **Beacon** or **Silence** — and fight over
the **Signal Source** at the center of the map in a 3-week seasonal round.

Solo pet project, portfolio-grade quality. No monetization, ever.

---

## 1. Locked decisions

| Topic | Decision |
|---|---|
| Audience | Self + ~15 friends per world; public GitHub repo, CI, version tags |
| Platform | Mobile-first web app; architecture ready for a Telegram Mini App wrapper later |
| World size | 61×61 grid (3,721 tiles), ~150 total accounts (~15 human + ~135 NPC) |
| Round | 3 weeks, speed ~x5 vs classic Travian; three acts; full world wipe at the end |
| Persistence across rounds | Account keeps history, medals, past-season contribution ratings |
| Factions (race analog) | Raiders (cheap mass army), Engineers (expensive strong units, fast builds), Nomads (fast, defensive) |
| Resources | Scrap, Fuel, Electronics, Food (Food is consumed by troops; starvation kills) |
| Sides (global war) | **Beacon** (answer the alien Signal) vs **Silence** (silence it forever). Chosen at registration, switchable with 48h cooldown; switching resets personal contribution score |
| Victory | King-of-the-hill over the Signal Source: both sides accumulate hold-time toward their goal; first to target wins, else larger accumulation at round end |
| PvP | Full PvP (anyone can attack anyone, incl. own side). Raids + building destruction. **No village capture in v1** |
| NPCs | Full game accounts, indistinguishable from humans, play by identical rules via the same service layer. Behavior profiles + scheduled ticks |
| Content scope | ~12 building types, 5 units per faction |
| Stack | TypeScript monorepo: NestJS backend + React/Vite frontend + shared `game-core` package |
| Database | MongoDB (must run on 3.6: **no transactions**, single-document atomic ops only). Custom event scheduler collection, no Agenda/Redis |
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

### 2.3 Resources & economy

- Four resources: **Scrap, Fuel, Electronics, Food**. Troops consume Food per hour;
  negative Food balance starves troops (weakest die first).
- Production comes from four resource buildings inside the settlement. No separate field
  ring (simplification vs Travian): resource buildings are regular buildings.
- Lazy evaluation: `current = stored + rate × (now − lastCalcAt)`, capped by storage.
  Nothing ticks in the background.
- Warehouse caps Scrap/Fuel/Electronics; Cold Storage caps Food.
- Market: player-to-player and player-to-NPC trades at limited exchange ratios; merchants
  travel on the map like armies.

### 2.4 Buildings (12 types)

| Building | Purpose |
|---|---|
| Command Center | Build speed; prerequisite hub (HQ) |
| Scrap Yard | Scrap production |
| Fuel Refinery | Fuel production |
| Electronics Workshop | Electronics production |
| Greenhouse Farm | Food production |
| Warehouse | Scrap/Fuel/Electronics storage cap |
| Cold Storage | Food storage cap |
| Barracks | Trains infantry & scouts |
| Machine Shop | Trains vehicles (fast + siege units) |
| Wall | Defense bonus; must be breached by siege |
| Market | Trading, merchants |
| Radio Tower | Scouting ops, intel level, incoming-attack visibility detail |

Levels 1–20, costs/times exponential (classic Travian curves adapted, x5 speed).
One build queue slot (Engineers: two). Settlement expansion: an **Influence** score
(from building levels) gates founding new settlements with settler convoys; soft cap
~3 settlements per account per round.

### 2.5 Map & world

- 61×61 grid. Terrain: wasteland variants, ruined city, dead forest, toxic lake,
  broken highway, rocky hills (visual + minor movement modifiers later; v1: cosmetic).
- **Signal Source** occupies the center (3×3 visual footprint, one logical tile).
- **Farm oases**: NPC-held surviving farms scattered on the map — raid targets with
  Food loot (not annexable in v1).
- Humans spawn in the outer ring on registration; NPCs are pre-seeded across the map
  at world start with staggered development levels.
- Travel time = distance / unit speed (slowest unit in the army), ~2–4 h across half
  the map for average units.

### 2.6 Combat

Adapted classic Travian battle system (public Kirilloid formulas as the base), simplified:

- Army offense points vs defender defense points (infantry/vehicle split), wall bonus,
  random factor ±(small). Losses distributed proportionally.
- Attack types: **Raid** (partial engagement, loot up to carry capacity) and
  **Assault** (full battle; with siege units — destroys targeted building levels; Wall
  must fall first).
- Scouting: scout-vs-scout resolution; report shows resources, troops, buildings
  depending on Radio Tower differential.
- Defenders can station support troops in other settlements (own or anyone's).
- **Beginner protection: 72 h** (no incoming attacks; ends early if the player attacks).
- Battle reports for both parties; Telegram push for incoming attacks.

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

### 3.2 Data model (MongoDB, 3.6-compatible)

No multi-document transactions. Every mutation is a single-document atomic op
(`findOneAndUpdate`, `$inc`, optimistic versioning where needed). Cross-document flows
(e.g., battle resolution) are idempotent event handlers that re-check state.

Collections:

- `accounts` — tgId, name, faction, side, sideChangedAt, contribution, medals, settings
- `settlements` — accountId, x, y, buildings[{type, level}], resources snapshot
  (`{values, lastCalcAt}`), buildQueue, troops (home + stationed), influence
- `movements` — from, to, type (raid/assault/scout/support/settle/trade), units,
  departAt, arriveAt; processed by the scheduler at `arriveAt`
- `events` — `{type, dueAt, payload, status}`, index `{status, dueAt}`; the single
  source of "things that happen at a moment in time" (arrivals, build completions,
  NPC ticks, act transitions, starvation checks)
- `reports` — battle/scout reports per account
- `world` — singleton: round number, act, source control state
  `{holderSide, holderSince, accumulated: {beacon, silence}}`, timeline
- `seasons` — archived final rankings per round

### 3.3 Event scheduler

A ~30-line worker inside the server process: every second,
`findOneAndUpdate({status: 'due', dueAt: {$lte: now}} → status: 'processing')` in a loop,
dispatch to a handler by type, mark done. Crash-safe (events persist), idempotent handlers,
works identically on MongoDB 3.6 and 8.0. Single process — no distributed locking needed.

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

**M1 — Economy core.** Schemas, lazy resources, 12 buildings with costs/curves in
game-core, build queue via events, storage caps, Influence. Telegram + dev-guest auth.
Base screen UI (buildings, queue, resource bar with live client-side ticking). i18n
scaffold (RU). *Accept: a player can grow a settlement end-to-end in the browser;
formula unit tests pass.*

**M2 — Map & movement.** World generation (terrain, Source placeholder, farm oases,
NPC seeding stub), map UI with pan/zoom, movements + arrivals via scheduler, scouting
with reports. *Accept: scout another settlement from the map and read the report.*

**M3 — Combat.** Battle engine in game-core (raid/assault, wall, siege destruction,
carry capacity, starvation), troop training, support stationing, beginner protection,
battle reports UI, Telegram notifications. *Accept: two test accounts fight; results
match hand-computed formula cases; TG push received.*

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
