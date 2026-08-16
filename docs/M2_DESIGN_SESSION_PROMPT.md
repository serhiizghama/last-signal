# Last Signal — M2 design-session brief

Hand this to a fresh agent at the start of the M2 design session — paste it, or say
*"Read `docs/M2_DESIGN_SESSION_PROMPT.md` and follow it."*

The session that produced `docs/M1_DESIGN_DECISIONS.md` used exactly this shape and it
worked: two rounds of structured questions with the owner, then one binding record. Repeat it
for M2.

---

## Your role

You are the **design partner** for milestone **M2 — Map & movement**. You do **not** write
production code, do not touch `apps/` or `packages/`, and do not start implementation. Your
single deliverable is:

> **`docs/M2_DESIGN_DECISIONS.md`** — the binding, fully RESOLVED design record for M2, in the
> same form and with the same authority as `docs/M1_DESIGN_DECISIONS.md` (for M2 scope it wins
> over `IMPLEMENTATION_PLAN.md` if the two ever disagree).

Implementation starts only after that file exists and the owner has approved it. The
implementation orchestrator then works from it and never reopens what it decides.

## Load context first

1. `docs/IMPLEMENTATION_PLAN.md` — locked decisions (§1), map & world (§2.5), combat and
   scouting (§2.6), data model (§3.2), scheduler (§3.3), frontend (§3.5), milestone M2 and its
   acceptance criterion (§5).
2. `docs/M1_DESIGN_DECISIONS.md` — the **template for your output**, and binding for anything
   M2 touches that M1 already settled (Food gate, storage, Influence definition, config
   injection, the "numbers vs shapes" convention).
3. `docs/PROGRESS.md` — what actually exists today: `game-core` formulas/config, the Mongo
   schemas, the `events` scheduler, auth/sessions, outer-ring placement, the base screen.
   Read the M1 milestone summaries and the debt list; design **on top of what shipped**, not
   on top of the plan's intentions.
4. `docs/CONCURRENCY_PLAYBOOK.md` — every new command you design (send movement, cancel,
   scout, found settlement, trade) must be expressible as the recipe in there: transaction +
   version guard, resources settled first, event scheduled inside the same transaction,
   idempotent handler. If a decision of yours cannot follow that recipe, say so explicitly.
5. `docs/ASSET_PROMPTS.md` + `art/` — art is the **owner's** job; never block on it. Note that
   `art/raw/terrain_tiles.png`, `icons_resources_markers.png` (incl. village markers) and
   `source_antenna.png` **already exist**, while the slicing pipeline (`tools/assets`) does
   not. Whether M2 slices them or ships flat placeholder tiles is a scope question for the
   owner (see agenda §5).

## Method

- **Round 1 — the full agenda.** Work through the agenda below and put every genuinely open
  item to the owner as a **concrete question with 2–4 concrete options**, each with its
  trade-off, plus **your recommendation and why**. Never ask an open-ended "what do you want?"
  when you can propose. Batch the questions; mark each as **blocking** (M2 cannot be specced
  without it) or **deferrable** (a default can stand, note the default).
- **Round 2 — consequences.** Take the owner's answers, work out what they imply (edge cases,
  interactions with M1 rules, what they make impossible in M3–M5), and come back with the
  second, smaller round. This is where the M1 session earned its value.
- **Decide the micro-stuff yourself.** Purely technical details with no product consequence
  (index shapes, DTO names, file layout) are yours — record them, don't ask.
- **Never invent product design silently.** If something is undecided and the owner has not
  answered it, it goes into the record as an explicit open item with a stated default, not as
  a quiet assumption.
- **Numbers vs shapes** (inherited from M1): mechanics and curve *shapes* are final; concrete
  *numbers* are first-pass drafts, live in the injectable `GameConfig`, and are tuned by
  `tools/sim` in M4. Say which is which for every number you write down.
- **Sanity-check against the source material.** Where a Travian analog exists (travel time,
  scouting, merchants, settlers), check the public Kirilloid formulas before proposing, and
  say what you compared against.

## Agenda — what M2 must decide

The plan's acceptance criterion for M2 is: ***"scout another settlement from the map and read
the report."*** Everything below exists to make that sentence unambiguous and buildable.

### 1. World generation

- Generation model: deterministic from a stored seed vs materialised tile documents. Is the
  map stored at all (3,721 tiles), or derived on demand from the seed?
- Terrain distribution and whether v1 terrain is **cosmetic only** (plan says yes — confirm)
  or already carries movement modifiers.
- **Signal Source** at the centre: 3×3 visual footprint / one logical tile — what is blocked
  around it, can anything be settled adjacent, what does the tile return before Act 3.
- **Farm oases**: how many, distribution rules (distance from centre, from each other, from
  settlements), whether they have tiers, what they hold, whether they carry defenders in M2 or
  only from M3, and whether their loot regenerates.
- Settleability rules: which tiles accept a settlement, minimum distance between settlements,
  and how this interacts with M1b's outer-ring placement (a player must not spawn on a lake or
  on top of an oasis).
- World lifecycle: when generation runs (empty-DB bootstrap? explicit command?), what the
  `world` singleton stores (seed, round number, act), and how a round wipe regenerates it.
- **NPC seeding stub** (plan lists it in M2): does M2 place inert placeholder settlements to
  make the map non-empty, and if so — real accounts or fixtures, with or without troops? Full
  NPC behaviour is M4; decide the stub's exact boundary.

### 2. Map data & API

- What the client fetches: the whole map once (3,721 tiles is small) vs viewport windows;
  refresh/caching policy on a phone; payload budget on a 1-core/2 GB VPS.
