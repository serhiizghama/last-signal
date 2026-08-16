# Last Signal — Asset Generation Prompt Book

All prompts needed to generate the full pixel-art asset set with ChatGPT (gpt-image-1).
The user runs these manually; accepted results go to `art/raw/` with the exact filenames
below. UI/style reference mockups live in `art/reference/` (`mockup_ui_pixel.png` is the
binding art direction). Slicing/normalization into game sprites happens later in a
dedicated Claude session.

## Generation rules (read before every session)

1. **One chat.** Generate everything in a single ChatGPT conversation. Keep the terrain
   tiles image early in the chat and reference it: *"same crisp pixel style as the
   terrain tiles image"*. Style drift (painterly/sketchy output) = reject & regenerate.
2. **Transparency.** Units, buildings, icons, UI: always demand *"isolated on a fully
   transparent background, no backdrop, no glow, no ground gradient"*. Terrain tiles
   are the only opaque sheets. Verify transparency by the checkerboard in the preview.
3. **Sizes.** Sheets: 1536×1024. Single objects / square sheets: 1024×1024. Exact
   in-game sizes are produced later by the slicing script (nearest-neighbor).
4. **Even spacing.** For sheets insist on *"one horizontal row, evenly spaced, same
   scale"* (or the stated grid) — it makes automated slicing trivial.
5. **Naming.** Save each result as `art/raw/<filename>` exactly as listed. If you make
   several attempts, keep only the accepted one.
6. **No text in images** (except the logo sheet). UI labels are rendered by the app.

## Style anchor — prepend to EVERY prompt

```
Warm 16-bit pixel art, post-apocalyptic browser strategy game asset. Dusty sunset palette: burnt orange, faded teal, bone white, dark rust browns. Crisp pixels, consistent scale, subtle black outline. No text, no watermarks, no UI frames.
```

## Reference palette (approx, for UI CSS — tune against final art)

| Token | Hex | Use |
|---|---|---|
| bg-deep | `#16100B` | page background |
| panel | `#2A211A` | panels, cards |
| panel-edge | `#4A3826` | frames, rivet borders |
| accent | `#D9772F` | primary buttons, highlights |
| teal | `#3F7E75` | secondary accent, Engineers |
| bone | `#E8D9B0` | primary text |
| toxic | `#7FD13B` | Signal/Beacon, success |
| danger | `#B33A2B` | attacks, Raiders, errors |

## Checklist

| # | File | Content | Status |
|---|---|---|---|
| 1 | `terrain_tiles.png` | 9 map tiles 3×3 | ✅ done |
| 2 | `icons_resources_markers.png` | 4 resource icons + 4 village markers | ✅ done |
| 3 | `source_antenna.png` | Signal Source map object | ✅ done |
| 4 | `units_raiders.png` | 5 Raider units | ✅ done |
| 5 | `units_engineers.png` | 5 Engineer units | ✅ done |
| 6 | `units_nomads.png` | 5 Nomad units | ✅ done |
| 7 | `buildings_1.png` | 6 buildings | ✅ done |
| 8 | `buildings_2.png` | 5 buildings + 1 defensive wall segment | ✅ done |
| 9 | `ui_buttons.png` | button set, normal+pressed | ✅ done |
| 10 | `ui_panels.png` | 9-slice frames, bars | ✅ done |
| 11 | `ui_nav_icons.png` | 8 navigation icons, flat bone-white glyphs (default state) | ✅ done |
| 11b | `ui_nav_icons_hover.png` | same 8 icons, full-color detailed (hover/active state) | ✅ done |
| 12 | `side_emblems.png` | Beacon & Silence emblems | ✅ done |
| 13 | `faction_emblems.png` | skull / gear / bull emblems | ✅ done |
| 14 | `battle_art.png` | victory / defeat report art | ✅ done |
| 15 | `medals.png` | season medals | ✅ done |
| 16 | `logo_title.png` | LAST SIGNAL logotype | ✅ done |
| 17 | `hero_landing.png` | login screen vista | ✅ done |

