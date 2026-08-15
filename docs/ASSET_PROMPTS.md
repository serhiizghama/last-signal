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
| 4 | `units_raiders.png` | 5 Raider units | 🔁 redo (transparent bg) |
| 5 | `units_engineers.png` | 5 Engineer units | ⬜ todo |
| 6 | `units_nomads.png` | 5 Nomad units | ⬜ todo |
| 7 | `buildings_1.png` | 6 buildings | 🔁 redo (style drifted) |
| 8 | `buildings_2.png` | 6 buildings | ⬜ todo |
| 9 | `ui_buttons.png` | button set, normal+pressed | ⬜ todo |
| 10 | `ui_panels.png` | 9-slice frames, bars | ⬜ todo |
| 11 | `ui_nav_icons.png` | 8 navigation icons | ⬜ todo |
| 12 | `side_emblems.png` | Beacon & Silence emblems | ⬜ todo |
| 13 | `faction_emblems.png` | skull / gear / bull emblems | ⬜ todo |
| 14 | `battle_art.png` | victory / defeat report art | ⬜ todo |
| 15 | `medals.png` | season medals | ⬜ todo (M6, optional) |
| 16 | `logo_title.png` | LAST SIGNAL logotype | ⬜ todo |
| 17 | `hero_landing.png` | login screen vista | ⬜ todo |

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

### 4. `units_raiders.png` 🔁

```
Same crisp 16-bit pixel art style as the terrain tiles image. Sprite sheet, 5 post-apocalyptic raider units in one horizontal row, evenly spaced, same scale, full body side view: 1) brute with spiked rebar club and tire armor (offense infantry), 2) fighter hurling a molotov cocktail, fuel canisters on his back (defense infantry), 3) fast biker on a rusty motorcycle, 4) hooded lookout with binoculars and scrap-metal mask (scout), 5) siege unit: armored pickup truck with a mounted battering ram and catapult arm. Isolated sprites on a fully transparent background, no backdrop, no glow, no ground gradient. 1536x1024.
```

### 5. `units_engineers.png`

```
Same crisp 16-bit pixel art style as the terrain tiles image. Sprite sheet, 5 post-apocalyptic engineer units in one horizontal row, evenly spaced, same scale, full body side view, blue-and-steel color identity: 1) exo-trooper in a bulky powered exoskeleton with hydraulic fists (offense infantry), 2) bulwark guard with a huge welded riot shield and arc-welder (defense infantry), 3) armored quad bike with reinforced plating (fast vehicle), 4) small hovering surveyor drone with one glowing camera eye (scout), 5) siege unit: tracked crane rig with a rail-mounted sling launcher. Isolated sprites on a fully transparent background, no backdrop, no glow, no ground gradient. 1536x1024.
```

### 6. `units_nomads.png`

```
Same crisp 16-bit pixel art style as the terrain tiles image. Sprite sheet, 5 post-apocalyptic nomad units in one horizontal row, evenly spaced, same scale, full body side view, green-and-tan color identity: 1) skirmisher with twin machetes and scrap-leather armor (offense infantry), 2) gaunt hunter-sniper draped in tarp camouflage with a long rifle (defense infantry), 3) open dune buggy with a harpoon rack (fast vehicle), 4) hooded falconer with a hunting hawk on a leather glove (scout), 5) siege unit: wooden ballista wagon pulled by a huge mutant ox. Isolated sprites on a fully transparent background, no backdrop, no glow, no ground gradient. 1536x1024.
```

### 7. `buildings_1.png` 🔁

```
Same crisp 16-bit pixel art style as the terrain tiles image — NOT painterly, NOT sketchy, clean pixel clusters with subtle black outline. Sprite sheet, 6 post-apocalyptic base buildings in two rows of three, same scale, 3/4 top-down view: 1) command center made of stacked shipping containers with antennas and a flag mast, 2) scrap yard with a crane and metal piles, 3) fuel refinery with rusty tanks and pipes, 4) electronics workshop with solar panels on the roof, 5) hydroponic greenhouse farm with glowing grow-lights, 6) big warehouse of stacked crates and containers. Isolated on a fully transparent background. 1536x1024.
```

### 8. `buildings_2.png`

```
Same crisp 16-bit pixel art style as the terrain tiles image — NOT painterly, NOT sketchy, clean pixel clusters with subtle black outline. Sprite sheet, 6 post-apocalyptic base buildings in two rows of three, same scale, 3/4 top-down view: 1) refrigerated cold storage unit with frost on the doors, 2) barracks: fortified tents and a training yard with tire obstacles, 3) machine shop garage with a vehicle lift and welding sparks, 4) concrete defensive wall segment with barbed wire and a watchtower, 5) market: canopy stalls between two cargo trucks, 6) tall radio tower with dishes and blinking lights. Isolated on a fully transparent background. 1536x1024.
```