- **Visibility model**: is tile occupancy public to everyone (Travian-style) or is there fog?
  What a tile exposes without scouting (owner name, faction, side, settlement size?) versus
  what only a scout report reveals.
- The `movements` view: what the player sees about in-flight movements (own, incoming), and
  what an attacker/defender is allowed to know before arrival.

### 3. Movement

- **Grid topology: bounded or wrap-around?** Travian wraps. This is blocking — it changes the
  distance metric, the fairness of outer-ring spawns, and the map UI's panning.
- Distance metric (Euclidean vs Chebyshev on the square grid) and the travel-time formula,
  including the `travel` SPEED multiplier (~2–3) and the plan's target of **2–4 h across half
  the map** for an average unit. Propose the anchor numbers as a **§0-style contract**, the way
  M1 anchored progression — M2's equivalent is a travel-time table the simulator can check.
- Command shape: send / recall / return. Can a movement be cancelled, and within what window?
  What happens on arrival at a tile whose state changed (settlement gone, oasis emptied)?
- Which movement types M2 ships (`scout` is required by the acceptance criterion; `settle`,
  `trade`, `support` are candidates) and which slide to M3.
- Event types the scheduler gains (`movementArrive`, `movementReturn`, …), their idempotency
  story, and what a crash mid-flight must not double-apply.

### 4. Scouting & reports — the crux

Troop **training is M3**, but M2 must scout. Resolve this explicitly; it is the single most
important question of the session:

- Where do scouts come from? Options include: a minimal scout-only training path shipped early
  in M2; a fixed number of starting scouts per settlement; or scouting as a **Radio Tower
  "op"** that spends resources and needs no units (plan §2.4 describes the Radio Tower as
  exactly that). Each has knock-on effects on M3's combat model — spell them out.
- Resolution model: scout-vs-scout (needs defender troops → depends on the above) versus a
  **Radio Tower level differential** (plan §2.6). What a successful, partial and failed scout
  yields.
- Report contents by intel level: resources, buildings, troops, coordinates, timestamps.
- Detection: does the defender learn they were scouted, always or conditionally?
- Report persistence: the `reports` collection, read/unread state, retention, pagination, and
  what the UI needs.
- Does **beginner protection** (72 h, M3 by plan) cover scouting in M2? If nothing protects a
  new player from being scouted, say so and decide deliberately.

### 5. Map UI

- Rendering approach: DOM tile grid vs canvas, given `image-rendering: pixelated`, 61×61,
  viewport culling, and mobile pan/zoom. Tile size(s) and zoom levels.
- Tile art in M2: slice `art/raw/terrain_tiles.png` now (pulling `tools/assets` forward from
  M6) or ship flat palette-coloured tiles as placeholders. Owner's call.
- Interactions: tap a tile → info sheet → available actions; jump-to-coordinates; recentre on
  own settlement; how in-flight movements and their countdowns are presented (client-side
  countdowns from `game-core` against the server clock, as in M1c).
- Navigation: the Map tab activates; what the Reports tab shows in M2, if anything.
- Every new string behind an i18n key, RU shipped (M1c convention).

### 6. Influence, second settlement, Market

Both were deferred from M1 into M2 by the plan, and both need a scope decision:

- Influence: thresholds for settlements #2/#3, where the value is surfaced in the UI, and
  whether M2 ships the **settler convoy** (a `settle` movement founding a real second
  settlement) or only the gating and display.
- Market: merchants travel on the map like armies, so M2 has the infrastructure — but does
  trading ship in M2, or slide to M3? Decide, and record the reason.

### 7. Non-functional

- All new formulas (distance, travel time, scouting resolution) live in **`game-core`**, pure
  and tested; the server stays authoritative; the client reuses the same functions for
  previews and countdowns.
- No new infrastructure. Mongo 7 + the `events` collection only — no Redis, no queue library.
- Index plan for the new query patterns (`{x,y}` lookups, movements by `arriveAt`, reports by
  account) and the cost of the map fetch on the target VPS.

### 8. M2 decomposition & acceptance

Close the record with a proposed split into sub-milestones — M1's a/b/c split is the model
(foundations → server flows → UI) — each with **its own verifiable acceptance criterion**
phrased as something that can be executed and observed, not "feature X works". The overall
criterion stays the plan's: *scout another settlement from the map and read the report.*

## Output format for `docs/M2_DESIGN_DECISIONS.md`

Mirror `M1_DESIGN_DECISIONS.md`:

1. Header: status **RESOLVED**, the date, and the note that this file is binding for M2 and
   beats the plan on conflict.
2. The "numbers vs shapes" paragraph.
3. **§0 — the anchor contract**: for M1 it was the three reference players; for M2 it should be
   the travel-time / map-reachability table the simulator can verify against.
4. Numbered sections, one per agenda area. Every decision states: **what was decided**, **why**,
   and **which alternatives were rejected and on what grounds** — the rejected options are what
   stops the decision being reopened in three weeks.
5. A closing list of anything deliberately deferred (to M3/M4/M6), each with the reason and the
   milestone that owns it.
6. If any decision contradicts `IMPLEMENTATION_PLAN.md`, list the exact edits the plan needs;
   do not silently diverge.

## Hard rules

- No production code, no dependencies, no schema migrations — this session ends with one
  markdown file (plus, if needed, a listed set of plan edits).
- Never `git commit` or `git push`; the owner commits personally.
- Do not reopen the locked decisions in `IMPLEMENTATION_PLAN.md` §1 or anything settled in
  `M1_DESIGN_DECISIONS.md`. If you believe one of them is wrong, raise it as a flagged
  question — do not quietly design around it.
- Do not generate or wait on art; placeholders are always acceptable.
- Ask the owner about product/design; decide technical micro-details yourself and record them.
