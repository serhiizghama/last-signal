# M3 — Combat, expansion & trade: design decisions (RESOLVED)

**Status: every item below is DECIDED** — settled with the owner in the design session of
2026-08-17 (two rounds of structured Q&A, the shape `docs/M2_DESIGN_SESSION_PROMPT.md`
prescribes). **Four later owner amendments are recorded in §24** — read it alongside §4 and
§5, which it amends. This document is the **binding design record for M3**; for M3 scope it
**wins over `IMPLEMENTATION_PLAN.md`** if the two ever disagree, and it inherits everything
`M1_DESIGN_DECISIONS.md` and `M2_DESIGN_DECISIONS.md` settled — the Food gate, storage
caps, the Influence definition, config injection, numeric conventions, the concurrency
playbook, Chebyshev distance, the travel-time contract, the scouting model. Those are not
reopened here; where M3 extends one, the section says so explicitly.

**Numbers vs shapes** (inherited from M1). Mechanics and curve *shapes* below are final.
Specific *numbers* (unit stats, siege resistance, loot capacities, cache protection,
exchange spread, protection duration, oasis yields) are first-pass drafts: they live in the
injectable `GameConfig`, are sanity-checked against Kirilloid where a Travian analog exists,
and are tuned by `tools/sim` in M4 against §0. No number below is sacred; every shape is.
Each section marks which is which.

**Owner decisions taken in this session** (the four that shaped everything else, plus the
four consequence questions of round 2):

| # | Question | Decision |
|---|---|---|
| 1 | M3 scope | **Full plan scope, five sub-milestones M3a–M3e.** Nothing slides a third time. |
| 2 | Battle formula | **Travian T3.6 shape with our numbers** — points vs points, infantry/cavalry defence split, wall multiplier, the same 1.5-power casualty curve already shipped for scouts. No morale, no bash points. |
| 3 | Founding | **Three "Settler" units, trained at the Command Center** — a faction-neutral 16th unit type, consumed on founding; the Influence threshold stays the gate. |
| 4 | Destruction | **No razing. Command Center floor at level 1** — a settlement always survives. |
| 5 | Market | **Player↔player offers + a faceless world exchange post** at a fixed rate with a spread. No named NPC counterparties before M4. |
| 6 | Support upkeep | **The host settlement feeds stationed support**, as in Travian. |
| 7 | Starvation | **Hourly tick, kills the weakest first until net Food ≥ 0.** No grace period. |
| 8 | Telegram | **Notification layer + provider interface now, in-app/WS provider live, real bot smoke-tested at M7** — the same treatment TG auth already got in M1 §13. |

---

## 0. Combat & raid-economy contract (the anchor)

M1's anchor was three reference players; M2's was a travel-time table. M3's is a **battle
reference table plus raid-economy bounds**. The table rows are hand-computable and must be
reproduced *exactly* by `game-core` unit tests; the bounds are what `tools/sim` (M4) checks.

**Fixed shape.** `atkPts` = Σ (unit attack × count) over the arriving army. `defPts` = the
defenders' infantry/cavalry defence, weighted by the attacker's own infantry/cavalry attack
split, then multiplied by the wall factor. `x = min(1, (defPts / atkPts) ** lossExponent)`
with `lossExponent = 1.5` — **the same constant and the same curve family already shipped
for scout-vs-scout in M2 §8**, promoted from `config.scouting.lossExponent` to a shared
`config.combat.lossExponent` (§5). Losses round to the nearest whole unit, distributed
proportionally across unit types.

**The four battle rows** (draft numbers from §1, `combat.randomFactor` pinned to 0 in these
tests — see §5 on why the live game rolls and why the roll is deterministic):

| # | Attacker | Defender | Wall | atkPts | defPts | x | Attacker loses | Defender loses |
|---|---|---|---|---|---|---|---|---|
| 1 | 100 Brute (assault) | 20 Torcher | — | 4000 | 700 | 0.073208 | **7** Brute | **20** (100%) |
| 2 | 100 Brute (**raid**) | 20 Torcher | — | 4000 | 700 | 0.073208 | **7** Brute | **19** |
| 3 | 100 Brute (assault) | 20 Torcher | L10 | 4000 | 940.74 | 0.114055 | **11** Brute | **20** (100%) |
| 4 | 50 Brute + 20 Biker (assault) | 30 Torcher | — | 4200 | 1442.86 | 0.201354 | **10** Brute + **4** Biker | **30** (100%) |

Derivations, so a future reader can re-check them without re-running anything:

- Row 1: `700/4000 = 0.175`, `0.175^1.5 = 0.0732078` → `100 × 0.0732078 = 7.32` → 7.
- Row 2 (raid, §6): attacker `x/(1+x) = 0.068214` → `6.82` → 7; defender `1/(1+x) =
  0.931786` → `20 × 0.931786 = 18.64` → 19. One Torcher survives — that is the whole point
  of a raid being "partial engagement".
- Row 3: wall factor `1.03^10 = 1.343916`, `700 × 1.343916 = 940.7415`;
  `(940.7415/4000)^1.5 = 0.114055` → `11.41` → 11.
- Row 4: infantry share `2000/4200 = 0.47619`, cavalry share `0.52381`;
  `defPts = 0.47619 × (30 × 35) + 0.52381 × (30 × 60) = 500 + 942.857 = 1442.857`;
  `x = 0.201354` → Brute `50 × x = 10.07` → 10, Biker `20 × x = 4.03` → 4.

**The loot row** (§6): 93 surviving Brutes × carry 60 = **5580** capacity against a target
holding scrap 3000 / fuel 1200 / electronics 400 / food 2000 behind a **Hidden Cache L5**
(`200 × 1.35^4 = 664.30` protected per resource): available = 2335.70 / 535.70 / **0** /
1335.70 = **4207.10 total**, below capacity, so all of it is taken and the cache is what
saved the Electronics entirely. Tested as a fifth contract row.

**Bounds `tools/sim` must verify in M4** (a tuning pass that breaks one of these is wrong,
not the contract):

1. **Raid share of income** stays inside M1 §0: hardcore 40–50 %, regular 10–25 %, casual
   ≤ 10 % by day 21; the hardcore/casual economy gap stays ≤ 2–2.5×.
2. **Hidden Cache L5 protects ≥ 8 h of a day-7 Casual player's production, per resource.**
   If it does not, the *cache curve* is wrong, not the raid rules — this is the fairness
   valve M1 §5 added the building for.
3. **An offence stack pays for itself**: a Marauder-profile army raiding NPC farms recoups
   its own training cost plus Food upkeep within ≤ 2.5 game-days of continuous raiding —
   otherwise raiding is a hobby, not the Travian DNA the plan locks in §1.
4. **Travel bounds from M2 §0 continue to hold** with the real roster: average combat
   infantry crosses half the map in 2–4 h (our infantry speeds 5–7 at `SPEED.travel = 2`
   give 3.0 h / 2.5 h / 2.14 h ✔), scouts ≤ 1.7 h ✔, nothing crosses the full map in under
   40 min (fastest is the Dune Buggy at 19 → 1.58 h ✔).
   **Explicit extension of the M2 §0 table:** siege at speed 3–4 crosses half the map in
   3 h 45 m – 5 h. That is deliberately *outside* the 2–4 h band — siege is not an "average
   combat unit", and slow siege is what makes an assault a planned operation rather than an
   impulse. M2 §0's italic "siege (~4)" reference row is superseded by §1's real numbers.
5. **No stalemate wall:** at equal resource investment, a pure-defence stack behind a L20
   wall must still be beatable by an attacker spending ≤ 2× its value. If it is not, the
   wall ratio or the defence stats are wrong.

---

## 1. The unit roster — the remaining 12, plus the Settler