### 9. `ui_buttons.png`

```
Same crisp 16-bit pixel art style as the terrain tiles image. Game UI button kit on one sheet, laid out in a neat grid, isolated on a fully transparent background. Riveted scrap-metal buttons with beveled pixel edges, in two states each (normal and pressed): 1) large primary button in burnt orange, 2) large secondary button in dark gunmetal, 3) large danger button in rust red, 4) small square icon button in gunmetal, 5) round toggle button. Also: 6) a horizontal progress bar frame with a separate toxic-green fill segment, 7) a horizontal progress bar fill in orange. No text on buttons. 1536x1024.
```

### 10. `ui_panels.png`

```
Same crisp 16-bit pixel art style as the terrain tiles image. Game UI panel kit on one sheet, isolated on a fully transparent background: 1) large rectangular panel frame of dark riveted metal plates with worn edges, empty center (for nine-slice scaling), 2) smaller card frame with a lighter bone-colored header strip, empty center, 3) top resource bar background strip of dark metal, 4) bottom navigation bar background strip of dark metal with subtle rivets, 5) small circular badge frame, 6) tooltip frame with a small pointer arrow. Empty centers, no text. 1536x1024.
```

### 11. `ui_nav_icons.png`

```
Same crisp 16-bit pixel art style as the terrain tiles image. Set of 8 small game navigation icons in one row, evenly spaced, same size, isolated on a fully transparent background, bone-white pixel glyphs with subtle outline: 1) folded wasteland map, 2) fortified base / home, 3) crossed weapons (army), 4) marketplace scales, 5) envelope with a wax skull seal (reports), 6) radio tower broadcasting waves (the Side / war), 7) gear (settings), 8) trophy (rankings). 1536x1024.
```

### 12. `side_emblems.png`

```
Same crisp 16-bit pixel art style as the terrain tiles image. Two large faction emblems side by side, isolated on a fully transparent background: 1) BEACON: a stylized radio dish emitting ascending toxic-green signal waves toward a star, hopeful, on a dark round metal badge, 2) SILENCE: the same dish broken and crossed out by a heavy iron bar, ash-grey and rust-red, ominous, on a dark round metal badge. Same badge size and style for both. 1536x1024.
```

### 13. `faction_emblems.png`

```
Same crisp 16-bit pixel art style as the terrain tiles image. Three round faction emblems in one row, same size, isolated on a fully transparent background, painted-metal military badge style: 1) white skull on a rust-red field (Raiders), 2) white gear on a steel-blue field (Engineers), 3) white bull skull with horns on a moss-green field (Nomads). 1536x1024.
```

### 14. `battle_art.png`

```
Same crisp 16-bit pixel art style as the terrain tiles image. Two square battle report emblems side by side, isolated on a fully transparent background: 1) VICTORY: a cracked enemy skull exploding into toxic-green pixel shards, triumphant, 2) DEFEAT: a burning ruined settlement silhouette in rust-red and ash. Same size, dramatic, no text. 1536x1024.
```

### 15. `medals.png` (optional, M6)

```
Same crisp 16-bit pixel art style as the terrain tiles image. Six season medal icons in one row, same size, isolated on a fully transparent background: gold, silver and bronze hanging medals on short ribbons, each stamped with a tiny antenna emblem; then three special badges: crossed swords badge (top fighter), shield badge (top defender), radio wave badge (top contributor). 1536x1024.
```

### 16. `logo_title.png`

```
Same crisp 16-bit pixel art style as the terrain tiles image. Game logo: the words "LAST SIGNAL" in chunky pixel letters made of welded scrap metal with rust and rivets, bone-white with burnt-orange edge light, a thin toxic-green signal wave passing through the letters, small antenna silhouette rising from the letter L. Isolated on a fully transparent background. 1536x1024.
```

### 17. `hero_landing.png`

```
Same crisp 16-bit pixel art style as the terrain tiles image. Wide cinematic pixel art landscape: dusk over an endless post-apocalyptic wasteland, cracked earth and ruined highway leading toward a colossal crashed satellite dish on the horizon emitting a thin toxic-green beam into a darkening orange sky, tiny campfires of distant settlements. Painterly composition but strictly crisp pixel technique. Opaque full-bleed image, no transparency. 1536x1024.
```

---

## After a generation session

Drop accepted files into `art/raw/`, update the checklist above, then start a Claude
session for slicing: `tools/assets` scripts cut sheets, trim, resize (nearest-neighbor)
and emit final sprites to `apps/web/public/assets/` with a manifest JSON.