---

## Prompts

### 1. `terrain_tiles.png` ✅ (kept for regeneration reference)

```
Top-down terrain tile set for a strategy game world map, 9 square tiles in a 3x3 grid, seamless edges: cracked wasteland dirt (x3 variations), ruined city block, dead burnt forest, irradiated glowing lake, cracked asphalt highway straight segment, surviving green farm with windmill, rocky hills. 1024x1024.
```

### 2. `icons_resources_markers.png` ✅ (reference)

```
Game icon set on one sheet, two rows, isolated on a fully transparent background. Row 1, four resource icons: scrap metal pile, red fuel canister, green circuit board, canned food tin. Row 2, four map markers: small fortified village flying a red skull flag, village with a blue gear flag, village with a green bull flag, ruined neutral village. 1024x1024.
```

### 3. `source_antenna.png` ✅ (reference)

```
Single map object: colossal crashed satellite dish antenna array, half-buried in wasteland, scaffolding and cables, faint toxic-green signal glow rising from the dish, small warning signs around, no faction flags. 3/4 top-down view, fits one large map tile. Isolated on a fully transparent background. 1024x1024.
```

### 4. `units_raiders.png` ✅ (kept for regeneration reference)

```
Same crisp 16-bit pixel art style as the terrain tiles image. Sprite sheet, 5 post-apocalyptic raider units in one horizontal row, evenly spaced, same scale, full body side view: 1) brute with spiked rebar club and tire armor (offense infantry), 2) fighter hurling a molotov cocktail, fuel canisters on his back (defense infantry), 3) fast biker on a rusty motorcycle, 4) hooded lookout with binoculars and scrap-metal mask (scout), 5) siege unit: armored pickup truck with a mounted battering ram and catapult arm. Isolated sprites on a fully transparent background, no backdrop, no glow, no ground gradient. 1536x1024.
```

### 5. `units_engineers.png` ✅ (kept for regeneration reference)

```
Same crisp 16-bit pixel art style as the terrain tiles image. Sprite sheet, 5 post-apocalyptic engineer units in one horizontal row, evenly spaced, same scale, full body side view, blue-and-steel color identity: 1) exo-trooper in a bulky powered exoskeleton with hydraulic fists (offense infantry), 2) bulwark guard with a huge welded riot shield and arc-welder (defense infantry), 3) armored quad bike with reinforced plating (fast vehicle), 4) small hovering surveyor drone with one glowing camera eye (scout), 5) siege unit: tracked crane rig with a rail-mounted sling launcher. Isolated sprites on a fully transparent background, no backdrop, no glow, no ground gradient. 1536x1024.
```

### 6. `units_nomads.png` ✅ (kept for regeneration reference)

```
Same crisp 16-bit pixel art style as the terrain tiles image. Sprite sheet, 5 post-apocalyptic nomad units in one horizontal row, evenly spaced, same scale, full body side view, green-and-tan color identity: 1) skirmisher with twin machetes and scrap-leather armor (offense infantry), 2) gaunt hunter-sniper draped in tarp camouflage with a long rifle (defense infantry), 3) open dune buggy with a harpoon rack (fast vehicle), 4) hooded falconer with a hunting hawk on a leather glove (scout), 5) siege unit: wooden ballista wagon pulled by a huge mutant ox. Isolated sprites on a fully transparent background, no backdrop, no glow, no ground gradient. 1536x1024.
```

### 7. `buildings_1.png` ✅ (kept for regeneration reference)