- **Decided (shape):** M2 shipped 3 of the 15 planned units (the faction scouts). M3 ships
  the remaining **12** — offence infantry, defence infantry, fast (cavalry analog) and
  siege for each faction — plus a **16th, faction-neutral `settler`** (owner decision 3).
  Every unit lives in the existing `config.units` catalogue with the existing `UnitDef`
  shape, widened (§19).
- **`UnitDef` gains** (technical, recorded): `attack`, `defInfantry`, `defCavalry`,
  `carry` (loot capacity), `splitClass: 'infantry' | 'cavalry'` (which side of the
  defence split this unit's *attack* counts toward), `trainedIn: BuildingType`, and for
  siege only `wallDamage` / `buildingDamage`. `UnitRole` widens from `'scout'` to
  `'offenseInfantry' | 'defenseInfantry' | 'fast' | 'scout' | 'siege' | 'settler' |
  'wildlife'`. `faction` becomes `Faction | null` — `null` marks units no account can
  train (the Settler is trainable by everyone, so it keeps a real marker; §10's oasis
  defenders are the `null` case).
- **Scouts gain regular combat stats too** (`attack: 0`, `defInfantry: 20`,
  `defCavalry: 10`): a scout sitting at home now contributes a little real defence and dies
  in a real battle, exactly as in Travian. Their `scoutAttack`/`scoutDefense` fields are
  untouched — scout-vs-scout resolution (M2 §8) is a separate system and stays as shipped.
- **Scouts may not be added to a raid or assault army** (validation rejects it at send).
  *Rejected:* Travian lets you send them along to die. In a world where a new player owns
  two scouts total and the M2 onboarding loop is "train a scout, send it", quietly
  incinerating them in a raid is a trap, not a lesson.

**Draft stats** (classic x1, before `SPEED.training = 5` and before the new Barracks/Machine
Shop time curve of §2). Re-expressed from Kirilloid T3.6 in our §1 resource roles: Scrap =
mass, Fuel = vehicles/speed, Electronics = tech gate, Food = upkeep.

| Unit | Faction | Role | Split | Atk | DefInf | DefCav | Spd | Carry | Scrap | Fuel | Elec | Food | Train (s) | Upkeep | Trained in |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Brute | Raiders | offence inf | inf | 40 | 20 | 5 | 7 | 60 | 95 | 15 | 0 | 25 | 300 | 1 | Barracks |
| Torcher | Raiders | defence inf | inf | 10 | 35 | 60 | 7 | 40 | 70 | 30 | 10 | 25 | 380 | 1 | Barracks |
| Lookout | Raiders | scout | inf | 0 | 20 | 10 | 9 | 0 | 120 | 40 | 20 | 30 | 1200 | 1 | Barracks |
| Biker | Raiders | fast | **cav** | 110 | 45 | 60 | 10 | 90 | 180 | 230 | 50 | 60 | 1150 | 3 | Machine Shop |
| Ram Truck | Raiders | siege | inf | 65 | 30 | 80 | 4 | 0 | 300 | 180 | 60 | 80 | 1800 | 3 | Machine Shop |
| Exo-Trooper | Engineers | offence inf | inf | 70 | 40 | 25 | 7 | 50 | 130 | 45 | 30 | 30 | 420 | 1 | Barracks |
| Bulwark | Engineers | defence inf | inf | 30 | 65 | 35 | 5 | 20 | 115 | 35 | 40 | 30 | 440 | 1 | Barracks |
| Surveyor Drone | Engineers | scout | inf | 0 | 20 | 10 | 16 | 0 | 100 | 80 | 60 | 20 | 1600 | 1 | Barracks |
| Armored Quad | Engineers | fast | **cav** | 120 | 65 | 50 | 14 | 100 | 230 | 290 | 95 | 70 | 1350 | 3 | Machine Shop |
| Rail Sling | Engineers | siege | inf | 75 | 60 | 10 | 3 | 0 | 330 | 200 | 170 | 90 | 2100 | 4 | Machine Shop |
| Skirmisher | Nomads | offence inf | inf | 65 | 35 | 20 | 6 | 45 | 105 | 35 | 15 | 30 | 360 | 1 | Barracks |
| Hunter-Sniper | Nomads | defence inf | inf | 15 | 40 | 50 | 7 | 35 | 85 | 25 | 20 | 25 | 340 | 1 | Barracks |
| Falconer | Nomads | scout | inf | 0 | 20 | 10 | 17 | 0 | 110 | 50 | 30 | 30 | 1300 | 1 | Barracks |
| Dune Buggy | Nomads | fast | **cav** | 90 | 25 | 40 | 19 | 75 | 175 | 245 | 55 | 60 | 1250 | 2 | Machine Shop |
| Ballista Wagon | Nomads | siege | inf | 70 | 45 | 10 | 3 | 0 | 295 | 175 | 95 | 80 | 1900 | 3 | Machine Shop |
| **Settler** | *any* | settler | inf | 0 | 80 | 80 | 5 | 0 | 900 | 700 | 400 | 500 | 4000 | 1 | **Command Center** |

Siege damage attributes (§7), draft:

| Unit | wallDamage | buildingDamage | Identity |
|---|---|---|---|
| Ram Truck | 8 | 3 | Raiders break gates |
| Rail Sling | 3 | 9 | Engineers level buildings |
| Ballista Wagon | 4 | 6 | Nomads are the generalists |

Faction identity check against §1 of the plan: Raiders are cheapest per attack point and
train fastest; Engineers cost the most, pay Electronics, and hit hardest per unit; Nomads
are the fastest and the best per Scrap spent on defence. **No faction gets a flat combat
multiplier** — identity lives entirely in the stat table. *Rejected:* Travian-style tribe
bonuses (Roman +wall, Gaul +cranny, Teuton +cranny-steal) — three more special cases in the
battle engine for flavour the stat table already carries.

## 2. Training, generalized

- **Decided (shape):** M2b.2's command generalizes from `trainScouts` to `trainUnits`. Its
  recipe is unchanged — settle → validate → deduct the whole batch at enqueue →
  version-guarded write → chained `trainingComplete` events crediting **one unit at a
  time**. That shape is already proven and re-used verbatim.
- **One active order per training building, three in parallel** (Barracks, Machine Shop,
  Command Center). M2b.2's `MAX_ACTIVE_TRAINING_ORDERS = 1` becomes "1 per building"; the
  `trainingQueue` array already tolerates more than one entry, so no schema change.
  *Rejected:* one global order (blocks the mid-game entirely — you would choose between
  defence and siege for hours); unlimited queued orders (Travian appends; our audience is
  casual, and the build queue already settled on "one active + 2 waiting" in M1 §6 — a
  deeper training queue can be widened later without a migration).
- **No cancel for training**, unchanged from M2b.2. *Rejected:* refunding a siege order
  after seeing an incoming attack in the incoming panel (§12) is an obvious exploit.
- **Training time now scales with the training building's level** (new, and the reason
  Barracks levels stop being dead weight): `timeFactor = training.buildingTimeRatio **
  (level − 1)`, draft ratio **0.91** → a L20 Barracks trains **6.0×** faster than L1
  (`0.91^19 = 0.1666`). The same
  shape as the Command Center's build-time divisor (M1 §3), the same config style.
  *Rejected:* per-level troop-capacity or per-level unlock tiers — more state, and the plan
  gives Barracks exactly one job.
- **Prerequisites (final):** Barracks trains offence infantry, defence infantry and scouts;
  Machine Shop trains fast and siege units (plan §2.4, unchanged); the Command Center
  trains Settlers with **no extra level requirement** beyond the Influence threshold the
  founding action already checks (§13). Faction lock is unchanged from M2b.2: you may only
  train your own faction's units — the Settler being faction-neutral is the single
  exception, and it is exactly why it lives on the CC and not in the Barracks.
