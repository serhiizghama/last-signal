# Last Signal — visual design system

**Status: RESOLVED for every surface M1 and M2 ship.** Produced from `docs/design/UX_DESIGN.md`
and `docs/design/WIREFRAMES.md` in the visual design session of 2026-08-16, with four
art-direction decisions settled with the owner (§24).

**This document is the source of truth for asset specification.** `docs/ASSET_PROMPTS.md`
remains the source of truth for *how art is generated*; this document decides **what is
needed, at what size, and what is not needed at all** (§22). Where the two disagree about an
asset's role, this one wins.

**Authority.** For visual questions this document wins over `IMPLEMENTATION_PLAN.md` §3.5 and
over the shipped `apps/web/src/styles.css`. It does not touch UX structure — for screen
responsibilities, flows and states, `UX_DESIGN.md` and `WIREFRAMES.md` remain binding. Four
places where it corrects shipped code or an earlier record are listed in §25.

**The governing constraint, above all aesthetics:**

> **Decoration dims. Actors don't.**
> On every screen, the things the player can act on must be the highest-contrast,
> highest-saturation elements present. Art that is scenery is treated as scenery.

---

## 1. Visual principles

1. **Clarity outranks decoration.** If a frame, texture or border does not encode state, it
   is removed. Ambiguity is never solved by adding chrome.
2. **State is encoded twice.** Colour plus shape, or colour plus text. Never colour alone —
   this is both an accessibility floor and a legibility one on a phone in daylight.
3. **One action per surface.** Exactly one primary CTA is the highest-contrast element on any
   screen or sheet. If two things compete, one of them isn't primary.
4. **Integer pixels only.** Pixel art is never scaled by a fractional factor. Where the
   geometry doesn't allow it, the geometry changes — not the scaling.
5. **Depth by value, not by blur.** Elevation is expressed with fill steps and hard 2px
   edges. No soft shadows, no blur, no rounded corners anywhere in the interface.
6. **Motion reports, it doesn't perform.** Progress bars move at the true rate. Nothing
   animates for delight.
7. **Identity is carried by the world, state by the interface.** Faction and side colours
   live inside marker and emblem shapes; interface colour means what is happening.

---

## 2. Chrome model — what is sprite, what is drawn

**Decision §24.1: hybrid.** The sprite kit is a decorative art board, not a systematic
9-patch UI kit — `primary_normal.png` carries a diagonal highlight through its centre
(unsliceable), `card.png` is a portrait frame with a banner on one edge (undistortable). Only
the two bars are genuinely built to stretch.

| Layer | Rendered as | Why |
|---|---|---|
| **Persistent bars** — top HUD, bottom nav | **Sprite**, horizontal 9-slice (`bar_top.png`, `bar_bottom.png`) | fixed end caps, neutral stretchable centre; on screen 100% of the time, so identity is bought once and paid for never |
| **Buttons, panels, sheets, cards, rows, inputs, bars, badges** | **Drawn** — flat palette fills, hard 2px edges, zero radius | must stretch to any width and hold long Russian strings at guaranteed contrast |
| **World content** — buildings, units, terrain, markers, emblems, medals, battle art | **Sprite**, 1:1 wherever possible | this is where the pixel art belongs and where it competes with nothing |
| **Small interface glyphs** — nav icons, gear, close, resource icons | **Sprite**, 1:1 at native size | already produced at usable sizes |

**Consequence:** the button, card, frame, tooltip, badge and progress sprites are **not used
in the product** (§22.3). They remain valid art-board reference. This is a deliberate
retirement, not an oversight.

---

## 3. Colour system

**Decision §24.4: the palette is split by role.** State colours are reserved for interface
state. Identity colours are reserved for faction and side, appear **only inside a marker or
emblem shape**, and are never a text colour, button fill, border or background.

### 3.1 Surfaces and text

| Token | Hex | Use |
|---|---|---|
| `surface-void` | `#100B07` | map void beyond the world edge; progress-bar tracks |
| `surface-base` | `#16100B` | page background (existing `bg-deep`) |
| `surface-panel` | `#221A14` | panels, sheets, the HUD content band |
| `surface-raised` | `#2A211A` | rows and cards inside a panel (existing `panel`) |
| `edge-soft` | `#3A2C1E` | internal dividers, row separators |
| `edge` | `#4A3826` | default component border (existing `panel-edge`) |
| `edge-strong` | `#6B5333` | sheet top edge, world boundary, emphasis borders |
| `text-primary` | `#E8D9B0` | body and values (existing `bone`) |
| `text-secondary` | `#B9A886` | labels, units, secondary values |
| `text-muted` | `#8A7B60` | hints, timestamps, elided detail |
| `text-disabled` | `#5E5342` | the label of a disabled control **only** |
| `text-on-accent` | `#16100B` | text sitting on an accent or warning fill |

Depth is a three-step ramp: `surface-base` → `surface-panel` → `surface-raised`. A fourth
step does not exist; if a design needs one, the hierarchy is wrong.

### 3.2 State palette — interface only

