# Last Signal — asset-slicing session brief

Hand this to a fresh agent to build the `tools/assets` slicing pipeline. Paste it, or say
*"Read `docs/ASSET_SLICING_SESSION_PROMPT.md` and follow it."*

---

## Your role

You are implementing a **standalone tooling task**: `tools/assets`, a Node script (using
`sharp`) that slices the accepted raw art sheets in `art/raw/` into individual game sprites
plus a manifest, and writes them into `apps/web/public/assets/`.

This is **not** part of the M2 milestone flow. `docs/M2_DESIGN_DECISIONS.md` §11 explicitly
decided *not* to pull slicing forward into M2 (cost: pipeline + sheet-grid QA would eat
milestone time) and the plan (`docs/IMPLEMENTATION_PLAN.md` §5) schedules it for **M6 —
Visual polish**. The owner is choosing to do it now anyway, ahead of schedule, as an
isolated side task — all 18 raw sheets are already generated and accepted. Do not touch
`apps/server`, `packages/game-core`, or any M2 gameplay code. Do not update
`docs/PROGRESS.md`'s milestone log for this (it's outside the milestone sequence) — a short
note at the bottom of `docs/ASSET_PROMPTS.md` when you're done is enough.

## Load context first

1. `docs/ASSET_PROMPTS.md` — the full prompt book. Every sheet's **Content** column plus its
   own prompt block (further down the file) tells you exactly what's drawn on it and in what
   order/layout. Read every prompt block for the 18 files listed below before writing any
   slicing logic — the item order in the prompt is the left-to-right / row-order on the sheet.