- **The absolute net-Food gate (M1 §4) applies to every training order, whole batch
  included** — the existing `wouldStarveWithTroops`. With cavalry at upkeep 3 and siege at
  3–4, this gate is now the real constraint on army size, which is the intent.

## 3. Troop accounting: home, away, stationed — and who pays Food

This section exists because M2 left a hole and M3 must close it before combat makes it
expensive.

- **The hole:** M2b.3 deducts units from `settlements.troops` at send. Food upkeep is
  computed from `troops`, so **a scout costs nothing while it is marching** — send your
  whole army out and your upkeep drops to zero. Harmless with three scouts; a live exploit
  the moment armies exist.
- **Decided (final):** a settlement document carries three troop lists and pays upkeep on a
  well-defined subset of them:

| Field | Contents | Who pays its Food |
|---|---|---|
| `troops` | own units at home | this settlement |
| `awayTroops` | own units currently **in transit** (any movement, any leg) | this settlement |
| `stationedTroops` | **foreign** units stationed here as support, tagged with `ownerAccountId` + `fromSettlementId` | **this settlement** (owner decision 6) |

  `awayTroops` is a denormalized counter maintained **inside the same transaction** as
  every send / arrive / return, so the upkeep computation stays a pure function of one
  document — no cross-document reads, the lazy-resource model (M1 §4, playbook §3)
  survives untouched. Units move `troops → awayTroops` at send, `awayTroops →
  stationedTroops` (on the *host*) when support arrives, back to `awayTroops` when recalled,
  and back to `troops` on return home. Losses are removed from whichever list holds them.
- **Upkeep = `troops` + `awayTroops` + `stationedTroops`.** A player marching an army pays
  for it; once it plants itself in an ally's settlement, the ally feeds it. Travian's rule,
  and the only one that keeps the arithmetic inside one document.
- **The griefing edge, accepted with a mitigation:** you can dump an army on a friend and
  starve them. Mitigation: the host can send any stationed contingent home at any time with
  one command, instantly and without cost (§8), and the settlement view shows the Food cost
  of each contingent. *Rejected:* an accept/decline handshake for support (a defender
  asleep when the attack lands cannot accept — the feature would fail exactly when it
  matters).
- `game-core`'s existing optional-`troops` parameters (`calcNetFoodPerHour`, `calcNetRates`,
  `settleResources`, `msUntilFull/Empty/Affordable`, `wouldStarveSettlement`) take the
  **union** of the three lists. The client's `toTroopCounts` selector mirrors it, as it
  already does for home troops.

## 4. Starvation

- **Decided (owner decision 7):** while a settlement's net Food is negative **and** its
  stored Food is 0, a `starvationTick` event fires **every hour** and kills units — weakest
  first — until net Food ≥ 0 again. No grace period, no percentage.
- **"Weakest" is defined once, in `game-core`** (`starvationOrder`): ascending by
  `attack + defInfantry + defCavalry`, ties broken by ascending training cost, then by unit
  id — fully deterministic, no clock, no randomness. Settlers are killed **last** (they are
  a 2100-resource investment with 80/80 defence; losing them to a Food dip would be
  brutal); scouts die before combat units by the sum rule anyway.
- **Kill order across the three lists:** `stationedTroops` (foreign support) is starved
  **first**, then `awayTroops`, then `troops`. Rationale: the host is starving *because* of
  the guests, and killing the host's own defenders first would turn "an ally helped me" into
  "an ally destroyed me". Every owner whose units died gets a report (§15).
- **The event is scheduled lazily**, not per settlement per hour: when a command or handler
  settles a settlement and sees net Food < 0, it schedules the first `starvationTick` at the
  exact instant stored Food reaches 0 (`msUntilEmpty`, which already exists); the handler
  re-checks and re-schedules or stops. ~150 settlements never generate a background tick
  storm — consistent with the plan's "nothing ticks in the background".
- **Buildings never starve** (M1 §4, unchanged). Starvation only ever kills troops.
- *Rejected:* the grace hour + push (weakens Food as the army cap, and the notification
  layer already pushes "your troops are starving" on the first kill); a fixed percentage per
  hour (does not self-correct — a settlement could bleed for a day and lose everything).

## 5. Battle resolution — the crux

- **Decided (owner decision 2): the Travian T3.6 shape with our numbers.** One pure
  function in `game-core`: `resolveBattle(config, { attacker, defenders, wallLevel, kind,
  roll })` → losses per unit type per participant, loot capacity, and the siege pass (§7).
  No morale, no bash points, no "immensity" exponent shift.
- **Steps (final):**
  1. `atkPts = Σ (unit.attack × count)`, split into `atkInf` / `atkCav` by
     `unit.splitClass`. An army with `atkPts = 0` is rejected at send, not at arrival.
  2. `defPts = (atkInf/atkPts) × Σ defInfantry + (atkCav/atkPts) × Σ defCavalry`, summed
     over **every** defending contingent: the target's own `troops` plus every
     `stationedTroops` entry. Troops of the defender that are away do not defend.
  3. **Wall:** `defPts ×= wall.defenseRatioPerLevel ** wallLevel`, draft **1.03** → L20 =
     1.806×. A single multiplier, no flat bonus, no per-faction wall.
  4. **Deterministic roll:** `atkPts ×= 1 + combat.randomFactor × r`, where `r ∈ [−1, 1]` is
     derived from `hash(world.seed, movementId)` via the FNV-1a + mulberry32 pair already in
     `game-core/map/rng.ts`. Draft `randomFactor = 0.05`.
     **Why deterministic and not `Math.random()`:** battle resolution runs inside a
     scheduler handler that must be replay-safe (playbook §4) and inside `tools/sim`, which
     must be reproducible. A wall-clock random number would make a crash-replay produce a
     *different* battle than the one the report already described. Tests pin
     `randomFactor: 0` and get the exact §0 table.
  5. `x = min(1, (defPts / atkPts) ** combat.lossExponent)`, `lossExponent = 1.5`.
  6. Apply the loss fractions of §6 by `kind`, distribute proportionally per unit type,
     round to nearest (JS `Math.round`, .5 up — the same convention M2b.1 already locked and
     tested for scouts).
- **`config.scouting.lossExponent` is promoted to `config.combat.lossExponent`** and the
  scouting module reads the shared value. One curve family for the whole game: a player who
  has learned to read scout losses can read battle losses. `config.scouting` keeps
  `buildingsTierMinDiff`. `configVersion` 6 → 7.
- **Defender losses are shared across contingents proportionally to each contingent's
  contribution to `defPts`** — an ally who sent 10 % of the defence loses 10 % of the
  casualties, not 10 % of *their* stack. Travian's rule, and the only one that does not
  punish whoever's units happen to be listed first.
- *Rejected:* full Kirilloid fidelity with morale — morale is a function of population,
  a quantity this game does not have (Influence is not population, and reusing it would tie
  combat strength to build order in a way nobody could predict); it would also add a term
  `tools/sim` must model before it can tune anything. *Rejected:* the linear model — with no
  exponent, a marginally stronger army loses almost as much as an even one, which erases the
  "commit properly or don't come" tension the whole military layer exists for.

## 6. Raid vs Assault, loot and the Hidden Cache

- **Two attack types (final), differing in exactly three things** — casualties, siege, and
  whether the wall must fall:

| | Raid | Assault |
|---|---|---|
| Attacker losses | `x / (1 + x)` | `x` |
| Defender losses | `1 / (1 + x)` | `100 %` |
| Siege pass | never (siege units may not be sent) | yes (§7) |
| Loot | up to surviving carry capacity | up to surviving carry capacity |

  In an even fight (`x = 1`) a raid costs both sides 50 %; an assault costs both sides
  everything. That is the Travian distinction and it is exactly the "partial engagement"
  the plan §2.6 asks for.