| Token | Hex | Means | Appears as |
|---|---|---|---|
| `accent` | `#D9772F` | primary action · active · in progress · yours | button fill, active nav, progress fill, selection border |
| `accent-text` | `#D9772F` | same, as type | 5.1:1 on `surface-panel` — passes AA |
| `warning` | `#C9A227` | waste or attention: storage full, Food deficit, idle queue | fill bar, badge, text |
| `danger` | `#B33A2B` | destructive action, loss, threat | button border, marker fill |
| `danger-text` | `#E2685A` | errors and losses, as type | 5.0:1 — the base `danger` is **2.8:1 and must never be used as text** |
| `success` | `#7FD13B` | completed, gained, returned safely | text, brief completion flash |
| `info` | `#3F7E75` | neutral informational (distance, travel, oasis) | borders and fills |
| `info-text` | `#5FA79C` | same, as type | 6.0:1 — the base `info` is 3.4:1 and fails as text |

**Warning is new.** The original palette had none, which forced "storage full" and "Food
deficit" to borrow `success` and `danger` — two states that mean the opposite of each other
and neither of which means "you are wasting production". Full storage and an idle queue are
now the same colour, because they are the same problem: capacity going to waste.

**Accent and danger are both warm and adjacent in hue.** They are kept apart by *form*, not
by hue: `accent` is the only colour ever used as a large fill; `danger` appears as a border,
as text, or inside a marker — never as a filled button. A filled orange block and red text
are never confusable at 11px.

### 3.3 Identity palette — inside shapes only

| Token | Hex | Subject |
|---|---|---|
| `faction-raiders` | `#8C3A34` | Рейдеры |
| `faction-engineers` | `#3F6E8C` | Инженеры |
| `faction-nomads` | `#5B7A3F` | Кочевники |
| `side-beacon` | `#C7B27A` | Маяк |
| `side-silence` | `#6E6A63` | Тишина |

All five are deliberately **darker and less saturated than every state colour**, so an
identity element can never out-shout a state element. Permitted uses: the fill of a map
marker, the fill of an identity chip in a list row, the tint of an emblem plate. Forbidden
uses: text colour, button fill, border of any interactive control, screen background.

**Beacon is no longer toxic green.** The generated `side_emblems.png` paints Beacon's signal
waves in toxic green, which now collides with `success`. The emblem art stays as painted —
it is a picture, inside a shape — but the *side token* used anywhere in the interface is the
pale gold above. Flagged for the M6 art QA pass (§26.3).

### 3.4 Contrast floor

| Content | Minimum | Enforced by |
|---|---|---|
| Text ≥ 12px | 4.5:1 | every text token above is measured on `surface-panel` |
| Text ≥ 17px, and all component edges | 3:1 | `edge` is 2.1:1 on `surface-panel` — decorative only; anything an edge must *communicate* uses `edge-strong` or a state colour |
| Disabled control label | exempt | but its adjacent **reason text stays at 4.5:1** — see §7.5 |

---

## 4. Typography

**Decision §24.2: a bitmap display face for short uppercase labels, system sans for
everything else.**

### 4.1 The two faces

**Display face — bitmap.** Requirements, in priority order:

1. Full Cyrillic including `Ё`/`ё`, plus Latin and digits.
2. Designed on an 8px em, so it renders exactly at 16px (2×) and 24px (3×).
3. Redistributable licence (OFL or equivalent) — this repository is public.
4. Uppercase forms that stay distinguishable at 16px in Russian (`И`/`Н`, `Ш`/`Щ`, `Ь`/`Ы`).

Rendering rules: **never below 16px**, only at 16px or 24px, uppercase only, letter-spacing
0, line-height a whole multiple of the em, antialiasing off, never sets a sentence.

**Body face — system UI sans.** The platform stack (SF Pro on iOS, Roboto on Android). No
webfont, no loading state, full Cyrillic guaranteed, and numerals set with tabular figures so
a ticking countdown never shifts layout.

**If no bitmap face meets all four requirements** (§26.1), the fallback is a condensed sans
for display. The system survives that substitution intact, because the display face is scoped
to six string types and never carries meaning the body face can't.

### 4.2 Type scale

| Role | Face | Size / line | Case | Used for |
|---|---|---|---|---|
| `display-l` | bitmap | 24 / 32 | UPPER | screen titles, report verdicts (`РАЗВЕДКА УСПЕШНА`) |
| `display-s` | bitmap | 16 / 24 | UPPER | sheet titles, section headers, **primary CTA labels** |
| `body-l` | sans 600 | 15 / 20 | sentence | building names, settlement names, row titles |
| `body-m` | sans 400 | 13 / 18 | sentence | default body, costs, descriptions |
| `body-s` | sans 400 | 12 / 16 | sentence | block reasons, hints, empty-state copy |
| `caption` | sans 600 | 11 / 14 | UPPER | tab labels, chips, badges, column headers |
| `numeric-l` | sans 600 tabular | 17 / 20 | — | HUD resource values, active countdowns |
| `numeric-m` | sans 400 tabular | 13 / 18 | — | costs, distances, secondary countdowns |