```
Same crisp 16-bit pixel art style as the terrain tiles image — NOT painterly, NOT sketchy, clean flat pixel clusters with subtle black outline, even flat lighting, no dramatic rim light, no soft ambient shading. Sprite sheet, 6 post-apocalyptic base buildings in two rows of three, same scale, 3/4 top-down view: 1) command center made of stacked shipping containers with antennas and a flag mast, 2) scrap yard with a crane and metal piles, 3) fuel refinery with rusty tanks and pipes, 4) electronics workshop with solar panels on the roof, 5) hydroponic greenhouse farm with glowing grow-lights, 6) big warehouse of stacked crates and containers.

Background: pure flat transparent background, must render as a checkerboard pattern in the preview with zero color bleed. Absolutely no vignette, no radial glow, no dark corners, no ambient occlusion halo, no atmospheric haze, no ground shadow gradient around the sprites — each building isolated cleanly like a cut-out sticker, nothing but transparency behind it. 1536x1024.
```

### 8. `buildings_2.png` ✅ (kept for regeneration reference)

```
Same crisp 16-bit pixel art style as the terrain tiles image — NOT painterly, NOT sketchy, clean pixel clusters with subtle black outline. Sprite sheet, 6 post-apocalyptic base buildings in two rows of three, same scale, 3/4 top-down view: 1) refrigerated cold storage unit with frost on the doors, 2) barracks: fortified tents and a training yard with tire obstacles, 3) machine shop garage with a vehicle lift and welding sparks, 4) concrete defensive wall segment with barbed wire and a watchtower, 5) market: canopy stalls between two cargo trucks, 6) tall radio tower with dishes and blinking lights. Isolated on a fully transparent background. 1536x1024.
```

### 9. `ui_buttons.png` ✅ (kept for regeneration reference)

```
Same crisp 16-bit pixel art style as the terrain tiles image. Game UI button kit on one sheet, laid out in a neat grid, isolated on a fully transparent background. Riveted scrap-metal buttons with beveled pixel edges, in two states each (normal and pressed): 1) large primary button in burnt orange, 2) large secondary button in dark gunmetal, 3) large danger button in rust red, 4) small square icon button in gunmetal, 5) round toggle button. Also: 6) a horizontal progress bar frame with a separate toxic-green fill segment, 7) a horizontal progress bar fill in orange. No text on buttons. 1536x1024.
```

### 10. `ui_panels.png` ✅ (kept for regeneration reference)

```
Same crisp 16-bit pixel art style as the terrain tiles image. Game UI panel kit on one sheet, isolated on a fully transparent background: 1) large rectangular panel frame of dark riveted metal plates with worn edges, empty center (for nine-slice scaling), 2) smaller card frame with a lighter bone-colored header strip, empty center, 3) top resource bar background strip of dark metal, 4) bottom navigation bar background strip of dark metal with subtle rivets, 5) small circular badge frame, 6) tooltip frame with a small pointer arrow. Empty centers, no text. 1536x1024.
```

### 11. `ui_nav_icons.png` ✅ (kept for regeneration reference) — default state

```
Same crisp 16-bit pixel art style as the terrain tiles image. Set of 8 small game navigation icons in one row, evenly spaced, same size, isolated on a fully transparent background. Flat monochrome glyph icons, silhouette style like a UI icon font — solid bone-white (#E8D9B0) fill only, subtle dark outline, NO other colors, NO gradients, NO shading, NO internal color details: 1) folded wasteland map, 2) fortified base / home, 3) crossed weapons (army), 4) marketplace scales, 5) envelope with a wax skull seal (reports), 6) radio tower broadcasting waves (the Side / war), 7) gear (settings), 8) trophy (rankings). Same simple flat icon treatment as a mobile app tab bar, not a detailed illustration. 1536x1024.
```

### 11b. `ui_nav_icons_hover.png` ✅ (kept for regeneration reference) — hover/active state

```
Same crisp 16-bit pixel art style as the terrain tiles image. Set of 8 small game navigation icons in one row, evenly spaced, same size, isolated on a fully transparent background. Full-color detailed mini icon illustrations (same rendering style as icons_resources_markers.png), dusty sunset palette, subtle black outline: 1) folded wasteland map, 2) fortified base / home, 3) crossed weapons (army), 4) marketplace scales, 5) envelope with a wax skull seal (reports), 6) radio tower broadcasting waves (the Side / war), 7) gear (settings), 8) trophy (rankings). This is the hover/active-state variant paired with the flat bone-white ui_nav_icons.png default state — same subjects, same composition, full color instead of flat bone-white. 1536x1024.
```