- **Loot (final):** `capacity = Σ (unit.carry × surviving count)`.
  `available(resource) = max(0, stored − hiddenCacheProtection)`, where protection is
  `hiddenCache.base × hiddenCache.ratio ** (level − 1)` **per resource**, draft base **200**,
  ratio **1.35** (L5 = 664.3, L10 = 2978.7 each). If `Σ available > capacity`, the take is distributed
  **proportionally to availability**, so a raider cannot cherry-pick Electronics.
- **Loot rides home on the movement document and is credited on return**, then clamped to
  the attacker's storage caps; anything over the cap is lost and the report says so. (M1 §5:
  production halts at cap; loot behaves the same way, no retroactive waste, no overflow
  bucket.)
- **The defender's resources are settled inside the arrival transaction before looting** —
  the same discipline M2b.3 already applies to the scouting snapshot, so the number stolen
  is the number that existed at that instant.
- **The Hidden Cache is faction-neutral in v1.** *Rejected:* Travian's "Teutons steal from
  the cranny" — it makes the one building that protects casual players worthless against the
  faction most likely to attack them, which is the opposite of why M1 §5 added it.
- **An unsuccessful attacker loots nothing** (attacker wiped, or `x = 1`). A partially
  destroyed raiding party loots to its *surviving* capacity.

## 7. Siege, the Wall, and what can be destroyed

- **Decided (owner decision 4): a settlement can never be destroyed.** The Command Center
  cannot be knocked below **level 1** (`siege.commandCenterFloor: 1`); every other building
  can be knocked to 0 and rebuilt. No capture, no razing, consistent with the plan's locked
  "no village capture in v1".
- **Order of operations at an assault (final):** resolve the battle (§5, with the wall
  bonus applied) → if the attacker has surviving siege units, run the **siege pass**.
  A defeated attacker never gets a siege pass.
- **Siege pass:** the assault order carries `siegeTarget: 'wall' | <buildingType>`.
  Surviving siege units contribute `Σ wallDamage` and `Σ buildingDamage` points.
  **The wall is always breached first** (plan §2.6): while `wallLevel > 0`, wall points are
  spent knocking wall levels; only once the wall is at 0 do building points go to
  `siegeTarget`. If `siegeTarget === 'wall'`, building points are wasted — that is the
  attacker's choice.
- **Knocking one level from level `L` costs** `siege.resistanceBase × siege.resistanceRatio
  ** (L − 1)` points, draft base **6**, ratio **1.18**. Levels are consumed one at a time
  until the points run out; leftover points are discarded (no carry-over between attacks).
  Worked draft: 10 Ram Trucks = 80 wall points against a L10 wall → 26.61 + 22.55 + 19.11 =
  68.28 spent, L10 → **L7**, 11.72 points left (the L7 step needs 16.19, so they are
  discarded).
- **Consequences of a destroyed level, resolved here so no handler discovers them later:**
  - **Settle resources first, then change levels** — production, upkeep and caps all depend
    on levels, so the settle must use the *pre-destruction* rates.
  - **Storage:** destroying a Warehouse or Cold Storage lowers the cap; stored resources are
    **clamped to the new cap** in the same transaction. The report states the loss.
  - **Food:** destroying a Greenhouse can push net Food negative — no special case, §4's
    starvation schedule simply arms itself.
  - **The build queue survives.** An in-flight upgrade keeps its `completesAt` (fixed at
    enqueue, as M1 already does — a Command Center knocked mid-build does not retime it),
    but on completion the handler sets `level = min(item.targetLevel, currentLevel + 1)`, so
    a queued "→ L8" that finds the building at L5 delivers **L6**, not a free three-level
    jump. The cost is not refunded; the levels are not gifted.
  - **The Command Center at its floor** absorbs no further points; they are discarded.
- *Rejected:* Travian razing (owner decision — a friend who loses their settlement overnight
  stops playing, and the round is three weeks long). *Rejected:* siege that only breaks
  walls — it makes an entire unit role decorative and removes the only counter to a
  turtling defender.

## 8. Support / stationing

- **Decided:** a `support` movement sends units to **any** settlement — your own or anyone
  else's, any side, as the plan §2.6 allows. On arrival the units become a
  `stationedTroops` contingent on the host (tagged with owner and origin), defend every
  battle there (§5), and eat the **host's** Food (§3, owner decision 6).
- **Two ways home, both instant to issue:** the owner recalls their own contingent, or the
  **host evicts it**. Either command turns it into a normal returning movement travelling at
  the contingent's slowest speed. The eviction path is the mitigation for the starvation
  griefing edge in §3.
- **Support cannot be sent to an oasis** (nothing to hold) and cannot be sent to a
  beginner-protected settlement (§11) — the protection is a blanket "no foreign movements
  arrive", and a supporter who cannot be evicted by a sleeping newbie is a Food attack.
- **Stationed scouts count** for the host's scout defence and for M2 §8 detection. The
  counter-report still goes to the **settlement owner only** — supporters are not
  intelligence subscribers. *Recorded because M2 §8 defined detection before support
  existed.*
- Losses among stationed contingents are reported to their owners (§15).

## 9. Movement types, commands and handlers

- **M3 widens `MovementType` from `scout` to:** `scout` (unchanged), `raid`, `assault`,
  `support`, `settle`, `trade`. The union was designed to widen (M2 §6 schema note); the
  status machine (`outbound | returning | done | cancelled`) is unchanged.
- **One arrival handler, dispatching by type** (technical, recorded): the existing
  `movementArrive` / `movementReturn` event types stay, and the handler resolves a
  per-type **arrival resolver** from a registry. *Rejected:* one event type per movement
  type — cancel, return, lease/sweep and the version-guard dance are identical for all six;
  duplicating them five times is exactly the drift `game-core` exists to prevent.
- **Every new command follows the playbook recipe verbatim.** All six fit; none needed an
  exception. The one genuinely new property is that an arrival touches **two** settlement
  documents, which the playbook §5 explicitly declines to cover — §18 designs it.
- **The 90 s cancel window (M2 §6) applies to every outbound movement type**, including
  `settle` and `trade`. Unchanged mechanism: flip to `returning`, delete the pending arrive
  event, schedule the return, all in one transaction.
- **Validation shared by every hostile movement** (`raid`, `assault`): target is another
  account's settlement or a farm oasis; not your own settlement; the target's owner is not
  beginner-protected (§11); every unit count ≥ 1 and available at home; the army has
  `atkPts > 0`; no scouts (§1); siege only on `assault`; `siegeTarget` names a real building
  type or `'wall'`. Each rejection gets its own stable i18n error key.
- **Zero-count entries are stripped at the command layer**, never passed to
  `slowestTroopSpeed` — the sharp edge M2a.2 recorded and M2b.2 handled for one unit type
  now applies to armies of six.
- **Arrival at a target that changed:** settlement missing → the M2b.3 `targetNotFound`
  report and turn-around, already implemented, now covering five more types. Oasis missing →
  same. A `settle` arrival whose tile is no longer legal → §13.

## 10. Oases: defenders, loot, regeneration, scouting and raiding

M2 placed 24 inert farm oases and explicitly deferred everything else here.

- **Defenders (final shape):** a small **wildlife roster** — units with `faction: null`,
  `role: 'wildlife'`, no cost, no training path, defence-only stats. Draft:

| Unit | DefInf | DefCav | Notes |
|---|---|---|---|
| Feral Dog | 25 | 20 | the filler |
| Scavenger Gang | 40 | 30 | the reason you bring a real army |

  Target composition per oasis is **derived deterministically from the world seed and the
  oasis coordinates** (the `tileRoll` helper already in `game-core/map/rng.ts`): draft
  `12 + roll(0..12)` Feral Dogs and `4 + roll(0..6)` Scavenger Gangs.
  *Rejected:* reusing faction units as "abandoned militia" — a Nomad player raiding a
  "Nomad" oasis reads as a bug.