**11px is the floor.** Nothing in the product is smaller.

**Russian typesetting rules.** No letter-spacing on lowercase Cyrillic — it damages
readability far more than it does Latin. No uppercase on strings longer than ~16 characters.
Every button and chip in this system was sized against its longest real string
(`Максимальный уровень`, `Возвращается домой`, `Электронная мастерская`).

### 4.3 Where the display face appears

Exactly six places: screen titles, sheet titles, section headers, primary CTA labels, report
verdicts, and the round chip's day number. Everywhere else is the body face. This
concentration is what makes it read as deliberate rather than decorative.

---

## 5. Visual hierarchy

Five levels. Every element belongs to exactly one.

| Level | Content | Treatment |
|---|---|---|
| **L0 — decoration** | terrain, base ground texture, bar ornament | dimmed (§16.2); never the brightest thing on screen |
| **L1 — surface** | panels, sheets, rows, the HUD band | `surface-panel` / `surface-raised` + `edge` |
| **L2 — content** | text, values, building and unit sprites, markers | `text-primary` / full-saturation sprites |
| **L3 — state** | countdowns, progress, warnings, errors, selection | state palette |
| **L4 — action** | the primary CTA | `accent` fill, the single highest-contrast element |

**Two hard rules.** One L4 per surface. At most **two** simultaneous L3 colours per screen —
past two, state colour stops carrying meaning and becomes noise.

---

## 6. Spacing and grid

4px base unit. The permitted scale is **4 · 8 · 12 · 16 · 24 · 32**. Nothing else.

| Context | Value |
|---|---|
| Screen horizontal padding | 12 (ground: 0 — see §17.1) |
| Panel / sheet padding | 16 |
| Row / card padding | 12 |
| Gap between sections | 16 |
| Gap between rows | 8 |
| Gap within a row (label ↔ value) | 8 |
| Gap between icon and its label | 4 |
| Separation between primary and destructive actions | ≥ 16, or opposite ends of the row |

---

## 7. Components and states

### 7.1 Primary CTA

| Property | Value |
|---|---|
| Height | 48 |
| Width | fills its container (screen padding or sheet padding) |
| Fill | `accent` |
| Border | none (the fill is the signal) |
| Label | `display-s` bitmap 16px uppercase, `text-on-accent` |
| Pressed | fill darkens one step, content shifts 1px down, 80ms |
| Position | thumb zone — bottom of its surface |

### 7.2 Secondary CTA

Height 44 · transparent fill · 2px `edge-strong` border · `caption` 11px uppercase in
`text-primary` · pressed fills with `surface-raised`.

### 7.3 Tertiary / link

No border, no fill. `body-m` in `accent-text`, trailing `›`. Used for the `›` fix links under
blocked controls and for cross-screen navigation.

### 7.4 Destructive

Height 44 · transparent fill · 2px `danger` border · label `caption` in `danger-text`.
**Never an accent fill, never adjacent to the primary CTA.** Used for `Отменить` (build,
training) and `Отозвать` (movement).

### 7.5 Disabled

| Property | Value |
|---|---|
| Fill | `surface-panel` (flat, no texture) |
| Border | `edge-soft` |
| Label | `text-disabled` |
| **Reason text below** | `body-s` in `danger-text` or `text-secondary` — **at full contrast** |

**Never dim a disabled control with opacity.** The shipped `styles.css` uses `opacity: 0.5`
on `.button:disabled`, which fades the control *and everything associated with it*. A player
cannot read why they are blocked through a 50% veil. Disabled controls are **restyled, not
faded**, and the reason beside them is always fully legible (§25.2).

### 7.6 Selected

One signal — `accent` plus an edge — with the form adapting to the container:

| Container | Selected treatment |
|---|---|
| Map tile | terrain returns to full colour + 2px `accent` inset border + 4px `accent` corner ticks |
| Base plot | 2px `accent` border + 12% `accent` wash over the cell |
| List row | 4px `accent` left rule + `surface-raised` fill |
| Segmented control | active segment filled `accent`, label `text-on-accent` |

### 7.7 Pressed, focus, loading

- **Pressed:** one fill step darker + 1px content offset, 80ms. No scale, no bounce.
- **Focus (keyboard):** 2px `text-primary` outline, 2px offset. Required — the game is a
  browser app before it is a Mini App.
- **Loading (action in flight):** label swaps to `Отправка…`, control takes the disabled fill
  but **keeps its accent border**, so the player can see which control they committed.

### 7.8 Panels, sheets, cards

| Surface | Fill | Border | Radius | Notes |
|---|---|---|---|---|
| Panel | `surface-panel` | 2px `edge` | 0 | padding 16 |
| **Bottom sheet** | `surface-panel` | 2px `edge-strong` on the top edge only | 0 | full-bleed horizontally; 24px handle zone with a 32×4 `edge-strong` grip; max height 435, expands to 650; **stops above the nav** |
| Card / row | `surface-raised` | 1px `edge-soft` | 0 | padding 12 |
| Scrim behind a sheet | `surface-void` at 60% | — | — | the tapped object stays visible above the sheet |

