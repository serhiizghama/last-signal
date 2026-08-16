# M2 — Map & movement: design decisions (RESOLVED)

**Status: every item below is DECIDED** — settled with the owner in the design session of
2026-08-16 (two rounds of structured Q&A per `docs/M2_DESIGN_SESSION_PROMPT.md`). This
document is the **binding design record for M2**; for M2 scope it **wins over
`IMPLEMENTATION_PLAN.md`** if the two ever disagree. The plan edits required to bring the
plan back in line are listed in §15 — they must be applied, not silently diverged from.

**Numbers vs shapes** (inherited from M1). Mechanics and curve *shapes* below are final.
Specific *numbers* (unit stats, oasis counts, terrain percentages, spawn-radius constants,
intel thresholds, the loss exponent) are first-pass drafts: they live in the injectable
`GameConfig`, are sanity-checked against Kirilloid where a Travian analog exists, and are
tuned by `tools/sim` in M4 against the §0 contracts. No number below is sacred; every
shape is. Each section marks which is which.

---

## 0. Travel-time contract (the anchor)

M1's anchor was three reference players; M2's is a **travel-time / reachability table**
`tools/sim` (M4) must verify against. Distance is **Chebyshev** (§1); time =
`distance / (unitSpeed × SPEED.travel)`, slowest unit in the army decides.

**Fixed shape:** `SPEED.travel` applies to every unit uniformly; scout classes are the
fastest thing on the map; "half the map" = 30 tiles; "corner to corner" = 60 tiles.

**Draft numbers:** `SPEED.travel = 2` (down from the plan's "~2–3" range — pinned so the
table below is concrete; the knob stays sweepable). Unit speeds at classic x1, compared
against Kirilloid T3.6 scout speeds (Teuton Scout 9, Equites Legati 16, Pathfinder 17
fields/h):

| Unit (x1 speed) | 10 tiles | 30 tiles (half map) | 60 tiles (full map) |
|---|---|---|---|
| Falconer — Nomads (17) | ~18 min | ~53 min | ~1 h 46 m |
| Surveyor Drone — Engineers (16) | ~19 min | ~56 min | ~1 h 53 m |
| Lookout — Raiders (9) | ~33 min | ~1 h 40 m | ~3 h 20 m |
| *M3 reference: infantry (~7)* | ~43 min | ~2 h 09 m | ~4 h 17 m |
| *M3 reference: siege (~4)* | ~1 h 15 m | ~3 h 45 m | ~7 h 30 m |

**Contract for the simulator:** an average combat unit crosses half the map in **2–4 h**
(locked target from the plan); scouts cross half the map in **≤ 1.7 h**; nothing crosses
the full map in under **40 min**. If a tuning pass breaks any of these, the pass is wrong.

## 1. Topology & distance metric

- **Decided:** the map is **bounded** (61×61, coordinates −30..30, no wrap-around) and the
  distance metric is **Chebyshev**: `d = max(|dx|, |dy|)`. Both are final shapes.
- **Why:** the wasteland having an *edge* is thematically right; bounded panning keeps the
  map UI and mini-map trivial; Chebyshev gives integer distances, a dead-simple travel
  table, and "moves like a king" intuition. The original fairness argument for wrap
  (equal neighbourhoods) lost its force once spawn became center-out random and the
  Source became dynamically placed (§2, §3).