### 12. `side_emblems.png` ✅ (kept for regeneration reference)

```
Same crisp 16-bit pixel art style as the terrain tiles image. Two large faction emblems side by side, isolated on a fully transparent background: 1) BEACON: a stylized radio dish emitting ascending toxic-green signal waves toward a star, hopeful, on a dark round metal badge, 2) SILENCE: the same dish broken and crossed out by a heavy iron bar, ash-grey and rust-red, ominous, on a dark round metal badge. Same badge size and style for both. 1536x1024.
```

### 13. `faction_emblems.png` ✅ (kept for regeneration reference)

```
Same crisp 16-bit pixel art style as the terrain tiles image. Three round faction emblems in one row, same size, isolated on a fully transparent background, painted-metal military badge style: 1) white skull on a rust-red field (Raiders), 2) white gear on a steel-blue field (Engineers), 3) white bull skull with horns on a moss-green field (Nomads). 1536x1024.
```

### 14. `battle_art.png` ✅ (kept for regeneration reference)

```
Same crisp 16-bit pixel art style as the terrain tiles image. Two square battle report emblems side by side, isolated on a fully transparent background: 1) VICTORY: a cracked enemy skull exploding into toxic-green pixel shards, triumphant, 2) DEFEAT: a burning ruined settlement silhouette in rust-red and ash. Same size, dramatic, no text. 1536x1024.
```

### 15. `medals.png` ✅ (kept for regeneration reference) (optional, M6)

```
Same crisp 16-bit pixel art style as the terrain tiles image. Six season medal icons in one row, same size, isolated on a fully transparent background: gold, silver and bronze hanging medals on short ribbons, each stamped with a tiny antenna emblem; then three special badges: crossed swords badge (top fighter), shield badge (top defender), radio wave badge (top contributor). 1536x1024.
```

### 16. `logo_title.png` ✅ (kept for regeneration reference)

```
Same crisp 16-bit pixel art style as the terrain tiles image. Game logo: the words "LAST SIGNAL" in chunky pixel letters made of welded scrap metal with rust and rivets, bone-white with burnt-orange edge light, a thin toxic-green signal wave passing through the letters, small antenna silhouette rising from the letter L. Isolated on a fully transparent background. 1536x1024.
```

### 17. `hero_landing.png` ✅ (kept for regeneration reference)

```
Same crisp 16-bit pixel art style as the terrain tiles image. Wide cinematic pixel art landscape: dusk over an endless post-apocalyptic wasteland, cracked earth and ruined highway leading toward a colossal crashed satellite dish on the horizon emitting a thin toxic-green beam into a darkening orange sky, tiny campfires of distant settlements. Painterly composition but strictly crisp pixel technique. Opaque full-bleed image, no transparency. 1536x1024.
```

---

## After a generation session

Drop accepted files into `art/raw/`, update the checklist above, then start a Claude
session for slicing: `tools/assets` scripts cut sheets, trim, resize (nearest-neighbor)
and emit final sprites to `apps/web/public/assets/` with a manifest JSON.

## Slicing

Done — all 18 raw sheets sliced ahead of schedule (originally M6) as an isolated side task;
see `docs/ASSET_SLICING_SESSION_PROMPT.md` for the brief. Re-run any time with:

```sh
pnpm --filter @last-signal/tools-assets run slice
```

This clears and regenerates `apps/web/public/assets/` (101 sprites) and
`apps/web/public/assets/manifest.json` (id → `{path, source, width, height}`) from the
current contents of `art/raw/`. Details of the slicing strategy (grid vs. alpha
connected-component bbox, the touching-sprite-recovery fallback, the alpha-254 gotcha) are
in `tools/assets/README.md`.