No radii anywhere. A rounded corner cannot be drawn in a pixel grid without either
antialiasing or a staircase, and both undermine the art.

### 7.9 Feedback colours in use

| Situation | Colour | Second signal |
|---|---|---|
| Storage full, production halted | `warning` | bar at 100% + `ПОЛНО` + «производство остановлено» |
| Net Food negative | `warning` | `▼` glyph beside the value |
| Build / training completed | `success` | 1.5s flash on the plot, then normal + toast |
| Scouts returned safely | `success` | toast |
| Error from an action | `danger-text` | 4px `danger` left rule + text under the control |
| Scouts lost | `danger-text` | report verdict in `display-l` |
| In progress | `accent` | countdown + progress bar |

---

## 8. Resource HUD

Total band **56px**, `bar_top.png` 9-sliced (24px caps, stretchable centre), content inset
10px horizontally and vertically centred.

```
├─ cap ─┬──────────── stretchable centre ─────────────┬─ cap ─┤
│ ЛОМ 24 731   ТОП 18 300   ЭЛК 32 000   ЕДА 620  ▼   Д5·А1 ⚙│
│ ▓▓▓▓▓▓▓░░░   ▓▓▓▓▓░░░░░   ▓▓▓▓▓▓▓▓▓▓   ▓▓░░░░░░░            │
└──────────────────────────────────────────────────────────────┘
      ↑ accent          ↑ accent        ↑ warning   ↑ warning
```

| Element | Spec |
|---|---|
| Resource cell | label `caption` 11px `text-secondary` + value `numeric-l` 17px `text-primary`; min width 64; gap 8 |
| Fill bar | 3px tall, full cell width, track `surface-void`, fill `accent`; **`warning` at 100%** |
| Food deficit | fill bar turns `warning`, `▼` 8×8 glyph after the value |
| Round chip | 40×24, 1px `edge-strong`, day number in `display-s`, act in `caption` |
| Gear | 24×24 sprite in a 44×44 touch area |
| Number format | exact below 100 000 (`24 731`, thin space separator), compact above (`124k`); tabular figures always |
| Tap targets | each resource cell → resource sheet; chip → round sheet; gear → settings |

**The HUD ships with three-letter labels, not icons** (§22.4). The resource icons are 32×32
native; 20px would be a fractional downscale and 32px would not fit four cells plus the chip
and gear in 402px. `ЛОМ / ТОП / ЭЛК / ЕДА` is unambiguous, survives the black-boxes test, and
costs nothing. A 16×16 icon set is a specified future upgrade, not a dependency.

---

## 9. Navigation

Total **58px**, `bar_bottom.png` 9-sliced. Four items, each ~100px.

| State | Icon | Label | Marker |
|---|---|---|---|
| Active | hover-variant sprite, full colour, 32×32 at 1:1 | `caption` in `accent` | 2px `accent` rule along the item's top edge |
| Inactive | default-variant sprite (flat bone) at 60% | `caption` in `text-muted` | none |

**Badges.** 16×16 square (18×16 for two digits), positioned at the icon's top-right,
`caption` 10px in `text-on-accent`.

- `accent` badge = **something awaits you** (unread reports).
- `danger` badge = **something threatens you** (incoming attacks, M3).

Two different meanings must never share a badge colour; this reservation is made now so M3
does not have to renegotiate it.

---

## 10. Build queue and progress

**Progress bar** — 6px tall, track `surface-void`, fill `accent`, 1px `edge-soft` frame, no
gradient, no shine, no indeterminate animation. Width advances **linearly against real
time**; an eased progress bar misreports the state of the world.

**Queue strip (Base, 44px)**

| Zone | Content |
|---|---|
| Left | `⏱` glyph + building name `body-l` + target level |
| Right | countdown `numeric-m` in `accent` + `›` |
| Bottom edge | 3px progress line, full-bleed to the strip's edges |
| Empty | «Очередь пуста» in `warning`, `›` in `accent`, no progress line |

Idle capacity uses `warning` for the same reason full storage does: both are production going
to waste.

**Queue sheet rows** — active row carries the progress bar and `В РАБОТЕ` in `accent`;
waiting rows carry a 20×20 position square in `text-secondary` and a start wall-clock; the
free slot is an `edge-soft` dashed row reading `— свободный слот`.

**Training rows** — identical grammar, driven by `remainingCount` of `totalCount` with the
countdown on `nextCompletesAt`; the bar represents the *current unit*, not the batch, and the
count carries the batch.

---

## 11. Notifications

| Kind | Spec |
|---|---|
| **Toast** | 48px, full width − 12px margins, `surface-raised`, 2px border in the event's semantic colour, 4px left rule in the same colour, `body-m` `text-primary`, trailing `›`. Anchored below the HUD. One at a time, ~4s, tappable. Slides 120ms. |
| **Offline banner** | 32px, `surface-panel`, 2px `danger` top and bottom edges, `danger-text` `body-s`, secondary `(Повторить)`. Persistent, directly under the HUD, above tab content. |
| **Inline error** | 4px `danger` left rule, 12px inset, `body-s` in `danger-text`, immediately under the control that failed. Never a toast. |
| **Badge** | §9. |