- **Rejected:** *torus + Euclid* (Travian's model) — wrap does not equalise distance to a
  central objective, and it makes panning, path preview and the mini-map materially more
  complex for near-zero gain in a 150-account world. *Bounded + Euclid* — diagonal
  marches costing √2 more adds veteran familiarity but nothing else; float distances for
  no benefit. Deviation from Travian is deliberate and recorded.

## 2. World generation

- **Terrain is derived, not stored.** A pure function in `game-core`,
  `terrainAt(seed, x, y)`, deterministically maps the stored world seed to one of the six
  terrain types. No tile documents exist; both server and client call the same function,
  so the map payload carries no terrain at all. (Technical decision, recorded not asked.)
- **Terrain is cosmetic in v1 — confirmed** (plan §2.5), with exactly one exception:
  **toxic lake tiles cannot host a settlement** (spawn or future settle). No movement
  modifiers in v1; armies path "as the crow flies". Movement modifiers stay a vNext idea.
- **Draft terrain distribution** (config): wasteland 55%, dead forest 12%, rocky hills
  10%, ruined city 8%, broken highway 8%, toxic lake 7%.
- **The Signal Source is NOT placed at world generation.** Owner decision: the Source
  appears later at a **computed balanced location** (roughly the population-weighted
  middle of the settled world), when the Act 2 reveal fires. `world.source` is `null` in
  M2; the placement algorithm, the reveal event and what the tile blocks are **M5's** to
  design. In M2 the map centre is ordinary terrain and fully settleable.
  - **Rejected:** fixed 3×3 centre footprint from day one (the plan's original model) —
    the owner explicitly moved to dynamic placement; players migrate and multi-settle, so
    the "centre" of the round is where people actually are, not (0,0). This is a plan
    edit (§15).
- **Farm oases: placed at world generation, inert in M2.** Stored as documents in a new
  `oases` collection (`{x, y, type}` — they will hold state from M3: defenders, loot).
  Visible to everyone on the map; tapping one shows a public info card. **No tiers in
  v1**, Food-flavoured only; defenders, loot, loot regeneration and raiding are **M3**;
  scouting them is also M3 (§8). Settlements cannot be founded **on** an oasis tile;
  adjacency is allowed.
  - **Draft numbers** (config): **24 oases**, pairwise Chebyshev distance ≥ 5, none on a
    toxic-lake tile, none within 2 tiles of the map edge.
- **World lifecycle:** on server start with an empty DB the world bootstraps itself
  (seed generated and stored, oases placed, NPCs seeded §4); an explicit admin command
  can regenerate from scratch in dev. Round wipe/rollover (regenerate with a new seed,
  archive the season) is **M5**. The `world` singleton stores
  `{seed, roundNumber, act, source: null, timeline}`. (Technical, recorded.)

## 3. Spawn & settleability

- **Decided: one placement policy for everyone — random within a radius that expands
  from the centre outwards** as the world fills (Travian-style ring growth), replacing
  M1b's deterministic outer-ring rule. NPCs are seeded through this same policy at world
  start (§4), so humans registering later naturally land in the outer band — the original
  "humans spawn outside" intent is now an emergent property, not a special rule. M1's
  record anticipated exactly this: §14 — "M2 replaces only the *placement policy*, never
  the schema".
- **Shape (final):** candidate tiles are drawn uniformly from an annulus
  `[max(0, R(n) − W), R(n)]` of Chebyshev radius around (0,0), where `n` is the current
  total settlement count and `R(n)` grows monotonically with `n`; a candidate must be
  settleable (§ below); if the annulus has no legal tile, `R` grows until one is found.
- **Draft numbers** (config): `R(n) = min(30, 4 + ceil(1.8 × √n))`, band width `W = 6`.
  With 135 seeded NPCs, `R ≈ 25` — humans land at radius ~19–30.
- **Settleability (final):** a settlement may occupy any tile that is not a toxic lake,
  not an oasis, and at Chebyshev distance **≥ 3** (draft number) from every existing
  settlement. The `{x, y}` unique index remains the final authority; bounded retry on
  collision (mechanism unchanged from M1b).
- **Rejected:** *keep outer-ring placement* — contradicts the owner's decision and makes
  early worlds a ring of strangers around an empty middle; *global uniform random* —
  owner explicitly wants centre-out concentration; *deterministic spiral* — loses the
  organic look the owner asked for ("как у Травиана").

## 4. NPC seeding stub

- **Decided: the full ~135 NPC population is seeded at world start as real, inert
  accounts** — genuine `accounts` + `settlements` documents created through a dedicated
  seeding service that goes through the same placement policy (§3) and uses the
  `game-core` catalogue for validity. No behaviour, no ticks, no `npcState` — the brain
  is **M4**; M4 switches them on without touching their data.
- **Staggered development (draft numbers, config):** three archetype bands — *young*
  (CC 1–2, resource buildings 1–3, no troops) 40%, *developed* (CC 3–5, resource 4–7,
  Barracks, **0–3 scouts**) 40%, *veteran* (CC 5–7, resource 6–9, Barracks, **2–6
  scouts**) 20%. Factions uniform; sides assigned uniformly at seed. Resources
  initialised at ~50% of storage caps. Building levels and troops are written directly by
  the seeder (world genesis is god-mode by definition, like Travian's pre-built Natars);
  *behaviour* — from M4 — goes through the real service layer, per the plan's NPC rule.
- **Why some NPCs have scouts:** so scout-vs-scout losses and detection (§8) actually
  occur in the wild in M2, not only in tests.
- **Rejected:** *small seed (30–50)* — half-empty map, and the full-scale placement code
  would ship unproven until M4; *fixture decorations* — not real accounts, so scouting
  them would need a special case, violating "NPC = regular account".

## 5. Map data, API & visibility

- **Visibility (final): everything on the map is public** — terrain, oases, and for every
  settlement its coordinates, name, owner name, faction and side. Internals — resources,
  building levels, troops — are **only** obtainable via scouting. What a movement's
  participants see is defined in §6/§8.
  - **Rejected:** *fog of war* (per-account visibility state — expensive on the 1-core
    VPS, anti-social for a 15-friend world) and *anonymous occupancy* (forces scouting
    everything, kills the social map-browsing that is half the fun at this scale).
- **API (technical, recorded):** `GET /api/map` returns the world header (seed, act,
  round) + all settlements (public fields only) + all oases in one response — with
  terrain derived client-side from the seed, the payload is a few KB for 150 accounts.
  Client caching: TanStack Query with a modest `staleTime`, invalidated by a WS event
  when a settlement appears (rare). Own movements come from `GET /api/movements/mine`;
  nobody can query anyone else's movements in M2.

## 6. Movement

- **M2 ships exactly one movement type: `scout`.** Owner decision (minimal M2). `settle`,
  `trade`/merchants and `support` all slide (§14). Consequence accepted explicitly: the
  Influence *gate* and settler convoy move to M3 — this is that deferral's **second**
  slide, recorded with its reason (M2 stays lean; §0-contract verification of settlement
  #2 timing happens in M4's sim, which lands after M3 anyway).
- **Command shape (final), per the concurrency playbook recipe verbatim:**
  `POST /api/movements` `{type: 'scout', fromSettlementId, target: {x, y}, units}` runs
  in a transaction: settle resources → validate via `game-core` (target is a settlement,
  not your own; unit counts available at home; counts ≥ 1) → version-guarded update
  deducting the units from `troops` → insert the `movements` document → schedule
  `movementArrive` in the same session. Departure is immediate; no rally-point building.
- **Cancel (final):** allowed within a **90 s window** after send (Kirilloid/T4 recall
  window — number is config). Cancelling flips the movement to `returning` with return
  time = time already travelled, deletes the pending `movementArrive` event and schedules
  `movementReturn` in the same transaction.
- **Arrival semantics (final):** `movementArrive` resolves scouting (§8) at the target,
  flips the movement to `returning` with survivors and schedules `movementReturn`; if no
  survivors, the movement ends there. `movementReturn` credits survivors back to home
  `troops` (version-guarded). Both handlers are idempotent by re-checking the movement's
  status — a replay after a crash is a no-op, per the playbook.
- **Edge case:** target settlement missing at arrival (cannot happen in M2's rules, but
  the handler defends anyway): scouts turn around, attacker gets a "target not found"
  report. Recorded so M3's destruction mechanics don't discover an unhandled branch.
- **Schema note (technical):** `settlements` gains `troops: [{unitType, count}]` (home
  troops; stationing is M3). `movements` gains `status`
  (`outbound | returning | done | cancelled`) and `survivors`.

## 7. Where scouts come from — a minimal training path

- **Decided: players build their scouts.** Owner's call, overriding both "free starting
  scouts" and "Radio Tower op": progression must be *learned* — resources → buildings →
  Barracks → train a scout → send it. So M2 pulls forward a **scout-only slice of the
  training system**:
  - `game-core` gains a **unit catalogue** with the three faction scouts only. Per-unit:
    cost vector, training time, speed, scoutAttack, scoutDefense, Food upkeep/h — all
    config.
  - **`trainScouts` command** on the Barracks, playbook recipe: settle → validate
    (Barracks present, affordability, **absolute net-Food gate including the whole batch**
    — same rule as builds, M1 §4) → deduct at enqueue → version-guarded write → schedule.
  - **Completion is unit-by-unit via chained events** (technical, recorded): one pending
    `trainingComplete` event per active queue credits one unit and schedules the next —
    Travian-accurate arrival of units one at a time, constant scheduler load, no lazy
    troop math. M3 reuses this shape for all 15 units.
  - **Scouts consume Food from the moment they are credited.** Upkeep enters the existing
    net-Food formula (the M1 hook exists); **starvation stays M3** — in M2 a negative
    balance blocks builds/training (existing gate) but kills nothing.
- **Why:** teaches the game's own loop; keeps M3's combat model intact (scout units exist
  and fight scout-vs-scout, §8); Radio Tower keeps its §2.4 roles without becoming a
  scout dispenser. Cost: M2 grows by the training slice — accepted consciously; M3
  shrinks by the same amount.
- **Rejected:** *free starting scouts* — "why hand a player an army before they learn to
  build one" (owner); *Radio-Tower-op scouting* — the tower needs CC5 + Electronics
  Workshop 3, which would push all scouting to mid-round, contradicting Act 1's
  "scouting, first raids"; and it would fork into two scouting systems once M3 lands.
- **Draft unit numbers** (x1, before `SPEED.training = 5`; sanity-checked against
  Kirilloid scout costs/times in order of magnitude, re-expressed in our §1 resource
  roles):

| Unit | Scrap | Fuel | Electr. | Food | Train (x1) | Speed | scoutAtk | scoutDef | Upkeep |
|---|---|---|---|---|---|---|---|---|---|
| Lookout (Raiders) | 120 | 40 | 20 | 30 | 1200 s | 9 | 35 | 20 | 1/h |
| Surveyor Drone (Engineers) | 100 | 80 | 60 | 20 | 1600 s | 16 | 35 | 35 | 1/h |
| Falconer (Nomads) | 110 | 50 | 30 | 30 | 1300 s | 17 | 45 | 40 | 1/h |

  Nomads get the best scouts (their locked identity: "efficient scouts"); Raiders the
  cheapest and slowest; Engineers pay Electronics for a fast drone.
- **The "train a scout as a quest" idea** the owner raised is a tutorial/quest system —
  out of M2 scope, recorded in §14 as a deferred idea.

## 8. Scouting resolution & reports — the crux

- **Resolution model (final): scout-vs-scout, full loss model from M2**, exactly the plan
  §2.6 shape. At arrival: `atkPts = Σ scoutAttack` of the arriving scouts, `defPts = Σ
  scoutDefense` of the defender's scouts **at home** at that moment. Attacker losses:
  `lossFraction = min(1, (defPts / atkPts)^1.5)` (Kirilloid-style 1.5-power casualty
  curve; exponent is config), losses rounded to whole scouts. `defPts = 0` → no losses.
  Defender scouts never die on defence (Travian rule). **All attackers dead → no intel.**
  Losses are recoverable because training exists (§7) — that is why the full model ships
  now rather than a lossless stub that M3 would have to re-teach players.
  No wall interaction with scouting in v1 (revisit in M3 with the wall itself).
- **Intel tiers (final shape, draft threshold):** the report's depth depends on the
  **Radio Tower level differential** `diff = attackerTower − defenderTower`, both read at
  arrival:
  - **Base (always, any diff):** the target's current resources (settled at arrival
    inside the same transaction — the snapshot is exact), storage caps, and **troop
    counts at home**. This is Travian's two scout missions (resources / defences)
    collapsed into one report.
  - **`diff ≥ 1`:** adds the full building list with levels.
  - Deeper tiers (queue contents, incoming movements) are reserved for M3's design.
  - Early-round reports are base-tier for everyone (nobody has a tower before CC5) —
    accepted; the tower stays a desirable mid-game intel unlock, not a gate on scouting.
- **Detection (final):** the defender receives a **counter-report** iff they have **≥ 1
  scout at home** at arrival (Travian rule). It names the attacking settlement and owner
  (public info anyway, §5) and says nothing about what intel was obtained. No scouts home
  → the scout passes undetected. This creates the intended tension: send both your scouts
  out and you are blind at home.
- **Failed scout still produces a report (deliberate Travian deviation):** if all scouts
  die, the attacker gets a "mission failed, no survivors" report with zero intel — in
  Travian nothing comes back at all, which reads as a bug to a casual player. UX wins.
- **Incoming visibility (owner decision): none in M2.** The defender does not see an
  inbound scout movement before arrival; post-factum counter-report only. The whole
  "incoming movements" surface (attacks *and* scouting, with Radio Tower controlling
  detail per plan §2.4) is designed **once, in M3**. Rejected: showing incoming
  movements now — pure noise in a world without attacks, and M3 would redesign it anyway.
- **Oases cannot be scouted in M2** (owner decision): scout targets are settlements only;
  an oasis tap shows its public card. Scouting an oasis arrives in M3 with defenders and
  loot — when there is something to learn. Rejected: stub oasis reports now — an empty
  report and an extra resolution/UI branch for nothing.
- **Reports persistence (technical, recorded):** `reports` collection:
  `{accountId, type: 'scout' | 'scoutFailed' | 'scoutDetected', createdAt, read,
  payload}` — payload is structured ids + numbers (M1 §15: the server ships keys/ids,
  the client renders prose). Indexes: `{accountId, createdAt: -1}`; unread count via a
  partial index on `{accountId, read}`. Cursor pagination. Retention: reports live for
  the round, wiped at rollover (M5); no cap needed at this scale. WS push `reportArrived`
  to both parties (attacker always, defender when detected).
- **Beginner protection: none in M2** (default the owner accepted). Nothing blocks
  scouting a fresh account — acceptable in a dev world of friends and NPCs. **Decided
  now for M3:** the 72 h protection, when it ships, covers **scouting as well as
  attacks** (as in Travian). Recorded here so M3 doesn't reopen it.

## 9. Influence in M2

- **Decided: display only.** The base screen shows the account's current Influence and
  progress toward the settlement #2 threshold ("X of Y — founding unlocks at Y"), using
  the M1 `calcInfluence` / `settlementsAllowed` functions. The **gate stays enforced**
  server-side (it already is, via `settlementsAllowed`), but the *founding action*
  (settler convoy) is M3, because it is a movement type M2 does not ship (§6).
- **Why:** the value gives players a long-term goal now at near-zero cost; deferring the
  display a third time would leave building levels with no visible purpose beyond
  economy until M3.
- **Rejected:** shipping the settle convoy in M2 (owner chose the minimal movement
  scope); hiding Influence entirely until M3 (third slide in a row for zero savings).

## 10. Market

- **Decided: no trading in M2.** Merchants, exchange ratios and the Market UI ship in
  **M3** together with the rest of the army-adjacent movement types. Reason recorded: M2
  is already carrying the pulled-forward training slice (§7); merchants reuse the same
  movement/arrival infrastructure M2 builds, so nothing is lost by waiting — M3 gets a
  proven movement pipeline to plug into. (This edits the plan, which had deferred Market
  from M1 *into M2* — §15.)

## 11. Map UI

- **Rendering (technical, recorded):** DOM tile grid with viewport culling,
  `image-rendering: pixelated`, base tile size 32 px, pinch/drag pan and 3 zoom steps
  (~0.5× / 1× / 2× — draft), 61×61 fits comfortably. Canvas rejected: no performance need
  at this scale, and DOM stays testable with the existing tooling.
- **Tile art: flat placeholders** (owner's call). Palette-coloured tiles per terrain type
  + simple markers for settlements (faction/side-tinted), oases, and own settlement.
  Slicing `art/raw/terrain_tiles.png` stays in **M6** where the plan put it; `tools/assets`
  is not pulled forward. Rejected: slicing now — the pipeline plus sheet-grid QA would
  eat milestone time, and a regenerated sheet would block on the owner.
- **Interactions (recorded):** tap a tile → bottom info sheet (public info per §5 +
  available actions); on a valid scout target with scouts at home, the sheet offers
  **«Разведать»** with unit count and a **travel-time preview computed client-side from
  the same `game-core` formula** (M1c convention — countdowns against server clock);
  jump-to-coordinates; recentre-on-own-settlement button. Own in-flight movements appear
  as an overlay list on the Map tab with live countdowns (outbound and returning).
- **Navigation:** the **Map tab activates**; the **Reports tab activates** with the scout
  report list (unread badges, read-on-open, pagination) and report detail view. Training
  UI lands on the existing base screen's Barracks card (count picker + queue countdown,
  reusing M1c patterns).
- **i18n:** every new string behind a key, RU shipped, namespaces extended with `map`,
  `units`, `reports` — the `reports` namespace was reserved by M1 §15 for exactly this.

## 12. Non-functional

- **All new formulas live in `game-core`, pure and unit-tested:** `terrainAt`,
  `chebyshevDistance`, `travelTimeMs`, spawn-annulus candidate logic, scout loss curve,
  intel-tier resolution, unit catalogue accessors. The server stays authoritative; the
  client reuses the same functions for previews and countdowns. Server-side game math
  outside `game-core` remains forbidden.
- **No new infrastructure.** Mongo 7 + the existing `events` collection; two new
  collections (`oases`, `reports`) and new fields on `settlements`/`movements`. No
  Redis, no queue library.
- **Every new command follows the concurrency playbook recipe** (transaction + version
  guard, settle first, event scheduled same-session, idempotent handlers) — `trainScouts`,
  `sendMovement`, `cancelMovement` all fit the recipe; nothing needed an exception.
- **Indexes (recorded):** existing `settlements {x,y}` unique and `events {status,
  dueAt}`; new: `movements {ownerAccountId, status}`, `oases {x,y}` unique, `reports
  {accountId, createdAt}` + partial unread. Map fetch cost on the VPS: one query over
  ~150 settlements + one over 24 oases, a few KB — negligible.

## 13. M2 decomposition & acceptance

Three sub-milestones, M1's foundations → server flows → UI shape. Each ends with the
standard green bar (`lint`, `typecheck`, `test`, `build`) plus its own executable check.

- **M2a — World, spawn & map data.** `game-core`: terrain/distance/travel/spawn formulas
  + unit catalogue constants; server: `world` bootstrap + singleton, `oases`, the new
  placement policy replacing M1b's outer ring, NPC seeder (~135), `GET /api/map`.
  *Accept:* on an empty DB the server bootstraps a world; `GET /api/map` returns ~135 NPC
  settlements and ~24 oases; property tests hold — no settlement on a lake/oasis, all
  pairwise distances ≥ 3, terrain identical across two derivations from the same seed;
  a newly registered account lands inside the current spawn annulus.
- **M2b — Scouts, movement & reports (server).** Training command + chained completion
  events; `sendMovement`/`cancelMovement`; `movementArrive`/`movementReturn` handlers;
  scout resolution + intel tiers in `game-core`; `reports` API; WS pushes.
  *Accept:* over the real HTTP API against real Mongo — account A builds to Barracks,
  trains a scout (completion event fires, Food upkeep visibly drops), scouts an NPC that
  has 2 scouts: losses match the hand-computed formula, A's report contains exactly the
  base-tier intel, the NPC account has a counter-report; replaying `movementArrive` is a
  no-op; the playbook race test passes (two concurrent sends of the same last scout —
  exactly one succeeds).
- **M2c — Map & Reports UI.** Map tab (pan/zoom, culling, placeholder tiles, tap sheet,
  jump-to-coords, recentre), send-scout flow with travel preview, movements overlay with
  countdowns, Reports tab, Influence display, training UI on the Barracks card, RU i18n.
  *Accept (the plan's M2 criterion, made executable):* in real Chrome at a phone
  viewport — register → build to Barracks → train a scout → from the map, scout an NPC
  settlement → the travel preview matches the actual arrival → the report appears in the
  Reports tab **without a reload** and reads in Russian; Influence and its threshold
  progress are visible on the base screen.

## 14. Deliberately deferred

| Item | To | Reason |
|---|---|---|
| Settler convoy + Influence-gated founding (the action) | M3 | Owner chose scout-only movements; gate already enforced, display ships now (§9). Second slide of this item — do not slide it again. |
| Market / merchants / trade | M3 | Reuses M2's movement pipeline; M2 already absorbed the training slice (§10). |
| Support stationing | M3 | Combat-adjacent by plan. |
| Oasis defenders, Food loot, regeneration, scouting oases | M3 | Inert oases have nothing to scout or raid yet (§2, §8). |
| Incoming-movement visibility + Radio Tower visibility detail | M3 | Designed once, together with attacks (§8). |
| Beginner protection (72 h, **covers scouting** — decided here) | M3 | Nothing to protect in a dev world; the scouting coverage decision is already made (§8). |
| Troop starvation | M3 | Upkeep ships in M2; killing troops belongs to combat (§7). |
| Source placement algorithm, Act 2 reveal, Act 3 capture | M5 | Owner moved the Source to dynamic placement (§2); acts are M5. |
| Full NPC behaviour (profiles, ticks) | M4 | M2 seeds inert accounts only (§4). |
| Tile-art slicing pipeline (`tools/assets`) | M6 | Owner chose placeholders (§11). |
| Tutorial / quest system ("train a scout" as a task) | Backlog (M6+) | Owner's idea from this session; out of M2 scope, must not be lost (§7). |
| Terrain movement modifiers | vNext | Terrain stays cosmetic in v1 (§2). |

## 15. Required edits to `IMPLEMENTATION_PLAN.md`

1. **§2.5 spawn:** replace "Humans spawn in the outer ring on registration; NPCs are
   pre-seeded across the map" with the unified center-out expanding random policy (§3),
   noting NPCs are seeded through it first at world start.
2. **§2.5 Source:** replace "Signal Source occupies the center (3×3 visual footprint,
   one logical tile)" with: the Source has no location until the Act 2 reveal places it
   at a computed balanced point; algorithm owned by M5. Remove "Source placeholder" from
   the M2 milestone line in §5.
3. **§2.5 map:** add: the grid is bounded (no wrap) and the distance metric is Chebyshev.
4. **§5 M2/M3 lines:** M2 = world gen (no Source), map UI, movements (scout only),
   scout-only training, scouting with reports, Influence display; M3 gains settler
   convoy + Influence-gated founding, Market/trade, support, oasis combat/scouting,
   incoming visibility, starvation, protection. Note M3's "troop training" is now "the
   remaining 12 units" (scouts shipped in M2).
5. **§2.6 scouting:** append the resolved detail: scout-vs-scout with the 1.5-power loss
   curve, Radio Tower differential for intel depth, defender counter-report requires a
   scout at home, failed missions still produce an empty report (deliberate deviation).
6. **§1 locked "Round" row:** `travel` multiplier pinned at 2 (draft, config) per §0.

## 16. Checklist — all resolved

- [x] §0 travel-time contract (table + three sim-checkable bounds)
- [x] §1 bounded map, Chebyshev metric
- [x] §2 seed-derived terrain (cosmetic; lakes unsettleable), no Source in M2, 24 inert oases, bootstrap lifecycle
- [x] §3 center-out expanding random spawn, one policy for all, settleability rules
- [x] §4 ~135 real inert NPC accounts, staggered bands, some with scouts
- [x] §5 everything public; whole-map fetch
- [x] §6 scout-only movements, playbook recipe, 90 s cancel, idempotent arrive/return
- [x] §7 scout-only training path (owner: players build their scouts), chained events, Food upkeep now / starvation M3
- [x] §8 full scout-vs-scout losses, intel tiers (base = resources+troops; tower diff ≥ 1 adds buildings), Travian detection, silent incoming, no oasis scouting, failure reports, no protection in M2
- [x] §9 Influence display-only; gate enforced, founding M3
- [x] §10 no trading in M2
- [x] §11 DOM grid, flat placeholder tiles, Map + Reports tabs activate, RU i18n
- [x] §12 formulas in game-core, no new infra, index plan
- [x] §13 M2a/M2b/M2c split with executable acceptance criteria

**Follow-up work owned by the implementation orchestrator (no owner decisions
required):** draft the exact spawn-annulus constants and NPC band tables as config;
verify the scout cost/time drafts against Kirilloid once more when writing the catalogue;
extend the reference-player harness with the training/scouting flows where cheap; keep
every draft number in `GameConfig` so `tools/sim` can sweep it in M4.
