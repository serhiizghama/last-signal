# Last Signal — asset specification

**Status: RESOLVED for every asset M1 and M2 ship.** Produced from `docs/design/UX_DESIGN.md`,
`docs/design/WIREFRAMES.md` and `docs/design/VISUAL_DESIGN.md` in the art-direction session of
2026-08-16, with four decisions settled with the owner (§4).

**Authority.** This document decides **which assets exist, at what size, and which must not be
made**. `docs/ASSET_PROMPTS.md` remains the source of truth for *how* art is generated — the
generation briefs in §11 are written to be merged into it. `VISUAL_DESIGN.md` remains binding
for how assets are *used*. Where an earlier record disagrees about an asset's role, this one
wins; four such corrections are listed in §13.

**The rule that governs every entry:**

> **An asset exists because the gameplay or the UI cannot work without it.**
> Not because it would look good. Every asset below answers four questions: where does the
> player see it, at what size, what must stay readable at that size, and what does its
> silhouette communicate. An asset that cannot answer all four is in §10 — the list of things
> that must **not** be created.

---

## 1. Method — how the existing art was assessed

Claims about art need evidence, so the current inventory was rendered into four contact
sheets under real display conditions before anything was specified:

| Sheet | What it tested |
|---|---|
| **A** — 12 buildings composited into the real 99 × 125 Base ground cells on the real background | noise, scale consistency, legibility at true display size |
| **B** — the same 12 flattened to pure alpha silhouettes | **the silhouette test**: can a building be named with all colour and detail removed? |
| **C / D** — a simulated 12 × 14 map viewport at 32px with real terrain distribution, 5 markers and an oasis, rendered dimmed vs. full-brightness | terrain-vs-marker competition; marker legibility at display size |
| **E / F** — all nav icons (both states), resource icons, markers, and all 15 units at 1:1 | glyph legibility, unit quality, state differentiation |

### 1.1 Findings

| # | Finding | Verdict on the stated problem |
|---|---|---|
| 1 | **9 of 12 buildings are silhouette-identical lumpy mounds.** Only Radio Tower (lattice), Refinery (tanks + chimney) and Scrap Yard (crane boom) are nameable in black. Remove colour and Barracks, Warehouse, Market, Cold Storage, Machine Shop, Workshop, Greenhouse, Command Center and Wall are interchangeable. | **"Insufficient silhouette readability" — CONFIRMED, severe.** This is the headline problem. |
| 2 | **Every building carries its own isometric ground plate**, at inconsistent sizes (68–96px wide). They are standalone diorama pieces, not buildings meant to share a ground plane — so on the Base ground each brings a conflicting patch of dirt and the set never sits on a common grid. | **"Inconsistent scale" — CONFIRMED**, and now diagnosed: the cause is the base plates, not the buildings. |
| 3 | **Buildings are internally noisy** — crates, barrels, pipes, scattered props on every sprite. At 96px on a phone this is dense enough to fight the label. | **"Too visually noisy" — CONFIRMED.** |
| 4 | At full brightness the five settlement markers are **nearly impossible to find** in the map simulation. Dimmed to 55%/65%, they read instantly. | **"Decorative art competing with gameplay" — CONFIRMED**, and the `VISUAL_DESIGN.md` dim decision is validated by direct comparison. |
| 5 | Markers at 30 × 40 on a 32px tile are **proportionally correct** — they overflow upward exactly as intended. But their faction sigil is a few pixels of flag, so red-skull, blue-gear and green-bull are indistinguishable at display size. | **"Map objects too large" — RE-DIAGNOSED.** The size is right; the *detail density* is wrong. Shrinking them would make it worse. |
| 6 | The nine terrain tiles are individually-illustrated squares with hard edges and no edge continuity, and **3 wasteland variants cover 55% of tiles**, so repetition is visible across a viewport. | New finding. |
| 7 | **The 13th building, `hiddenCache` (Тайник), has no art at all.** | New finding — a gap, not a defect. |
| 8 | **The two nav-icon states are nearly identical.** The prompt asked for flat bone-white defaults against full-colour active; both sets came out full-colour. | New finding — the second set cannot encode state. |
| 9 | **The 15 unit sprites are the strongest asset class in the project**: clear silhouettes, consistent 64px scale, genuinely distinct faction palettes. | No action. |