2. `docs/IMPLEMENTATION_PLAN.md` §3.1 (repo layout: `tools/assets/` is where this lives,
   `art/raw/` is "source of truth for slicing") and §6 (Asset workflow: *"slice → trim →
   nearest-neighbor resize → `apps/web/public/assets/`"*).
3. `art/reference/mockup_ui_pixel.png` — binding style **and layout** reference; use it to
   sanity-check plausible in-game pixel sizes for UI elements.
4. `docs/M2_DESIGN_DECISIONS.md` §11 — the only concrete pixel-size decision that exists so
   far: map tile rendering uses **base tile size 32px** (DOM grid, `image-rendering:
   pixelated`, 3 zoom steps ~0.5×/1×/2×). Use this as the anchor for `terrain_tiles.png`'s
   output size; other categories (units, buildings, icons, UI chrome) have **no pinned size
   yet** — propose sensible defaults yourself (see "Target sizes" below) and record them,
   don't invent silently and don't block on asking.

## Input inventory — `art/raw/` (18 files, all already alpha-composite-verified clean)

Sheets are RGBA with real (if sometimes imperfect, max alpha ~254 instead of 255 — see
"technical gotcha" below) transparency, **except** `hero_landing.png` which is plain RGB,
fully opaque, full-bleed — do not trim or alpha-process it, just resize/copy it whole.

| File | Layout | Items (left→right, top→bottom) |
|---|---|---|
| `terrain_tiles.png` | uniform 3×3 grid | wasteland dirt ×3 variants, ruined city block, dead forest, irradiated lake, cracked highway, farm w/ windmill, rocky hills |
| `icons_resources_markers.png` | 2 rows × 4 | row1: scrap/fuel/circuit/food icons; row2: 4 village map markers (red-skull, blue-gear, green-bull, neutral-ruined) |
| `source_antenna.png` | single object | Signal Source map object, no slicing — trim only |
| `units_raiders.png` | 1 row × 5, **non-uniform column widths** (infantry vs. vehicle) | brute, molotov thrower, biker, scout w/ binoculars, siege pickup truck |
| `units_engineers.png` | 1 row × 5, non-uniform widths | exo-trooper, bulwark shield guard, quad bike, hover drone, tracked crane rig |
| `units_nomads.png` | 1 row × 5, non-uniform widths | skirmisher, sniper, dune buggy, falconer, ballista ox-wagon |
| `buildings_1.png` | 2 rows × 3, fairly uniform | command center, scrap yard, refinery, workshop, greenhouse, warehouse |
| `buildings_2.png` | 2 rows × 3, **item 4 is NOT a building** — it's a long horizontal wall segment with a different aspect ratio than the other 5 compact building tiles | cold storage, barracks, machine shop, **defensive wall + watchtower (irregular footprint)**, market, radio tower |
| `ui_buttons.png` | mixed grid: 3 rows × 2 large buttons (normal+pressed pairs) + a column of small square icon buttons (3 icon types × 2 states) + round toggle buttons + 2 separate progress-bar elements at the bottom | primary/secondary/danger buttons, icon buttons (X/gear/hammer), round toggles, progress-bar frame, green fill bar, orange fill bar |
| `ui_panels.png` | **irregular positions, not a grid** — 6 elements of different sizes | large 9-slice frame (empty center), card frame w/ bone header strip, top resource-bar strip, bottom nav-bar strip, circular badge frame, tooltip frame w/ pointer |
| `ui_nav_icons.png` | 1 row × 8, evenly spaced | flat bone-white glyphs: map, base/home, crossed weapons, scales, envelope+skull, radio tower, gear, trophy — **default state** |
| `ui_nav_icons_hover.png` | 1 row × 8, evenly spaced, **same subjects/order as `ui_nav_icons.png`** | full-color detailed versions of the identical 8 icons — **hover/active state**; must slice with the same column boundaries/order so icon `i` in one file pairs with icon `i` in the other |
| `side_emblems.png` | 2 items side by side, not a grid | BEACON (green signal waves badge), SILENCE (broken dish badge) |
| `faction_emblems.png` | 1 row × 3, uniform | Raiders skull, Engineers gear, Nomads bull skull |
| `battle_art.png` | 2 items side by side, not a grid, roughly-square-ish, not identical bbox size (see below) | VICTORY (exploding skull), DEFEAT (burning settlement) |
| `medals.png` | 1 row × 6, uniform-ish | gold/silver/bronze medals, crossed-swords badge, shield badge, radio-wave badge |
| `logo_title.png` | single graphic, no slicing | "LAST SIGNAL" logotype — trim only, one output sprite |
| `hero_landing.png` | single graphic, **opaque, no alpha, no trim** | full-bleed dusk wasteland vista — resize only, keep full-bleed |

## Technical requirements

1. **Language/tooling:** Node script(s) under `tools/assets/`, using `sharp` (already an
   acceptable new dependency per the plan — it's explicitly named there). Add it to the
   workspace; decide whether `tools/assets` is its own workspace package or a script package
   consumed via `pnpm --filter` — your call, keep it simple, follow the monorepo conventions
   already visible in `apps/*` and `packages/game-core` (TypeScript, `tsup`/`tsx`, no build
   step in the tool itself is fine if it's dev-only tooling, not shipped).
2. **Slicing.** For uniform-grid sheets, compute cell rects from sheet dimensions ÷ row/col
   count. For irregular sheets (`ui_panels.png`, `side_emblems.png`, `battle_art.png`, and the
   wall segment in `buildings_2.png`), detect each sprite's bounding box by **alpha-channel
   connected-component / bbox analysis** (any pixel with alpha above a small threshold, NOT
   `== 255` — see the gotcha below) rather than assuming a fixed grid cell.
3. **Trim.** After locating each sprite's cell/bbox, trim to the tight alpha bounding box
   within it (small uniform padding is fine) so sprites don't carry huge transparent margins.
   `sharp().trim()` can help but verify it against the real alpha data — don't trust it blindly
   on sheets with the near-255-but-not-quite alpha ceiling described below.
4. **Resize.** Nearest-neighbor (`sharp(...).resize(w, h, { kernel: 'nearest' })`) down to the
   final in-game pixel size once trimmed. **Target sizes are not fully pinned** — propose and
   document your own first-pass numbers (e.g. tile = 32px per the one anchor we have; units
   and buildings some multiple of that that reads clearly on a 61×61 map at the stated zoom
   levels; UI chrome sized to the actual CSS layout in `art/reference/mockup_ui_pixel.png`).
   Write them down in the manifest and in a short "Sizing decisions" note — this project's
   convention (see `docs/M2_DESIGN_SESSION_PROMPT.md`, "numbers vs shapes") is that concrete
   numbers are first-pass and can be tuned later; don't silently hardcode without recording.
5. **Manifest.** Emit `apps/web/public/assets/manifest.json` mapping a stable sprite id (e.g.
   `unit.raiders.brute`, `building.command_center`, `ui.icon.nav.map.default`,
   `ui.icon.nav.map.hover`) to its output file path, source sheet, and final pixel dimensions.
   Keep ids semantic and consistent — this is what game code will import by.
6. **Output file layout.** Organize `apps/web/public/assets/` into sensible subfolders (e.g.
   `units/`, `buildings/`, `ui/`, `emblems/`, `map/`) — your call, but keep it predictable and
   mirror it in the manifest.
7. **Idempotent & re-runnable.** The script must be safe to re-run from scratch (e.g. clear/
   overwrite its own output directory first) since raw sheets may get regenerated later.

## Known technical gotcha (from the review session that accepted these sheets)

ChatGPT-exported PNGs from this pipeline have alpha channels that cap at **254, not 255**,
and a large fraction of pixels carry partial alpha even in "fully transparent" background
regions (dirty un-premultiplied RGB baked under low alpha). This is **harmless for real
compositing** (verified by alpha-compositing every sheet over both pure black and the actual
game background `#16100B` — all clean) but it means:

- Do not threshold bbox/trim detection on `alpha == 255`; nothing will match. Use a small
  threshold like `alpha > 10`.
- Do not be alarmed if a raw preview of a sheet looks like it has a dark vignette/glow around
  the art — that was a rendering artifact of previewing un-composited RGBA, not a real defect,
  confirmed by compositing. Trust the alpha data, not how the raw PNG looks when eyeballed.

## Definition of Done

- `tools/assets` exists, runs via a documented command (e.g. `pnpm --filter tools-assets run
  slice` or similar — pick one and document it in the tool's own README or top-of-script
  comment).
- All 18 sheets processed; `apps/web/public/assets/manifest.json` lists every sprite with
  correct id, path, source sheet, and final size.
- Visual spot-check: render/composite a handful of sliced sprites (at least one per sheet,
  more for the irregular ones) over `#16100B` and confirm no accidental limb/edge cropping,
  no leftover transparent margins, and that the `ui_nav_icons` / `ui_nav_icons_hover` pairs
  line up by index.
- `pnpm lint && pnpm typecheck` clean for anything added under `tools/`.
- Append a short status note to the bottom of `docs/ASSET_PROMPTS.md` (a new "## Slicing"
  section is fine) recording: the command to re-run slicing, the sizing decisions made, and
  where the manifest lives.

## Hard rules

- Use `model: "sonnet"` for this work — it's well-scoped mechanical scripting (grid math +
  alpha bbox detection + resize), not a task that needs Opus-level judgment.
- Never `git commit` or `git push` — the owner commits personally after review.
- Don't touch `apps/server`, `packages/game-core`, or reopen any M2 design decision.
- Don't invent new product/UI decisions (e.g. don't redesign the nav bar) — you're producing
  sprite assets from already-accepted art, not making new art or layout calls.
- If a sheet's content genuinely doesn't fit the inventory description above (double-check
  against the actual PNG before assuming the table is wrong), stop and flag it rather than
  guessing a slice.