Toast semantic colours: `accent` for a neutral event (report arrived), `success` for a
completion (build done, scouts home), `danger` for a loss (scouts lost).

---

## 12. Pixel-art scaling

**Integer factors only: 1×, 2×, 3×.** Fractional scaling of pixel art is prohibited; where
geometry conflicts with that rule, the geometry changes.

| Asset class | Native | Displayed | Factor |
|---|---|---|---|
| Building sprites | 68–96 | 68–96 (Base ground **and** detail sheet) | **1:1** |
| Unit sprites | 44–87 × 64 | same | 1:1 |
| Terrain tiles | 32 × 32 | 32 (zoom 1×) / 64 (zoom 2×) / flat tint (0.5×) | 1:1, 2:1, n/a |
| Settlement markers | 30 × 40 | same | 1:1 |
| Nav icons | ~32 | 32 | 1:1 |
| Faction emblems | 93–96 | 96 (settings) / 24 (row chip) | 1:1, 1:4 |
| Side emblems | 95–96 | 96 / 24 | 1:1, 1:4 |
| Brand logo | 555 × 320 | 277 × 160 | 1:2 |
| Battle art (M3) | ~145 × 160 | same | 1:1 |
| Medals (M5) | ~31 × 56 | same | 1:1 |

**Downscaling is done in the asset pipeline, never by the browser.** Where a 1:2 or 1:4
variant is specified, `tools/assets` produces it with a proper downsample; the browser only
ever draws sprites at their delivered size with nearest-neighbour rendering.

**Validated:** the Base ground needs **no scaling at all** — see §17.1.

---

## 13. Component sizing

| Component | Size |
|---|---|
| Minimum touch target | 44 × 44 (map tiles get 44px tolerance around a 32px cell) |
| Primary CTA | 48 tall |
| Secondary / destructive | 44 tall |
| Single-line row | 44 tall |
| Two-line row | 56 tall |
| Troop row (64px unit sprite) | 72 tall |
| Top HUD | 56 |
| Bottom nav | 58 |
| Context row | 36 |
| Queue strip | 44 |
| Influence line | 28 |
| «Следующий шаг» line | 32 |
| Sheet handle zone | 24 |
| Base ground cell | **99 × 125** |
| Map tile | 32 (1×) |
| Inline icon | 16 · HUD 16 (future) · nav 32 · map marker 30×40 |

---

## 14. Information density