---

## 2. What every asset must answer

| Question | Enforced by |
|---|---|
| **Where will the player see this?** | the `Screen` column — an asset with no screen is deleted from the spec |
| **At what size?** | `Display` vs `Source` — integer scaling only (`VISUAL_DESIGN.md` §12) |
| **What must remain readable at that size?** | the `Focal point` field — one per asset, not a list |
| **What does its silhouette communicate?** | the `Silhouette` field, enforced by the acceptance gate in §12 |

## 3. Priority definitions

| Level | Meaning | Consequence if missing |
|---|---|---|
| **P0** | required for gameplay clarity | the player cannot understand or operate a screen |
| **P1** | important | the screen works but reads as unfinished or generic |
| **P2** | useful | a measurable improvement, no functional loss |
| **P3** | decorative | atmosphere only |

---

## 4. Decisions made with the owner (2026-08-16)

| # | Decision | Rationale | Rejected |
|---|---|---|---|
| 1 | **Regenerate all 13 buildings to a silhouette-first spec** — distinct primary form each, no ground plate, transparent, reduced prop detail, consistent footprint | the whole spatial Base rests on buildings being identifiable at a glance, and finding §1.1.1 says they are not; it is two sheets in an existing evening pipeline | keep-and-let-labels-do-it (concedes the Base is justified by mood, not information); pipeline-crop only (fixes plates, not sameness); partial regeneration (visible style split between plate-less new and plated old) |
| 2 | **Keep the tileset, add 3 wasteland variants** | a visible tile grid is *semantically correct* here — distance is measured in tiles and the UI says «4 тайла» — so seamlessness is not the goal; repetition is the only real failure, so fix only that | keep as-is (repetition stays visible); regenerate seamless (hard to generate, per-edge QA, and it fights tile-as-unit-of-distance) |
| 3 | **Drawn map markers; retire the marker sprites** | a marker must encode identity × own × selected × intel — combinatorial as art, free as a drawn shape; consistent with retiring the button and panel sprites for the same reason | regenerate markers authored at 30 × 40 (still needs the state layer built around it anyway); hybrid sprite + drawn chip (two elements on a 32px tile is the density that broke the current ones) |
| 4 | **Faction variants for units only** | factions differ mechanically in units and one build slot — nothing about a Raider warehouse differs from an Engineer one; you only ever see your own base, so 26 of 39 per-faction building sprites would never be seen by a given player | accent-tint remapping on buildings (puts a real constraint on prompts for cosmetic gain); full per-faction buildings (39 sprites, no gameplay meaning) |

---

## 5. Inventory summary

106 sliced assets exist today. After this specification:

| Action | Count | Notes |
|---|---|---|
| **KEEP** — used as delivered | 40 | units 15, tiles 9, emblems 5, nav icons 8, brand 2, source 1 |
| **KEEP (deferred milestone)** | 9 | battle art 2, medals 6, hero 1 |
| **REVISE** — pipeline work, no new art | 2 | `bar_top`, `bar_bottom` → horizontal 9-patch |
| **REPLACE** — regenerate | 12 | the building set |
| **CREATE** — new art | 4 | `hiddenCache` + 3 wasteland variants |
| **RETIRE** — produced, not used | 32 | UI chrome 23, marker sprites 4, nav hover set 8 (see §5.1) |
| **NOT TO BE CREATED** | — | §10 |

### 5.1 Retirement list

| Assets | Why |
|---|---|
| `ui.button.*` (14), `ui.panel.card / frame_large / tooltip / badge` (4), `ui.progress.*` (3), `ui.panel.bar_*` retained | fixed-aspect decorative pieces that cannot stretch to hold Russian at arbitrary widths; drawn equivalents give strictly better contrast and state legibility (`VISUAL_DESIGN.md` §22.3) |
| `map.marker.village.*` (4) | decision §4.3 — replaced by drawn markers |
| `ui.icon.nav.*.hover` (8) | finding §1.1.8 — indistinguishable from the default set, so it cannot carry state; active state is carried by opacity, the accent label and the accent rule |