**Sizing decisions (first-pass, all tunable — see the "numbers vs shapes" convention in
`docs/M2_DESIGN_SESSION_PROMPT.md`).** Everything is a nearest-neighbor "fit inside" box
(aspect ratio preserved) except map tiles, which are forced to an exact size. Anchored on
the one pinned number: base map tile = 32px (`docs/M2_DESIGN_DECISIONS.md` §11).

| Category | Target box (px) | Notes |
|---|---|---|
| `map.tile.*` | 32×32 exact | the pinned anchor |
| `map.icon.resource.*` | 32×32 | top resource bar |
| `map.marker.village.*` | 40×40 | slightly larger than a tile so they read on the map |
| `map.object.signal_source` | 128×128 | sprawling multi-tower complex, reads as a landmark |
| `unit.*` (15, all 3 factions) | 96×64 | infantry end up narrower, vehicles wider — aspect preserved |
| `building.*` (11 compact) | 96×96 | ~3×3 tile footprint |
| `building.wall` | 192×64 | long wall+watchtower segment, irregular aspect |
| `ui.button.primary/secondary/danger.*` | 168×56 | |
| `ui.button.icon.*`, `.round.*`, `.toggle.*` | 40×40 | |
| `ui.progress.frame` | 240×40 / fills 220×20 | frame and fill aren't pixel-locked to each other yet — tune together once the progress bar is laid out in CSS |
| `ui.panel.frame_large` | 256×256 | large 9-slice frame, kept larger for stretch headroom |
| `ui.panel.card` | 176×176 | |
| `ui.panel.bar_top` / `.bar_bottom` | 400×48 | |
| `ui.panel.badge` | 64×64 | |
| `ui.panel.tooltip` | 112×80 | |
| `ui.icon.nav.*` | 32×32 | matches the left/bottom nav rail in `art/reference/mockup_ui_pixel.png` |
| `emblem.*` (side + faction) | 96×96 | |
| `battle.victory` / `.defeat` | 160×160 | |
| `medal.*` | 56×56 | |
| `brand.logo` | 640×320 | |
| `brand.hero_landing` | 1536×1024 | full-bleed, no trim, resized only |

**Deviations from the session brief, both mechanical judgment calls, not product/art
decisions:**

- The brief's explicit bbox-detection list was `ui_panels.png`, `side_emblems.png`,
  `battle_art.png`, and the wall segment in `buildings_2.png`. In practice every sheet
  except `terrain_tiles.png` (whose tiles tile edge-to-edge with zero transparent gap, so
  fixed grid math is mandatory) uses bbox detection, including the nominally-uniform grids
  (`icons_resources_markers.png`, `buildings_1.png`, `faction_emblems.png`, `medals.png`,
  the nav icon pairs) and the "non-uniform column widths" unit-row sheets the inventory
  table flagged. bbox self-corrects each sprite's real bounds rather than trusting assumed
  cell math, which is strictly safer and still satisfies "detect via alpha bbox rather than
  assuming a fixed grid cell."
- A few sheets have a prop that visually touches a neighboring sprite (a raider's club
  reaching toward the molotov thrower in `units_raiders.png`; debris spanning the row gap
  between two buildings in `buildings_1.png`/`buildings_2.png`), which merges them into one
  connected component. Rather than hand-picking pixel cutoffs, the slicer auto-recovers by
  splitting the merged blob at its cleanest seam (see `tools/assets/README.md`). Spot-checked
  visually after the fact — all 101 sprites crop cleanly with no accidental limb/edge loss.
- `ui.button.round.*` / `ui.button.toggle.*` naming: the sheet has 4 round widgets (2 plain
  glossy push-buttons + 2 lever-style toggles with an off/on hazard-stripe cue) where the
  brief only said "round toggle buttons" generically. Split into `ui.button.round.normal`/
  `.pressed` and `ui.button.toggle.off`/`.on` by visual inspection — reasonable but not a
  pinned product decision, revisit if the UI ends up not needing a distinct plain round push
  button.