- **Live state is persisted on the oasis document and accrues lazily**, exactly like
  settlement resources: `defenders`, `loot: { food }`, `lastRegenAt`, `version`. Any command
  or handler that touches an oasis settles it first. Draft regeneration: **one unit of each
  type per 2 h** up to the target composition; **120 Food/h** up to a **4000** cap.
  *Why lazy:* 24 oases × a background tick is 24 pointless events an hour; the M1 lazy
  pattern already solves this and is already tested.
- **Raiding an oasis** is a normal battle with `wallLevel = 0` and no siege pass; loot is
  Food only, capped by surviving carry capacity and by the pool. Raid/assault both allowed;
  assault simply wipes the defenders (they respawn).
- **Scouting an oasis is now allowed** (M2 §8 deferred it here): the report shows the
  defender composition and the current Food pool. No intel tiers — there is nothing deeper
  to gate.
- **Oases are still not annexable** (locked in the plan). No ownership field, no bonus to a
  nearby settlement. *Recorded so M4's Marauder brain does not assume otherwise.*

## 11. Beginner protection

- **Decided:** **72 h** (plan-locked) from the moment the account's **first settlement is
  created**, stored as `account.protectedUntil`. While it holds, **no foreign movement can
  target any of that account's settlements** — raid, assault, scout and support are all
  rejected at send with a distinct error key, and the map marks the settlement as protected
  so nobody wastes a march. This is M2 §8's "protection covers scouting as well as attacks",
  honoured.
- **It ends early when the protected account sends its first `raid` or `assault` at another
  account's settlement.** Scouting does **not** break it, and raiding an **oasis** does not
  break it.
  **Why the asymmetry is deliberate:** M2c's onboarding loop is literally "build a Barracks
  → train a scout → scout somebody"; a rule that strips a new player's protection for
  following the tutorial is a trap. Oasis raiding is the intended training ground for the
  same reason. The accepted cost: a protected account has a 72 h risk-free intel window.
  In a 15-friend world that is a fair trade. *Rejected:* the symmetric "any hostile movement
  ends it" rule, for exactly the reason above.
- **NPCs are covered too.** They are inert in M3, but M4's Marauder must respect
  `protectedUntil` — it will, because it goes through the same command service (plan §2.8),
  which is where the check lives.
- Protection is **not** extendable, not purchasable, and does not pause. Draft number:
  `protection.durationMs = 72 h`.

## 12. Incoming-movement visibility and the Radio Tower

M2 §8 deferred this whole surface to be "designed once, together with attacks". Here it is.

- **Decided (final):** `GET /api/movements/incoming` returns the hostile and friendly
  movements inbound to the caller's settlements, with detail gated by the **target
  settlement's Radio Tower level**:

| Tower level | What the defender sees about an incoming attack |
|---|---|
| any (incl. 0) | that an attack is inbound, its arrival time, and its origin tile + owner |
| ≥ 1 | raid vs assault, and the total unit count |
| ≥ 5 | full composition per unit type, including siege count and the siege target |

- **Incoming support is always fully visible** (it is help, and the host may need to evict
  it — §8). **Incoming scouts are never visible before arrival** — M2 §8's rule, kept: a
  scout you can see coming is not a scout.
- **Why level 0 still shows the attack:** the alternative is a casual player losing an army
  to an attack they had no way to know about, in a game where the Radio Tower needs CC 5 +
  Electronics Workshop 3 and therefore does not exist in Act 1. The tower buys *detail*, not
  the *existence* of the warning. Draft thresholds live in
  `config.radioTower.incomingTiers`. *Rejected:* Travian's rally-point gating (our rally
  point does not exist — movements depart immediately, M2 §6).
- **Nothing about incoming movements leaks into `GET /api/map`** — that payload's public-fields
  guard (M2a.6) stays exactly as it is, and this is a separate, ownership-scoped endpoint.
- Real-time: an `incomingAttack` WS event fires at send time to every target owner whose
  tier includes it, and a notification (§16) goes out on the same trigger.

## 13. Settler convoy and Influence-gated founding

- **Decided (owner decision 3):** founding costs **3 Settlers** (`settle.settlersRequired: 3`,
  config), trained at the Command Center (§1, §2), sent as a `settle` movement to a target
  tile.
- **The gate is checked twice** — at send and again at arrival — against the *existing*
  M1 §7 functions (`calcInfluence`, `settlementsAllowed`, thresholds `[90, 160]`, hard cap
  3). Influence is a threshold, never spent (M1 §7, unchanged). M2 §9 already displays it;
  M3 turns the display into an action.
- **Target legality reuses `isSettleable` verbatim** (M2 §3): on-grid, not a toxic lake, not
  an oasis, Chebyshev ≥ 3 from every existing settlement. The `{x, y}` unique index remains
  the final authority — a race between two convoys onto the same tile is resolved there, and
  the loser turns around.
- **On success:** a new settlement is created **with a Command Center at L1 and nothing
  else** — M1 §4's starting composition rule, deliberately including its consequence that
  the Greenhouse is the only legal first build there too. Starting resources: the same
  values a first settlement gets, so the new one is not born starving. The 3 Settlers are
  consumed.
- **On failure** (tile taken, no longer settleable, Influence dropped below the threshold
  because a building was destroyed in the meantime): the convoy **returns home with the
  Settlers alive** and a report explaining which check failed. *Rejected:* consuming the
  Settlers on a failed founding — 2100 resources destroyed by a race condition is not a
  game mechanic.
- **A settle convoy can be attacked?** No: movements cannot be intercepted in v1 (no such
  mechanic anywhere), so the convoy is safe in transit. The Settlers' 80/80 defence matters
  only when they are sitting at home. *Recorded because their defence stats invite the
  question.*

## 14. Market: offers, the world exchange, merchants

- **Decided (owner decision 5): both halves ship** — player↔player offers *and* a faceless
  **world exchange post**. No named NPC counterparties: the ~135 NPC accounts are inert
  until M4, and wiring them to answer offers would be M4's brain shipped early under a
  different name.