**Retirement is a usage decision, not a quality judgement. No regeneration is requested for
anything in this list.** All of it remains valid art-board reference and may return in M6 for
fixed-size ornaments where nothing has to stretch.

---

## 6. Category 1 — Buildings (P0, REPLACE)

**Where:** Base ground (13 plots) and the building detail sheet.
**Display:** 1:1 at up to 96 × 96 in a 99 × 125 cell; 1:1 again in the sheet.
**Source:** 96 × 96 canvas, transparent, **no ground plate**.
**Faction variants:** none (§4.4).
**States:** one sprite per building. Queued / constructing / completed states are applied by
the UI as brightness, label and border (`VISUAL_DESIGN.md` §15.2) — **not** as art variants.
**Level variants:** none, ever. See §10.4.

### 6.1 The silhouette set

Each building has one **distinct primary form** that must be nameable in pure black. Collisions
were checked across the whole set — no two share a dominant mass.

| # | `game-core` id | RU name | Gameplay meaning | Primary form (silhouette) | Focal point |
|---|---|---|---|---|---|
| 1 | `commandCenter` | Штаб | build speed; prerequisite hub | stepped/tiered blockhouse with a single tall mast and flag | the mast |
| 2 | `scrapYard` | Свалка металлолома | Scrap production | **diagonal crane boom** over a low heap — the only diagonal in the set | the boom line |
| 3 | `fuelRefinery` | Нефтеперегонный завод | Fuel production | two fat vertical cylinders + one thin chimney | the chimney |
| 4 | `electronicsWorkshop` | Мастерская электроники | Electronics production | low shed with a **sawtooth (north-light) roof** — the only zigzag | the sawtooth roofline |
| 5 | `greenhouseFarm` | Теплица | Food production | **clean barrel-vault arc** (polytunnel) | the arc |
| 6 | `warehouse` | Склад | Scrap/Fuel/Electronics cap | wide low **gabled hall** with a large roller door | the door |
| 7 | `coldStorage` | Холодильник | Food cap | squat **cube with a boxy roof-mounted cooling unit** | the roof unit |
| 8 | `hiddenCache` | Тайник | hides resources from raids | **near-flat ground hatch**, camouflaged cover — deliberately the lowest silhouette in the set, because that *is* its meaning | the hatch rim |
| 9 | `wall` | Стена | defence; siege must breach | long low **barrier bar with a gate between two posts** | the gate |
| 10 | `barracks` | Казармы | trains infantry & scouts | low hut block with **one corner watchtower** | the corner tower |
| 11 | `market` | Рынок | trade, merchants | **open canopy on thin legs** — the only silhouette with daylight under it | the awning line |
| 12 | `machineShop` | Мастерская | trains vehicles & siege | hangar with a **wide arched opening** (negative space) and a ramp | the arch mouth |
| 13 | `radioTower` | Радиовышка | intel depth, scouting ops | **thin lattice mast topped by a dish** | the dish |

**Distinctness audit.** Tall-thin: `radioTower` (lattice) vs `fuelRefinery` (fat cylinders) —
different mass. Arcs: `greenhouseFarm` (arc *is* the roof) vs `machineShop` (arch is a *hole in
a box*). Low-wide: `warehouse` (gable), `barracks` (box + one tower), `wall` (bar + two posts),
`market` (open, legs), `hiddenCache` (near-flat). Cubes: `coldStorage` (roof unit) vs
`commandCenter` (stepped + mast). Unique: `scrapYard` (diagonal), `electronicsWorkshop`
(zigzag).

### 6.2 Shared generation constraints

| Constraint | Value |
|---|---|
| Canvas | 96 × 96, transparent |
| Ground plate | **none** — the building sits directly on its own footprint; the Base supplies the ground |
| Footprint | structure occupies ≥ 60% of canvas width; base flush with the bottom edge |
| Light | single source, upper-left, consistent across all 13 and with the existing unit sprites |
| Prop detail | drastically reduced vs. the current set — at most 2 secondary props per building; no scattered debris, no crates unless they *are* the building |
| Internal contrast | reduced; the silhouette does the work, the interior supports it |
| Palette | the shared wasteland palette; no per-building hue identity (silhouette carries identity, not colour) |
| Style anchor | the existing unit sheets, which are the project's quality benchmark |