| Rule | Limit |
|---|---|
| Information levels per row | 3 (name · value · state) |
| Simultaneous L3 state colours per screen | 2 |
| Primary CTAs per surface | 1 |
| Distinct blocks in a sheet | 5 — beyond that it becomes a full screen |
| Resource values in one row | 4 (the HUD's own limit) |
| Interactive objects on the Base ground | 13 (12 buildings + one `+`, by UX decision) |
| Truncation | names truncate to one line with `…`; **numbers never truncate** — they compact |
| Empty space | is a feature; no surface is filled merely because it has room |

---

## 15. Base — visual identity

**Base communicates: settlement · development · construction · buildings · resources.**

| Lever | Treatment |
|---|---|
| **Environment** | a warm, lit ground plane — `surface-base` with the wasteland dirt tile as texture, **dimmed to 45% brightness** (it is decoration) |
| **Scale** | large objects, 68–96px sprites in 99px cells — you are standing in it |
| **Density** | sparse: at most 13 interactive objects, each permanently labelled |
| **Temperature** | warm — `accent` carries construction, progress and the CTA |
| **Motion** | progress: bars filling, countdowns falling, a `success` flash on completion |
| **Structure** | a fixed board; pinned strips never move; nothing scrolls |
| **Labels** | always visible on every object (name + level) |

### 15.1 Ground geometry — validated

| Measure | Value |
|---|---|
| Available height | 726 − 36 context − 44 queue − 28 influence − 32 next-step − 48 CTA = **538** |
| Grid | 4 columns × 4 rows |
| Cell | (402 − 3 × 2 gutters) ÷ 4 = **99 wide** × 125 tall; **zero horizontal page padding on the ground only** |
| Sprite box | 99 × 101 (max sprite 96 × 96 fits with margin) |
| Label | 16px band under the sprite |
| Ground total | 4 × 125 = **500** — fits 538 with 38 spare |

**This is why the ground is 4 columns.** At 3 columns the cells would be wider but only 4
rows fit, and buildings would have to be scaled fractionally. At 4 columns every building
sprite renders **1:1** — the best possible outcome for pixel art, achieved by choosing the
grid to suit the assets rather than the reverse.

### 15.2 Plot states

| State | Treatment |
|---|---|
| Built | sprite 1:1 · short name `caption` `text-secondary` · level `caption` `accent` |
| Queued (waiting) | sprite at 60% brightness · label `ур.2→3` · `в очереди` in `text-muted` |
| Under construction | sprite at full brightness · label `ур.4→5` · countdown `numeric-m` in `accent` · 3px progress line across the cell bottom |
| Just completed | `success` border flash, 1.5s, then normal |
| Empty `+` plot | 2px `edge-soft` dashed square, 32×32 `+` glyph in `text-muted`, `построить` in `caption` |
| Plain ground | nothing — no affordance is drawn where none exists |
| Selected | 2px `accent` border + 12% `accent` wash |

**Short building names are required** (§22.5). A 99px cell cannot hold «Электронная
мастерская». Ground labels use a separate short-name key set; full names appear in sheets and
lists.

---

## 16. Map — visual identity

**Map communicates: spatial orientation · targets · distance · movement · selection ·
scouting.**

| Lever | Treatment |
|---|---|
| **Environment** | cold void — `surface-void` beyond a 2px `edge-strong` world boundary; the wasteland has a visible edge, which is thematically correct and orientationally useful |
| **Scale** | small objects, 32px tiles — you are looking from far away |
| **Density** | dense field, sparse actors: ~216 tiles, 1–5 of them actionable |
| **Temperature** | cool and neutral — `info` carries distance and travel; `accent` is reserved for *your* things and the CTA |
| **Motion** | positional: markers travel; nothing else moves |
| **Structure** | a free surface that pans and zooms; viewport state persists |
| **Labels** | on demand — names only at 2× zoom, everything else via the tile sheet |

### 16.1 Base ↔ Map, stated plainly

**Chrome is identical** — same HUD, same nav, same buttons, same type. Learnability depends
on it, and a player switching tabs should never have to re-learn where anything is.

**Environment inverts.** Home is lit, close and warm; the world is dim, distant and cold. The
player knows which screen they are on from a peripheral glance, before reading a single word
— and the difference is carried entirely by **treatment of art the interface already owns**,
not by a second chrome system.

### 16.2 Terrain treatment — decision §24.3

Terrain is decoration and is rendered through a fixed dim treatment: **brightness 55%,
saturation 65%, plus a 12% `surface-void` overlay**. Markers, oases, movement chevrons and
the selected tile render at full strength.

| Zoom | Terrain | Reason |
|---|---|---|
| 0.5× | **flat tint per terrain type**, 16px cells | halving 32px pixel art destroys it, and at overview zoom the player wants density, not texture — **this resolves `WIREFRAMES.md` §35.2** |
| 1× | tile sprite at 32px, dimmed | default |
| 2× | tile sprite at 64px (2:1), dimmed | detail + names |

Tile separation: 1px `surface-void` at 20% at 1× and 2×; none at 0.5×.

The nine flat tint values are sampled from each tile's dominant colour and then **darkened
and desaturated to the same ceiling as the dimmed sprites**, so 0.5× and 1× read as the same
world. Sampling is an implementation step (§26.2).

---

## 17. Map markers and selection

**Every marker is distinguishable by shape alone.** Colour is the second signal, never the
first — this satisfies both the accessibility floor and the black-boxes test.

| Object | Shape | Fill | Outline | Placement |
|---|---|---|---|---|
| Settlement (other) | pennant, 30 × 40 sprite | identity colour | 2px `surface-void` | bottom-centred on its tile, overflows 8px upward |
| **Own settlement** | same pennant | identity colour | 2px `surface-void` | **plus a 2px `accent` ring around the whole tile, at every zoom** |
| Oasis | the farm tile itself, **rendered undimmed** | — | 2px `info` inset border on the tile | in place |
| Movement, outbound | chevron 12 × 12, solid | `accent` | 1px `surface-void` | interpolated along the path, pointing at the target |
| Movement, returning | chevron 12 × 12, **hollow** | none, 2px `accent` edge | — | pointing home |
| Intel held | 8 × 8 dot | `text-primary` | — | marker's top-right; 40% opacity when older than 12h |
| Signal Source (M5) | reserved, 48 × 48 | `success` | — | reserved; `success` appears nowhere else on the map |

**The oasis solution is deliberate.** An oasis is a *place*, not a pin, so it is expressed by
un-dimming its own tile rather than by adding a marker. It costs no new art, it reads
instantly against the dimmed field, and it is consistent with the governing rule: it is an
actor, so it does not dim.

**Selected tile:** terrain returns to full colour, 2px `accent` inset border, 4px `accent`
corner ticks. Un-dimming *is* the selection signal — the same mechanism, used twice, which is
why the dim treatment earns its keep beyond mere legibility.

---

## 18. Sheets, cards and rows in use

| Surface | Composition |
|---|---|
| **Tile sheet** | title `display-s` + coordinates `numeric-m` `text-muted` · identity chip (24px emblem at 1:4 + name `caption`) · distance and travel `body-m` with `info-text` numerals · intel block separated by a 1px `edge-soft` divider with an age header in `text-muted` · primary CTA |
| **Building sheet** | title `display-s` + level `accent` · effect rows `сейчас → станет` with the delta in `success` · cost row (4 tokens, `numeric-m`) · time `numeric-m` · primary CTA · reason `body-s` |
| **ПОСТРОЙКИ list** | section headers `caption` in `text-muted` · rows `surface-raised` · per-row `[ПОСТРОИТЬ]` at secondary weight (the sheet has no single primary) · collapsed group as a full-width `edge-soft` row with `▸` |
| **Report detail** | verdict `display-l` in `success` / `danger-text` · blocks separated by `edge-soft` · numbers `numeric-m` tabular and right-aligned in their columns · footer with tertiary + primary |

**Numbers align.** Every cost vector, resource table and troop count is right-aligned on a
consistent column so quantities can be compared vertically without reading labels.

---

## 19. Motion

| Event | Duration | Curve |
|---|---|---|
| Press feedback | 80ms | linear |
| Sheet in / out | 120ms | ease-out / ease-in |
| Toast in / out | 150ms | ease-out |
| Selection change | 80ms | linear |
| Progress bar | continuous | **linear, real-time** |
| Movement marker | continuous | linear against the server clock |
| Completion flash | 1500ms | step |

No parallax. No idle animation. No easing that implies mass or bounce — this is a
post-apocalyptic logistics game, not a toy. `prefers-reduced-motion` disables slides and
flashes; progress and marker movement continue, because they are information.

---

## 20. Accessibility

1. Every state encoded twice (§1.2).
2. Contrast floors per §3.4; the four corrected tokens (`danger-text`, `info-text`,
   `warning`, `text-muted`) exist specifically to meet them.
3. Disabled controls are restyled, never faded (§7.5).
4. Touch targets ≥ 44px, including map tiles.
5. Keyboard focus ring on every interactive element.
6. Icon-only controls (gear, close, zoom, recentre) carry text labels for assistive tech.
7. No information conveyed by hue alone — verified per marker in §17.

---

## 21. Design tokens

Naming only; values are in §3, §4, §6, §13. Grouped as `surface-*`, `text-*`, `edge-*`,
`accent`/`warning`/`danger`/`success`/`info` (+ `-text` variants), `faction-*`, `side-*`,
`space-*`, `size-*`, `type-*`.

**Retired from the shipped stylesheet:** `--panel` → `surface-raised`, `--panel-edge` →
`edge`, `--bg-deep` → `surface-base`, `--bone` → `text-primary`, `--teal` → `info`,
`--toxic` → `success`. The old names carried no role information, which is how `toxic` ended
up meaning "success", "Beacon" and "the Signal" simultaneously.

---

## 22. Asset specification

### 22.1 In use, as delivered — no work needed

| Asset | Count | Size | Where |
|---|---|---|---|
| Building sprites | 13 | 68–96 | Base ground **and** detail sheets, 1:1 |
| Unit sprites | 15 | 44–87 × 64 | Войска rows, training sheet, 1:1 (M2 uses 3) |
| Terrain tiles | 9 | 32 × 32 | map, 1:1 and 2:1 |
| Settlement markers | 4 | 30 × 40 | map, 1:1 |
| Nav icons | 8 × 2 states | ~32 | bottom nav, 1:1 (M2 uses 4) |
| Faction emblems | 3 | ~96 | settings 1:1, row chips 1:4 |
| Side emblems | 2 | ~96 | settings 1:1, row chips 1:4 |
| Icon buttons (gear, close) | 2 × 2 states | ~40 | HUD, sheets |
| Signal source | 1 | 128 × 122 | M5 |
| Battle art | 2 | ~145 × 160 | M3 report headers |
| Medals | 6 | ~31 × 56 | M5/M6 |
| Brand logo | 1 | 555 × 320 | Welcome, 1:2 |
| Hero landing | 1 | 1536 × 1024 | M6 landing page, outside the app |

### 22.2 Needs a pipeline pass

| Asset | Work |
|---|---|
| `bar_top.png` · `bar_bottom.png` | **Re-cut as horizontal 9-patches** with declared cap widths (~24px) and a verified tileable centre. This is the only chrome slicing the product needs. |

### 22.3 Produced but **not used** — retired from the product

`primary/secondary/danger buttons` (×2 states), `round`/`toggle` buttons, `card.png`,
`frame_large.png`, `tooltip.png`, `badge.png`, `progress_frame.png`,
`progress_fill_green/orange.png`.

Reason: all are fixed-aspect decorative pieces that cannot stretch to hold Russian strings at
arbitrary widths, and the drawn equivalents give strictly better contrast and state
legibility. They remain valid art-board reference and may return in M6 for fixed-size
ornaments (a report seal, a medal plate) where nothing has to stretch.

**No regeneration is requested.** This is a usage decision, not a quality complaint.

### 22.4 Requested new assets — none blocking

| Asset | Size | Priority | Note |
|---|---|---|---|
| Resource icons, small set | 4 × 16 × 16 | optional | HUD upgrade; ships fine with three-letter labels |
| Building sprites, plan variants | 13 × 48 × 48 | **not needed** | the 99px grid made 1:1 work — recorded so nobody commissions these |

### 22.5 Non-art asset requests

| Item | Owner |
|---|---|
| **Short building names** — a `buildings.<type>.short` key set, ≤ 10 characters, for 99px ground labels | i18n (M2c) |
| Nine terrain tint values, sampled from the tiles and clamped to the dim ceiling (§16.2) | implementation (M2c) |

---

## 23. What each screen must communicate — verification

| Screen | Required reading | Carried by |
|---|---|---|
| **Base** | settlement | the ground plane, 13 labelled buildings at full size, warm treatment |
| | development | levels on every plot, Influence bar, round chip |
| | construction | queue strip + per-plot countdown + progress lines in `accent` |
| | buildings | sprites 1:1, names and levels always visible |
| | resources | persistent HUD with cap fill bars |
| **Map** | spatial orientation | dimmed terrain field, visible world boundary, own-settlement `accent` ring at every zoom |
| | targets | full-saturation markers on a dimmed field — the only bright things |
| | distance | tiles as a unit of measure, plus explicit distance and travel time in the sheet and list |
| | movement | travelling chevrons, solid out / hollow back |
| | selection | tile un-dims to full colour + accent border and ticks |
| | scouting | intel dot on scouted markers, intel block in the sheet, ageing to 40% |

---

## 24. Decisions made with the owner (2026-08-16)

| # | Decision | Rationale | Rejected |
|---|---|---|---|
| 1 | **Hybrid chrome** — sprite bars for the two persistent surfaces, drawn chrome everywhere else | the kit's buttons and cards cannot stretch; identity is bought where it is constant, clarity kept where the player reads | all-drawn (wastes the two assets that *do* work); re-cut everything as 9-patches (a second slicing pass on sources that may have no tileable centres); fixed-size sprite buttons (breaks the full-width thumb-zone CTA and cannot hold «Максимальный уровень») |
| 2 | **Bitmap display face ≥16px + system sans body** | identity where you glance, legibility where you read; the display face is scoped to six string types so it can be swapped without redesign | sans everywhere (reads as a dashboard with pixel art in it); condensed military sans (pragmatic, kept as the documented fallback); pixel font everywhere (Russian block reasons at 12px become unreadable) |
| 3 | **Dim the ground, light the actors** | directly implements "terrain must not compete with interaction"; it is a filter value, not new art; and un-dimming doubles as the selection signal | full terrain + marker halos (every tile still competes); flat tints at all zooms (discards the terrain art at the default zoom) |
| 4 | **Palette split by role** — state colours for UI, identity colours inside shapes only | a Beacon marker glowing the same green as a success state, or a Raiders marker in error red, misleads systematically | one shared palette (ambiguity exactly when scanning a map or reading a failure); identity-owns-colour (warning and danger would rest on icon and text alone) |

---

## 25. Corrections to shipped code and earlier records

1. **`danger` fails as text.** `#B33A2B` on `surface-panel` is **2.8:1** — below AA — and the
   shipped `styles.css` uses it for `.building-card__reason` and `.building-card__missing`,
   i.e. for the block reasons a player most needs to read. Replaced by `danger-text`
   `#E2685A` (5.0:1). Same correction for `teal` (3.4:1) → `info-text` (6.0:1).
2. **Disabled controls must not use opacity.** `.button:disabled { opacity: 0.5 }` fades the
   control and everything the eye groups with it. Replaced by an explicit disabled style with
   the reason text at full contrast (§7.5).
3. **`UX_DESIGN.md` §7.1 — full storage is `warning`, not `accent`.** The UX record said a
   full bar renders in accent; accent means "in progress / yours", and a halted warehouse is
   neither. Full storage, Food deficit and an idle queue now share `warning`, because they are
   the same problem.
4. **`WIREFRAMES.md` §35.2 is resolved:** map zoom 0.5× renders flat terrain tints, not
   downscaled tiles (§16.2).

---

## 26. Unresolved

| # | Question | Blocks |
|---|---|---|
| 1 | **Display font selection.** Needs a face meeting all four requirements in §4.1 — full Cyrillic, 8px em, redistributable licence, legible Russian uppercase at 16px. I have not verified any candidate's licence or glyph coverage, and will not specify one I cannot check. Fallback (condensed sans) is documented and costs no redesign. | first implementation of any title |
| 2 | **Nine terrain tint values** must be sampled from the actual tiles and clamped to the dim ceiling. Mechanical, but it needs the tiles open in a tool. | map at 0.5× |
| 3 | **Existing marker and emblem art vs the identity palette.** The four painted markers and five emblems were generated before §3.3 existed; Beacon in particular is painted toxic green. Needs an M6 QA pass to confirm they sit inside the new hues, or a recolour. | M6 |
| 4 | **Ground layout algorithm** — slot order vs category clustering (carried from `WIREFRAMES.md` §35.1). Now partly constrained: whatever the order, it fills a 4 × 4 grid of 99 × 125 cells. My recommendation remains slot order, for spatial memory. | M2c |
| 5 | **Building sprites per level** (carried). The 1:1 grid leaves no room for a larger silhouette at high levels, so a level badge remains the likely answer. | M6 |
| 6 | **M3 and M5 surfaces** — combat report art, the incoming-attack chrome colour (reserved `danger`), medals, the Source. Specified only far enough to reserve their tokens. | M3 / M5 |