- **Merchants are not units.** A settlement's merchant count is `market.merchantsPerLevel ×
  Market level` (draft 1/level); each carries `merchant.capacityByFaction` and travels at
  `merchant.speedByFaction`, both faction-flavoured exactly as in Travian:

| Faction | Capacity per merchant | Speed (x1) |
|---|---|---|
| Raiders | 1000 | 12 |
| Engineers | 500 | 16 |
| Nomads | 750 | 24 |

  Merchants are **occupied** for the whole round trip and freed on return. They are never
  lost, never attacked, and consume no Food.
- **Offers (final):** a `tradeOffers` collection — `{accountId, fromSettlementId, give:
  {resource, amount}, want: {resource, amount}, merchantsNeeded, createdAt, expiresAt}`.
  **The offered resources are deducted at creation**, mirroring M1 §6's "deduct at enqueue"
  and removing the entire class of "the offer is no longer funded" races. Cancelling an
  offer refunds 100 %, as build cancellation does. Draft TTL **48 h**.
  **Ratio cap:** an offer must satisfy `1/2 ≤ give/want ≤ 2` in weighted value
  (`market.maxOfferRatio: 2`) — Travian's rule, and the thing that stops "I give 1 Scrap for
  10 000 Electronics" being used as a gift or a laundering channel.
  Accepting creates **two `trade` movements**, one in each direction, each occupying
  merchants at both ends.
- **The world exchange post (final):** available at any Market, converts resource A into
  resource B at a **fixed weighted rate with a spread** — draft `valueWeights = {scrap 1,
  fuel 1, food 1, electronics 2}` and `exchangeSpread = 0.25`. It occupies merchants for
  `market.exchangeTripMs` (draft 30 min) and then credits the result; nothing travels on the
  map because there is no counterparty to travel to.
  **It cannot print value** — every conversion loses 25 % — so it needs no daily cap, no
  cooldown and no anti-abuse state. That is why the spread exists in the first place, and
  why Electronics costs double: M1 §1's "Electronics is the deliberate bottleneck" survives
  a world where you can buy it.
- *Rejected:* P2P-only (in Act 1 there is nobody to trade with; the market would look broken
  until M4). *Rejected:* exchange-only (kills the social layer and the merchant convoys the
  plan explicitly wants on the map).

## 15. Reports

`ReportType` widens from three to eleven. Payloads stay **structured ids + numbers**, never
prose (M1 §15) — the client renders Russian from them, as M2c.3 already does.

| Type | Written for | Carries |
|---|---|---|
| `raid` / `assault` | attacker | both armies, losses per unit type, wall level before/after, buildings destroyed, loot taken, capacity used |
| `defense` | defender (settlement owner) | the same battle from the defending side, including which contingents took losses |
| `supportLoss` | each supporter who lost units | their own contingent's losses only |
| `oasisRaid` | attacker | defenders met, losses, Food taken |
| `settle` | sender | founded (with the new settlement id) or the failure reason |
| `trade` | both parties | resources delivered, merchants freed |
| `starvation` | settlement owner (and each affected supporter) | units lost, per type |
| `buildingDestroyed` | defender | building, level before/after, storage clamped |
| `scout`, `scoutFailed`, `scoutDetected` | unchanged from M2 | unchanged |

- **Both parties always get a report** (plan §2.6), and so does every supporter with
  casualties. Existing infrastructure carries them: the `{accountId, createdAt, _id}` cursor
  index, unread partial index, read-on-open, and the change-stream WS push all work
  unchanged for new types.
- **Retention** is unchanged: reports live for the round and are wiped at rollover (M5).

## 16. Notifications

- **Decided (owner decision 8):** M3 builds the **layer**, not the bot. A `notifications`
  outbox collection (`{accountId, kind, payload, createdAt, deliveredAt, provider}`) is
  written **in the same transaction** as the event that caused it; a small dispatcher drains
  it through a `NotificationProvider` interface.
- **Two providers in M3:** an **in-app/WS provider** (live, reuses the M2b.4 gateway) and a
  **Telegram provider stub** that logs the exact payload it would send. The real bot is
  wired and smoke-tested on the VPS **before M7**, exactly the treatment TG *auth* already
  has (M1 §13). This is a plan edit (§21) — M3's acceptance criterion stops being "TG push
  received".
- **Kinds in M3:** incoming attack, build queue finished, training order finished, battle
  report arrived, troops starving, settlement founded. Per-kind toggles live in the existing
  `account.settings`.
- **Operational debt paid here, not later:** M2b.4 recorded that a non-resumable
  change-stream error stops report pushes until a restart. The notification dispatcher makes
  push delivery load-bearing, so M3e adds resume-token persistence and a supervised restart
  for the stream. Recorded as in scope, not as debt.

## 17. UI scope (M3e)

- **Units tab activates** (the nav slot exists): the faction roster with stats, training
  from the Barracks / Machine Shop / Command Center cards, live queue countdowns reusing
  M1c's patterns, and an **army overview** showing home / away / stationed with each
  group's Food cost — the visible answer to §3.
- **Attack flow from the map tile sheet:** pick raid or assault, pick the army (bounded by
  what is actually at home), pick a siege target when siege is included, see the travel-time
  preview computed client-side from the same `travelTimeMs` (M2c.2's pattern), confirm.
  The 90 s cancel affordance behaves as it already does for scouts.
- **Incoming panel** on the Base screen: inbound attacks with live countdowns at whatever
  detail §12's tiers allow, plus inbound support.
- **Combat report view**: both armies, losses, loot, wall and building damage, rendered in
  Russian from the structured payload. Flat placeholders where art is missing —
  `art/raw/battle_art.png` exists but slicing stays **M6** (M2 §11's rule, unchanged).
- **Market tab activates**: own offers, the offer board with the ratio guard, the exchange
  form with its spread shown before confirming, and merchant availability.
- **Settle flow**: Influence progress (M2 §9's display) becomes a button once the threshold
  and 3 Settlers exist; the map marks legal tiles.
- **Protection badges** on the map and on the target sheet, so a protected target is
  obviously un-attackable before anyone builds an army for it.
- **i18n:** every string behind a key, RU shipped. Namespaces `common`, `buildings`,
  `resources`, `units`, `errors`, `reports`, `map` (existing) plus **`military`** and
  **`market`**.
- **Open UI question the owner still owns (carried over from M2c.1, not invented here):**
  NPC names are Latin-script next to an all-Cyrillic UI. It becomes more visible in M3 —
  battle reports name opponents constantly. Flagged, not decided.

## 18. Concurrency, determinism and the scheduler

- **The new hard case: an arrival touches two settlements and two accounts.** Playbook §5
  explicitly declines to cover this and says "design it against this playbook's shape, don't
  invent a new pattern". The design:
  1. One transaction per arrival.
  2. **Settle both settlements first** (attacker's home is needed for loot crediting only at
     return, so in practice: the target, plus every stationed contingent's owner is *not*
     touched — losses are recorded on the host document, and the owner learns via a report).
  3. **Version-guard every document written**, acquiring them in a **deterministic order —
     ascending `_id`** — so two concurrent multi-document commands can never deadlock by
     grabbing the same pair in opposite orders.
  4. Idempotency stays where it already is: the **movement's own `status`**. A replayed
     `movementArrive` finds the movement no longer `outbound` and no-ops — the shipped M2b.3
     pattern, unchanged, and the reason a re-run cannot double-loot.
  5. Version conflicts are retried by `runCommand` for player commands and by the
     scheduler's own backoff for handlers, exactly as today.
- **Battles serialize for free.** The scheduler is single-process and claims events strictly
  in `dueAt` order (playbook §4), so two attacks landing on the same settlement resolve in
  arrival order, and a support arriving one second before an attack defends it. Ties on the
  same millisecond break by `_id`. **This is now a load-bearing property, not an incidental
  one** — recorded here so nobody "optimizes" the scheduler into parallel workers without
  first designing per-settlement ordering.
- **Determinism everywhere:** no `Math.random()` and no `Date.now()` in any resolution path.
  Battle rolls come from `hash(world.seed, movementId)`; oasis defenders from
  `hash(world.seed, x, y)`; chained events advance off `event.dueAt`, never the wall clock
  (the M2b.2 rule). This is what makes replay-after-downtime produce the battle the report
  already described, and what makes `tools/sim` reproducible in M4.
- **The playbook race test is written for every new command** (two concurrent sends of the
  same last unit; exactly one succeeds; troop counts never go negative), per playbook §6.

## 19. Interaction review against everything already shipped

The checks the owner asked for explicitly. Each line is an integration point M3 must handle,
verified against the code as it stands today, not against the plan's intentions.

1. **In-flight troops eat nothing (M2b.3).** Real gap, closed by §3's `awayTroops`. This is
   the single most important consistency fix in M3a.
2. **NPC settlements have no defenders.** M2a.5 seeded bands with 0–6 *scouts* and nothing
   else, because nothing could attack them. Once raiding exists, 135 free farms with zero
   defence would hand every player the §0 raid-income bound on day one. **M3a extends the
   seeder bands** with defence infantry and a Hidden Cache level per band (young: none;
   developed: a small Torcher-equivalent stack + Cache 2–3; veteran: a real stack + Cache
   4–6), still written directly at genesis, still through `missingPrerequisites` for
   legality.
3. **`config.scouting.lossExponent` → `config.combat.lossExponent`** (§5). The scouting
   module keeps working; one constant, one curve family. `configVersion` 6 → 7.
4. **`slowestTroopSpeed` ignores `count`** (recorded in M2a.2): with six unit types per
   army instead of one, the command layer must strip zero-count entries. §9.
5. **The absolute net-Food build gate (M1 §4) now competes with army upkeep.** A player with
   a large army can be blocked from *building* — correct and intended, but the UI must say
   *why* (the existing `buildEligibility` reason strings already carry the shape).
6. **Build queue vs destruction** — the `min(targetLevel, current + 1)` rule, §7. Without
   it, a knocked-down building would leapfrog levels for free.
7. **Storage caps vs destruction** — clamp in the same transaction, §7.
8. **`GET /api/map`'s public-fields leak guard (M2a.6)** must not be relaxed to show
   protection status *plus* anything else; only `protectedUntil` is added, and the existing
   serialized-JSON assertion is extended rather than replaced.
9. **The change-stream resume debt (M2b.4)** becomes load-bearing once notifications ride on
   it — fixed in M3e, §16.
10. **`MovementType`, `ReportType`, `OasisType` and `UnitRole` were all authored as widenable
    unions** (M2's schema comments say so explicitly). M3 widens all four; **no data
    migration is required anywhere.**
11. **The 90 s cancel window** applies uniformly to all six movement types, §9.
12. **M2 §8's "counter-report requires a scout at home"** now has a second source of scouts
    at home: stationed support. Resolved in §8 — they count for defence and detection, the
    counter-report still goes to the owner only.
13. **Faction identity stays where M1/M2 put it**: Engineers' second build slot (M1 §6),
    Nomads' superior scouts (M2 §7), and now the stat table (§1) plus merchant
    capacity/speed (§14). No new global faction multipliers.
14. **`tools/sim` does not exist yet** (M4). Every number in this record is therefore a
    draft in `GameConfig`, and §0 is written as machine-checkable bounds so M4 can act on it
    without re-deriving intent.

## 20. M3 decomposition & acceptance

Five sub-milestones (owner decision 1). Each ends with the standard green bar
(`pnpm lint && pnpm typecheck && pnpm test && pnpm build` from a `pnpm clean` tree) **plus**
its own executable check. M3b is deliberately pure — the battle engine lands with zero
server code, so it can be verified entirely against §0.

- **M3a — Roster, training & the truth about upkeep.**
  `game-core`: the 12 units + Settler + wildlife, widened `UnitDef`, `starvationOrder`,
  training-time curve. Server: `trainUnits` generalized to three buildings, `awayTroops` /
  `stationedTroops` accounting, the `starvationTick` handler and its lazy scheduling, NPC
  seeder bands extended with defenders and Hidden Cache levels.
  *Accept:* over the real HTTP API against real Mongo — a Barracks order and a Machine Shop
  order run **simultaneously**; Food upkeep rises by exactly the catalogue values; sending
  an army away leaves upkeep unchanged (gap #1 closed, asserted numerically); forcing net
  Food negative fires the hourly tick, kills the weakest unit first, writes the report and
  stops when the balance recovers; a freshly regenerated world's NPCs have defenders.

- **M3b — The battle engine (pure).**
  `resolveBattle`, the raid/assault loss split, wall factor, deterministic roll, loot
  distribution, cache protection, the siege pass and the resistance curve — all in
  `game-core`, no server changes.
  *Accept:* the §0 table (four battle rows + the loot row) reproduced **exactly** by unit
  tests with `randomFactor: 0`; the roll proven deterministic across two runs from the same
  `(seed, movementId)`; property tests for "losses never exceed the army", "an attacker with
  0 attack points is rejected", "defender losses split proportionally across contingents".

- **M3c — Attack, support & oases (server).**
  `raid` / `assault` / `support` movements and their arrival resolvers, the two-document
  transaction of §18, loot on the return leg, siege application with the CC floor and the
  storage clamp, the support recall/evict pair, oasis live state with lazy regeneration,
  oasis raiding and scouting, beginner protection, `GET /api/movements/incoming` with its
  tiers.
  *Accept:* over the real HTTP API against real Mongo with the real scheduler running — A
  raids B and both reports match hand-computed numbers; loot lands home on return and is
  clamped by storage; an assault with siege takes a wall level and then a building level and
  **cannot** push the Command Center below 1; support arrives, is fed by the host, defends
  the next attack, and can be evicted; an oasis raid returns Food and the pool regenerates;
  an attack on a protected account is rejected and the protection lifts after that account's
  own first raid; **every** new handler is a no-op on replay; the playbook race passes for
  each new command.

- **M3d — Founding & the Market.**
  Settler training on the CC, the `settle` movement with double-checked Influence and
  `isSettleable`, new-settlement creation, `tradeOffers` with deduct-at-creation and the
  ratio cap, offer acceptance spawning two `trade` movements, the world exchange with its
  spread, merchant accounting per Market level.
  *Accept:* train 3 Settlers → send `settle` to a legal tile → the second settlement exists
  with a Command Center L1 and appears in `GET /api/settlements/mine`; the same convoy sent
  at an illegal tile comes home with its Settlers alive and a report; an offer outside the
  1:2 ratio is rejected; an accepted offer moves resources in both directions and frees the
  merchants; the exchange converts at exactly the configured spread.

- **M3e — UI, reports & notifications.**
  Units tab, attack flow, incoming panel, combat/starvation/settle/trade report bodies,
  Market tab, settle action, protection badges, the notification outbox + in-app provider +
  TG stub, the change-stream resume fix, RU i18n for all of it.
  *Accept (the plan's M3 criterion, made executable):* in real Chrome at a phone viewport —
  two test accounts fight end to end: train from both buildings with live countdowns → send
  a raid from the map with a travel preview that matches the actual arrival → the defender's
  incoming panel shows it at the right tier for their Radio Tower level → the battle report
  appears in both inboxes **without a reload** and reads in Russian with losses, loot and
  destruction → an in-app notification fires and the Telegram provider logs the identical
  payload. Numbers in the report match a hand-computed §0-style case.

## 21. Required edits to `IMPLEMENTATION_PLAN.md`

1. **§1 locked table, "Content scope"**: "13 building types, 5 units per faction" → add
   "+ a faction-neutral Settler and two wildlife defender types (16 trainable unit types in
   total)".
2. **§2.2 units table**: add a note that the Settler is trained at the Command Center and is
   shared by all factions.
3. **§2.3 Market**: state both halves — player↔player offers *and* a faceless world exchange
   post at a fixed weighted rate with a spread; merchants are derived from the Market level,
   not trained.
4. **§2.4 buildings**: Command Center gains "trains Settlers"; Barracks and Machine Shop
   gain "level reduces training time".
5. **§2.5 oases**: farm oases carry wildlife defenders and a lazily-regenerating Food pool
   from M3; still not annexable.
6. **§2.6 combat**: replace the summary with the resolved model — T3.6 point shape with the
   infantry/cavalry split, wall as a multiplier, the shared 1.5-power loss curve, the
   raid vs assault loss formulas, a **deterministic** ±5 % roll (not a wall-clock random),
   the siege pass with the Command Center floor at level 1 and no razing, loot up to
   surviving carry capacity behind the Hidden Cache.
7. **§2.6 beginner protection**: clarify — 72 h from first settlement, blocks all foreign
   movements including scouting, and ends early **only** on the protected account's first
   raid or assault against another account (scouting and oasis raids do not break it).
8. **§5, M3 line**: replace "Telegram notifications" with "notification layer + provider
   interface (in-app live, Telegram smoke-tested before M7)"; add starvation, the Settler
   unit, the world exchange, and the M3a–M3e split. The acceptance criterion loses "TG push
   received" and gains "an in-app notification fires and the Telegram provider logs the
   identical payload".
9. **§3.2 collections**: add `tradeOffers` and `notifications`; note that `settlements`
   gains `awayTroops` / `stationedTroops` and `oases` gains `defenders` / `loot` /
   `lastRegenAt` / `version`.
10. **§2.5 / M2 §0 travel table**: record that siege units (speed 3–4) sit deliberately
    outside the "2–4 h across half the map" band.

## 22. Deliberately deferred

| Item | To | Reason |
|---|---|---|
| Village capture, loyalty, chiefs | never (v1 locked) | Plan §1. No mechanic in this record assumes it. |
| Village razing (CC → 0) | never (v1) | Owner decision 4. |
| Movement interception (catching a convoy mid-march) | vNext | No mechanic anywhere supports it; §13 records the consequence. |
| Named NPC trade counterparties | M4 | NPCs are inert until their brain ships (§14). |
| Bash points / combat rankings | M5 | The season ranking is contribution-based (plan §2.7). |
| Source placement, Act 2 reveal, Act 3 capture, hold accumulation | M5 | Unchanged from M2 §14. |
| Side switching, contribution scoring, round rollover | M5 | Unchanged. |
| Real Telegram bot delivery | M7 | Owner decision 8; provider interface ships now. |
| Balance tuning of every number in this record | M4 | `tools/sim` does not exist yet; §0 is written as its checklist. |
| Tile/unit/battle art slicing (`tools/assets`) | M6 | Unchanged from M2 §11 — flat placeholders. |
| Tutorial / quest system | Backlog (M6+) | Carried over from M2 §14; §11's protection rules were written so it stays possible. |
| Terrain movement modifiers | vNext | Terrain stays cosmetic in v1 (M2 §2). |
| NPC name language | owner | Open question carried from M2c.1, now more visible (§17). |

## 23. Checklist — all resolved

- [x] §0 combat contract: five hand-computable rows + five sim-checkable bounds
- [x] §1 the remaining 12 units + Settler + wildlife, stats, split classes, scouts barred from attacks
- [x] §2 training generalized to three buildings, one order each, building level speeds it up
- [x] §3 home / away / stationed accounting; host feeds support; the M2 in-flight upkeep gap closed
- [x] §4 hourly starvation, weakest first, guests first, lazily scheduled
- [x] §5 T3.6 battle shape, shared 1.5 loss curve, deterministic roll, proportional contingent losses
- [x] §6 raid vs assault loss formulas, loot by surviving capacity, Hidden Cache, clamp at cap
- [x] §7 wall first, siege resistance curve, CC floor 1, storage clamp, build-queue rule
- [x] §8 support to anyone, recall **and** evict, stationed scouts count, no support into protection
- [x] §9 six movement types, one arrival handler with per-type resolvers, uniform 90 s cancel
- [x] §10 oasis wildlife defenders, lazy loot regeneration, raiding and scouting, still not annexable
- [x] §11 72 h protection, blocks everything inbound, broken only by the holder's own raid/assault
- [x] §12 incoming visibility tiers by Radio Tower, support always visible, scouts never
- [x] §13 3 Settlers from the Command Center, gate checked twice, failed convoy returns intact
- [x] §14 P2P offers with the 1:2 cap + the world exchange with a 25 % spread; merchants from Market level
- [x] §15 eight new report types, structured payloads, both parties plus supporters
- [x] §16 notification outbox + provider interface, in-app now, Telegram at M7, change-stream fixed
- [x] §17 UI scope for M3e, placeholders, RU i18n, two new namespaces
- [x] §18 two-document arrivals, deterministic lock order, status-based idempotency, serialized battles
- [x] §19 interaction review against every shipped M1/M2 surface
- [x] §20 M3a–M3e split with executable acceptance criteria
- [x] §21 ten required plan edits
- [x] §22 deferred list with owners

**Follow-up work owned by the implementation orchestrator (no owner decisions required):**
re-check the §1 stat drafts against Kirilloid T3.6 once more while writing the catalogue
(especially cavalry cost-per-attack-point and siege resistance, the two most likely to be
wrong by an order of magnitude); extend the M1 reference-player harness with an army and a
raid income stream where it is cheap; keep every draft number in `GameConfig` so `tools/sim`
can sweep it in M4; apply the §21 plan edits **before** the first line of M3 code, the way
M2.0 did.

---

## 24. Owner amendments after M3a (2026-08-17)

Four questions the original session did not settle, or settled in a way M3a's implementation
and live acceptance run proved wrong. All four were put to the owner and decided on
2026-08-17, after M3a shipped (`6dc6d54`) and before the first line of M3b. **They amend the
sections named below and win over them**, exactly as this record wins over the plan.

**A. Siege units die last, alongside Settlers — amends §4.** `starvationOrder` sorts by
`attack + defInfantry + defCavalry` ascending, which is what §4 specifies, but siege units
have deliberately poor defensive stats: the Rail Sling (790 resources, the most expensive
unit in the game after the Settler) starved before *every* cavalry unit and before infantry
costing a quarter as much. §4 already applied exactly this reasoning to the Settler — "a
large investment ... losing them to a Food dip would be brutal" — and simply did not extend
it to siege. It is extended now: a "dies-last rank" sorts `role: 'settler'` last,
`role: 'siege'` second-to-last, everything else by the unchanged §4 chain (combat weight →
training cost → unit id).

**B. In-transit troops (`awayTroops`) are exempt from starvation — amends §4.** M3a's live
run found that troops starved out of `awayTroops` came back to life on the movement's return:
the movement document still listed them, so the arrival resolved with the full count and the
return credited them home. `awayTroops` is a denormalized counter and nothing keeps it in
sync with the in-flight movement documents — §3 defines the counter but never says the
movement must be updated to match, and §18 designs cross-document writes only for arrivals.
Decision: in-transit troops still **pay** Food upkeep (the M3a.4 exploit fix stands untouched
— marching an army out must never cut your upkeep) but can no longer **die**. Only
`stationedTroops` (guests, first) and home `troops` (second) are killed.

*The accepted cost, flagged to the owner before the decision and confirmed:* a marching army
is immortal to starvation, so a starving settlement's own home garrison and its allies'
stationed contingents die to feed it, and "march to dodge the tick" still works. It is not
free — the dodge costs your home defence, needs manual re-sending every round trip, and
leaves the settlement at 0 Food with the net-Food gate freezing all building and training —
and the alternative (walking every outbound movement and debiting it) is a cross-document
write from the starvation handler that §18 never designed. Revisit with `tools/sim` data in
M4 if it proves abusable. **New consequence, recorded:** `resolved: false` is now reachable
when the deficit is driven by in-transit upkeep or by buildings, so the tick can legitimately
kill nothing and re-arm on the ordinary hourly cadence.

**C. Defender losses use the uniform loss fraction — resolves an ambiguity in §5.** §5 says
defender losses are "shared across contingents proportionally to each contingent's
contribution to `defPts` — an ally who sent 10 % of the defence loses 10 % of the casualties,
not 10 % of *their* stack", and *also* calls it "Travian's rule". Those are two different
algorithms: a defPts-weighted casualty budget (with clamping and redistribution when a
contingent's share exceeds its body count) versus one uniform loss fraction applied to every
contingent and every unit type. The owner chose **the uniform fraction — Travian's actual
rule**. Losses therefore land proportional to body count, not to defence contribution. It is
order-independent, trivially deterministic, and reproduces §0's contract table exactly. §5's
"proportionally to `defPts`" phrasing is superseded; what it was rejecting — applying
casualties to contingents in array order until a budget runs out — stays rejected.

**D. The §1 faction-identity stat drafts stay as shipped until M4.** M3a.1 proved three of
§1's identity claims false against §1's own draft numbers (Raiders are cheapest per attack
point only for cavalry; Nomads are fastest only for scouts and cavalry, and are worst per
Scrap on defence — the Torcher strictly dominates the Hunter-Sniper on both defence axes).
All three are repairable without invalidating §0, whose four rows use only Brute, Torcher and
Biker. The owner deferred the repair to M4's `tools/sim` pass, where §22 already puts every
number in this record. **Nothing is to be retuned by hand before then**, and §0's table stays
the fixed contract in the meantime.