### 6.3 Short labels required

The 99px ground cell cannot hold «Мастерская электроники». A `buildings.<type>.short` key set
is required (already requested in `VISUAL_DESIGN.md` §22.5). Proposed, ≤ 10 characters, and
specifically resolving the «Мастерская» collision between `electronicsWorkshop` and
`machineShop`:

| Type | Short | Type | Short |
|---|---|---|---|
| `commandCenter` | Штаб | `hiddenCache` | Тайник |
| `scrapYard` | Свалка | `wall` | Стена |
| `fuelRefinery` | НПЗ | `barracks` | Казармы |
| `electronicsWorkshop` | **Электрон.** | `market` | Рынок |
| `greenhouseFarm` | Теплица | `machineShop` | **Мастерская** |
| `warehouse` | Склад | `radioTower` | Вышка |
| `coldStorage` | Холод. | | |

Wording is the owner's call; the constraint is ≤ 10 characters and no two alike.

---

## 7. Categories 2–9 — the rest of the world

### 7.1 Base objects (P0, drawn — no art)

| Element | Treatment | Why not art |
|---|---|---|
| Ground plane | `map.tile.wasteland_dirt_1` tiled, dimmed to 45% | reuses an existing asset; it is scenery, so it dims |
| Empty `+` plot | drawn: 2px dashed `edge-soft` square, `+` glyph, `построить` | it is an affordance with states (default/pressed/selected); art cannot carry those |
| Plot selection, progress line, level badge | drawn | state, not world |

### 7.2 Map objects — terrain (P0, KEEP + CREATE 3)

| Asset | `game-core` terrain id | Source | Display | Action |
|---|---|---|---|---|
| `map.tile.wasteland_dirt_1/2/3` | `wasteland` (55%) | 32 × 32 | 32 (1×), 64 (2×), flat tint (0.5×) | KEEP |
| **`map.tile.wasteland_dirt_4/5/6`** | `wasteland` | 32 × 32 | as above | **CREATE — P1** |
| `map.tile.dead_forest` | `deadForest` (12%) | 32 × 32 | as above | KEEP |
| `map.tile.rocky_hills` | `rockyHills` (10%) | 32 × 32 | as above | KEEP |
| `map.tile.ruined_city` | `ruinedCity` (8%) | 32 × 32 | as above | KEEP |
| `map.tile.cracked_highway` | `brokenHighway` (8%) | 32 × 32 | as above | KEEP |
| `map.tile.irradiated_lake` | `toxicLake` (7%) | 32 × 32 | as above | KEEP |
| `map.tile.farm_windmill` | *not terrain* — the oasis object | 32 × 32 | 32, **undimmed** | KEEP |

- **Gameplay meaning:** cosmetic in v1 with one exception — `toxicLake` cannot host a
  settlement. Terrain never travels over the wire; the client derives it from the world seed.
- **Readable at 32px:** only the terrain *class*, as a colour-and-texture impression. Nothing
  in a tile needs to be individually identifiable; that is why dimming costs nothing.
- **Silhouette:** none — tiles are full-bleed squares with no alpha.
- **New-variant generation note:** match the existing three, but **lower internal contrast — no
  bright highlights, no hard black cracks**. The three existing variants are contrastier than
  they need to be, which is what made full-brightness terrain drown the markers (§1.1.4). New
  variants must not reintroduce that.

### 7.3 Map objects — the Signal Source (P1, KEEP, M5)

`map.object.signal_source`, 128 × 122, displayed 1:1. **Gameplay meaning:** the round's
victory objective. **Silhouette:** a collapsed dish array — must read as *the* landmark, unlike
anything else on the map. **Focal point:** the dish. `success` is reserved for it and appears
nowhere else on the map. Not placed until M5's Act 2 reveal.

### 7.4 Settlements & markers (P0, drawn — decision §4.3)

The four `map.marker.village.*` sprites are **retired**. Settlements on the map are drawn:

| Element | Spec | Encodes |
|---|---|---|
| Marker body | pennant, 20 × 28, identity-colour fill, 2px `surface-void` outline, bottom-centred on the tile, overflows 4px upward | a settlement is here |
| Own settlement | + 2px `accent` ring around the whole 32px tile, at every zoom | this one is yours |
| Intel held | 6 × 6 `text-primary` dot at the marker's top-right, 40% opacity past 12h | you have scouted this |
| Selected | tile un-dims to full colour + `accent` inset border + corner ticks | current selection |
| At 2× zoom | marker scales to 40 × 56 and the **faction emblem at 1:2 (48 → shown at 24)** appears inside it | identity, disclosed when the player zooms in to inspect |

**Deliberate scope reduction.** At 1× the marker carries presence, ownership and intel — *not*
faction. Faction and side are read where there is room for them: the tile sheet (48px emblem +
text) and the «СПИСОК» row (text). Trying to make a faction sigil legible inside 30px is what
broke the current markers, and the player does not need it while scanning.

### 7.5 NPCs (no assets — see §10.1)

### 7.6 Units (P0 for the 3 scouts, P1 for the rest — KEEP, no work)

All 15 exist and are the project's best art. Source 44–87 × 64, displayed **1:1** in Войска
rows (72px row height) and the training sheet.

| `game-core` type | Faction | Asset id | Milestone |
|---|---|---|---|
| `lookout` | Raiders | `unit.raiders.scout` | **M2 — P0** |
| `surveyorDrone` | Engineers | `unit.engineers.hover_drone` | **M2 — P0** |
| `falconer` | Nomads | `unit.nomads.falconer` | **M2 — P0** |
| offense inf. | R / E / N | `raiders.brute` · `engineers.exo_trooper` · `nomads.skirmisher` | M3 — P1 |
| defence inf. | R / E / N | `raiders.molotov_thrower` · `engineers.bulwark_guard` · `nomads.sniper` | M3 — P1 |
| fast | R / E / N | `raiders.biker` · `engineers.quad_bike` · `nomads.dune_buggy` | M3 — P1 |
| siege | R / E / N | `raiders.siege_truck` · `engineers.crane_rig` · `nomads.ballista_wagon` | M3 — P1 |

**Asset ids do not match `game-core` unit ids** (`lookout` ≠ `scout`, `surveyorDrone` ≠
`hover_drone`). The client needs an explicit type → asset map; it must not be derived by string
convention. Recorded in §9.

**Readable at 64px:** the unit's class — humanoid vs vehicle vs drone — and its faction palette.
**Focal point:** the weapon or tool that names the role.

### 7.7 Resources (P2, KEEP — currently unused)

`map.icon.resource.scrap / fuel / circuit / food`, 23–32 × 32.

**Honest finding: the shipped product does not currently need these.** The HUD uses three-letter
labels (`VISUAL_DESIGN.md` §8) because 32px icons don't fit four cells plus the round chip and
gear in 402px, and a 20px display would be a fractional downscale. Cost rows, report tables and
the resource sheet all use text tokens too.

They stay in inventory as a **P2 enhancement**: if 16 × 16 variants are produced in the pipeline
(clean 1:2) and pass legibility QA, cost rows gain icons. Nothing blocks on it. Do not
regenerate them for the HUD.

### 7.8 Icons & emblems (P1, KEEP)

| Asset | Source | Display | Where | Notes |
|---|---|---|---|---|
| `emblem.faction.*` (3) | ~96 | 96 (settings) · 48 (report header, tile sheet, marker at 2×) | identity | 1:1 and 1:2 — both clean |
| `emblem.side.*` (2) | ~96 | 96 · 48 | identity | **Beacon is painted toxic green**, which collides with `success`; the art stays, but the *side token* in the UI is `#C7B27A` pale gold — M6 QA item |
| `ui.button.icon.gear.*` | ~40 | 24 in a 44 touch area | HUD | default state only; pressed is drawn |
| `ui.button.icon.close.*` | ~40 | 24 | sheets | as above |
| `ui.button.icon.hammer.*` | ~40 | — | — | **no screen uses it** — retire |

---

## 8. Categories 10–16 — interface

All of these are **drawn, not art**, per `VISUAL_DESIGN.md` §2. Listed so the absence is
explicit rather than an oversight.

| # | Category | Treatment | Assets required |
|---|---|---|---|
| 10 | **Buttons** | drawn: flat fill, hard 2px edge, zero radius; primary / secondary / destructive / disabled / pressed / loading | **none** — `ui.button.primary/secondary/danger/round/toggle` retired (§5.1) |
| 11 | **Panels** | drawn: three-step surface ramp + hard edges; sheets, cards, rows | **none** — `card`, `frame_large`, `tooltip`, `badge` retired |
| 12 | **Status indicators** | drawn: cap-full bar, Food `▼`, unread badge, offline banner, intel dot | **none** |
| 13 | **Progress** | drawn: 6px bar, `surface-void` track, `accent` fill, linear against real time | **none** — `ui.progress.frame/fill.*` retired (fixed 149px, cannot stretch) |
| 14 | **Navigation** | `ui.panel.bar_bottom` 9-sliced + 8 default nav icons at 1:1 (M2 uses 4: map, base, army, reports) | **REVISE** the bar; the hover set is retired |
| 15 | **Effects** | drawn: completion flash, movement chevron, toast | **none in M2** — see §10.5 |
| 16 | **Decoration** | the dimmed ground texture only | **none** — see §10.3 |

### 8.1 The two bars (P0, REVISE)

`ui.panel.bar_top` (357 × 48) and `ui.panel.bar_bottom` (371 × 48) are the **only chrome the
product uses** — they alone have fixed end caps and a neutral stretchable centre.

**Work required:** re-cut as **horizontal 9-patches** with declared cap widths (~24px) and a
verified tileable centre; the vertical axis does not stretch. This is a `tools/assets` pipeline
task, not new art. Display height 56 (top) and 58 (bottom).

---

## 9. Id mapping — production-critical

Asset ids drifted from `game-core` ids during generation. The client must carry explicit maps;
deriving them by snake/camel conversion **will break** on four buildings and three units.

**Buildings** (`BuildingType` → manifest id):

| `game-core` | asset id | | `game-core` | asset id |
|---|---|---|---|---|
| `commandCenter` | `building.command_center` | | `hiddenCache` | **missing — to be created** |
| `scrapYard` | `building.scrap_yard` | | `wall` | `building.wall` |
| `fuelRefinery` | **`building.refinery`** | | `barracks` | `building.barracks` |
| `electronicsWorkshop` | **`building.workshop`** | | `market` | `building.market` |
| `greenhouseFarm` | **`building.greenhouse`** | | `machineShop` | `building.machine_shop` |
| `warehouse` | `building.warehouse` | | `radioTower` | `building.radio_tower` |
| `coldStorage` | `building.cold_storage` | | | |

**Terrain** (`TerrainId` → manifest id): `wasteland` → one of `wasteland_dirt_1…6` chosen by
`tileRoll`; `deadForest` → `dead_forest`; `rockyHills` → `rocky_hills`; `ruinedCity` →
`ruined_city`; **`brokenHighway` → `cracked_highway`**; **`toxicLake` → `irradiated_lake`**.
The oasis is not a terrain id — it is an object rendered with `farm_windmill`.

**Units** (`UnitType` → manifest id): **`lookout` → `unit.raiders.scout`**; **`surveyorDrone` →
`unit.engineers.hover_drone`**; `falconer` → `unit.nomads.falconer`.

**Recommendation:** when the buildings are regenerated, **rename the new slices to the
`game-core` ids** (`building.fuel_refinery`, `building.electronics_workshop`,
`building.greenhouse_farm`) so half this table disappears. Terrain and unit maps stay.

---

## 10. Assets that must NOT be created

Each of these would fail the test in the header. They are listed so nobody proposes them later.

### 10.1 NPC portraits, avatars or any NPC-specific art — **forbidden, not merely unnecessary**

NPCs are ordinary accounts and must be **indistinguishable from human players** (a locked
design decision; the server already omits `isNpc` from every client view). Any NPC-specific art
would leak exactly what the whole NPC design exists to hide. Player identity is a name plus a
faction emblem, and that is all it will ever be.

### 10.2 Per-faction buildings (39 sprites)

Decision §4.4. Factions differ in units, not architecture; a player only ever sees their own
base, so 26 of 39 would never be seen by any given player; the map shows markers, not buildings.

### 10.3 Base decoration — props, rubble, roads, scatter, ambient objects

The Base ground is a dimmed texture, and the buildings are the content. Decoration on a 402px
screen with 13 tappable objects competes with the thing the player came to do. `VISUAL_DESIGN`
§1 forbids it directly.

### 10.4 Building level variants

Even at 96px there is no room for a taller silhouette at level 20, and finding §1.1.1 shows
that silhouette differences at this size are hard to achieve *between* buildings, let alone
within one. **The level badge is the answer, permanently.** This closes the open question
carried in `VISUAL_DESIGN.md` §26.5.

### 10.5 Effect art for M2 — explosions, signal waves, dust, weather, travel trails

Every M2 effect is drawn: the completion flash is a border colour, the movement marker is a
chevron, arrival is a toast. Battle art (M3) already exists for the one moment that wants
illustration.

### 10.6 A cursor, loading spinner, splash art, or empty-state illustrations

Loading is skeletons of the real layout (`WIREFRAMES.md` §25); empty states are text plus a
CTA. An illustration in an empty state is decoration standing where an instruction should be.

### 10.7 Re-cut 9-patch versions of the retired buttons and panels

Assessed and rejected in `VISUAL_DESIGN.md` §24.1: the sources have no clean tileable centres
(the primary button's diagonal highlight, the card's asymmetric banner), and drawn chrome gives
better contrast and state legibility regardless.

### 10.8 Resource icons at 32px for the HUD

They do not fit (§7.7). If icons are wanted there, the answer is a 16 × 16 set, not the
existing sprites scaled.

---

## 11. Generation briefs — for merging into `ASSET_PROMPTS.md`

Two sheets and one small addition. Written to the house prompt style; the owner generates.

### 11.1 `buildings_1_v2.png` — P0

> Same crisp 16-bit pixel art style as the unit sheets. Seven wasteland structures in a grid,
> **each isolated on a fully transparent background with no ground, no dirt platform, no base
> plate** — the structure only, its footprint flush with the bottom of its cell. Same size and
> same viewing angle for all seven. Single light source from the upper left. Dusty sunset
> palette: burnt orange, faded teal, bone white, dark rust brown. **Bold, simple, clearly
> different silhouettes — each structure must be recognisable as a solid black shape.** Minimal
> surface clutter: no scattered crates, barrels or debris. 1) stepped tiered concrete blockhouse
> with one tall mast and a flag, 2) tall angled crane boom over a low scrap heap, 3) two fat
> vertical fuel cylinders beside one thin tall chimney, 4) low shed with a sawtooth north-light
> roof, 5) a clean barrel-vaulted greenhouse arch, 6) a wide low gabled warehouse with a big
> roller door, 7) a squat insulated cube with a boxy cooling unit on the roof. No text, no
> watermarks, no UI frames. 1536x1024.

### 11.2 `buildings_2_v2.png` — P0

> Same crisp 16-bit pixel art style, same rules as buildings_1_v2: six wasteland structures,
> **transparent background, no ground plate**, same size and viewing angle, single upper-left
> light, bold clearly-different silhouettes, minimal clutter. 1) a nearly flat camouflaged
> ground hatch, barely raised above its footprint, 2) a long low fortified barrier with a gate
> between two posts, 3) a low barracks block with a single square watchtower at one corner,
> 4) an open market canopy on thin legs with clear daylight visible beneath it, 5) a vehicle
> hangar with a wide arched opening cut into its front, 6) a tall thin lattice radio mast topped
> by a dish. No text, no watermarks, no UI frames. 1536x1024.

### 11.3 `terrain_tiles_extra.png` — P1

> Same crisp 16-bit pixel art style as the existing terrain tiles. Three additional wasteland
> dirt ground tiles in one row, square, seamless-edged, top-down, same scale and palette as the
> existing wasteland tiles. **Lower internal contrast than the existing set: no bright
> highlights, no hard black cracks — muted, dusty, quiet.** They must sit beside the existing
> three without standing out. No objects, no structures, no text. 1536x1024.

---

## 12. Acceptance gate for new building art

New building sheets are accepted or rejected by a **test, not an opinion**:

1. Slice, trim, and composite the 13 into the real 99 × 125 Base cells (the §1 harness).
2. Flatten every sprite to a pure black alpha silhouette on white.
3. Show the silhouette sheet to someone who knows the building list, unlabelled.
4. **Pass condition: ≥ 11 of 13 named correctly.** The current set scores 3.
5. Reject condition, any of: a ground plate is present · a sprite exceeds 96 × 96 · two
   silhouettes are confusable · the light source disagrees with the unit sheets.

Re-run the map-simulation harness after the terrain addition to confirm the new variants do not
reintroduce the contrast problem.

---

## 13. Amendments to earlier records

1. **`VISUAL_DESIGN.md` §22.1** listed building sprites as "in use, as delivered — no work
   needed". Superseded: the building set is REPLACE (§4.1).
2. **`VISUAL_DESIGN.md` §17** specified sprite settlement markers. Superseded: markers are drawn
   (§4.3), and the four sprites are retired.
3. **`VISUAL_DESIGN.md` §18** specified a 24px faction emblem chip (1:4) in the tile sheet.
   Corrected to **48px (1:2)**; 24px is only used inside the 2× map marker. 1:4 from a 96px
   source is too aggressive for a detailed emblem.
4. **`VISUAL_DESIGN.md` §26.5** ("building sprites per level") is **closed** — never, see §10.4.

---

## 14. Production order

| Order | Work | Priority | Owner | Blocks |
|---|---|---|---|---|
| 1 | `bar_top` / `bar_bottom` → horizontal 9-patch | P0 | pipeline | the HUD and nav in M2c |
| 2 | `buildings_1_v2` + `buildings_2_v2` (13, silhouette-first) | P0 | owner (generation) → pipeline | the spatial Base; M2c ships on the current art until they land |
| 3 | `buildings.<type>.short` i18n key set | P0 | i18n | Base ground labels |
| 4 | Type → asset id maps (§9) | P0 | M2c | any sprite rendering |
| 5 | `terrain_tiles_extra` (3 wasteland variants) | P1 | owner → pipeline | nothing — pure improvement |
| 6 | Retire 32 assets from the manifest | P1 | pipeline | nothing |
| 7 | Resource icons at 16 × 16 | P2 | pipeline (downsample + QA) | nothing |
| 8 | Emblem / Beacon-hue QA against the identity palette | P2 | M6 | nothing |

**Nothing in this list blocks M2c from starting.** The Base can be built against the current
building sprites and swapped when the new sheets land, because the plot geometry (99 × 125,
sprites ≤ 96 × 96, 1:1) is identical for both sets.

---

## 15. Unresolved

| # | Question | Needed by |
|---|---|---|
| 1 | **Short building label wording** (§6.3) — mine are proposals; «Электрон.» in particular is a compromise to avoid colliding with «Мастерская». | M2c |
| 2 | **Does `hiddenCache` want a visible presence at all?** Its gameplay meaning is *concealment*, so the near-flat hatch is deliberate — but a player may read an almost-invisible plot as a rendering bug. The alternative is to give it a small above-ground marker that contradicts its fiction. My recommendation is the flat hatch plus a normal label, which is how every other plot reads. | building generation |
| 3 | **Display font** (carried from `VISUAL_DESIGN.md` §26.1) — still the one genuinely blocking pick, and it is a licensing question rather than an art one. | M2c |
| 4 | **Terrain tint values** (carried) — nine values to sample once the extra variants exist. | map at 0.5× |
| 5 | **M3/M5 art review** — battle art at 145 × 160 and medals at 31 × 56 have never been checked at display size against a real screen. Worth running the §1 harness on them before M3 rather than during it. | M3 |
