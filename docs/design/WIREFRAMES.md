# Last Signal — low-fidelity wireframes

**Status: RESOLVED for every surface M1 and M2 ship.** Produced from
`docs/design/UX_DESIGN.md` (the primary source of truth) in the wireframe session of
2026-08-16, with four structural decisions settled with the owner (§29). Where wireframing
exposed a contradiction or a gap in the UX record, it is recorded in §30 as a required
amendment — not silently diverged from.

**These are wireframes, not designs.** No colour, no sprites, no typography, no spacing
system. Every box below is a box. The test each screen had to pass:

> *If all artwork were removed and only black boxes and text remained, could the player
> still understand what this screen is, what state the game is in, and what to do next?*

Anything that failed that test was redesigned, not restyled.

**Not to scale.** The ASCII frames are 46 characters wide and schematic. The real viewport
is **402 × 840 px**; pixel heights are annotated in the right margin where they constrain
the layout. Icons are written as short text tokens (`ЛОМ`, `ТОП`, `ЭЛК`, `ЕДА`) precisely
because a wireframe must not depend on an icon being recognisable.

**Data binding.** Every value shown maps to a real field. Shipped: `SettlementStateView`
(`buildings`, `resources`, `ratesPerHour`, `netFoodPerHour`, `storageCaps`, `buildQueue`,
`troops`, `trainingQueue`, `influence`, `serverTime`) and `MapView` (`world`, `settlements`,
`oases`). Specified but not yet built (M2b): `GET /api/movements/mine`, `POST /api/movements`,
`POST /api/movements/:id/cancel`, `GET /api/reports`. Where a wireframe needs a field that
does not exist yet, it is flagged inline and listed in §31.

---

## 1. Notation

| Symbol | Meaning |
|---|---|
| `┌─┐ │ └─┘` | screen or panel boundary |
| `[ ТЕКСТ ]` | primary CTA (one per surface, always CAPS) |
| `( текст )` | secondary / ghost action |
| `‹ ТЕКСТ ›` | segmented control or toggle; active segment in `[ ]` |
| `[ТЕКСТ]✗` | disabled control — a reason is **always** adjacent |
| `▸ / ▾` | collapsed / expanded disclosure |
| `●N` | badge with a count |
| `▓▓▓░░` | progress or fill bar (always paired with a number) |
| `⏱` | a countdown value follows |
| `→` | the «Следующий шаг» line (it is a link, not a label) |
| `▼` | deficit marker (net Food < 0) |
| `‹`  `›` | navigation affordance (back / drill-in) |
| `✕` | close / dismiss |
| `···` | elided repeated rows |
| `⌷` | skeleton block (loading placeholder) |

---

## 2. Screen inventory

| ID | Surface | Type | Milestone | §  |
|---|---|---|---|---|
| W01 | Global shell (top bar, nav, layers) | chrome | M2c | §3 |
| W02 | Base — steady state | tab | M2c | §4 |
| W03 | Base — first session (day 1) | tab | M2c | §5 |
| W04 | Base — build in progress | tab | M2c | §4.3 |
| W05 | Building detail (built) | sheet | M2c | §6 |
| W06 | Building detail — blocked variants | sheet | M2c | §6.3 |
| W07 | Building upgrade — after commit | sheet | M2c | §7 |
| W08 | ПОСТРОЙКИ list | sheet | M2c | §8 |
| W09 | Build queue — expanded | sheet | M2c | §9 |
| W10 | Resource detail | sheet | M2c | §10 |
| W11 | Round timeline | sheet | M2c | §11 |
| W12 | Map — grid view | tab | M2c | §12 |
| W13 | Map — «СПИСОК» view | tab | M2c | §13 |
| W14 | Tile sheet — 4 variants | sheet | M2c | §14 |
| W15 | Send scout — form | sheet | M2c | §15 |
| W16 | Send scout — confirmation | **deliberately absent** | — | §16 |
| W17 | Send scout — status + recall | sheet | M2c | §17 |
| W18 | Movement in transit | tab+marker | M2c | §18 |
| W19 | Arrival (composite) | multi | M2c | §19 |
| W20 | Войска — populated | tab | M2c | §20 |
| W21 | Войска — empty | tab | M2c | §20.3 |
| W22 | Training picker (Barracks) | sheet | M2c | §21 |
| W23 | Отчёты — list | tab | M2c | §22 |
| W24 | Отчёты — detail, 4 variants | screen | M2c | §23 |
| W25 | Settings | sheet | M2c | §24 |
| W26 | Loading states | all | M2c | §25 |
| W27 | Empty states | all | M2c | §26 |
| W28 | Error states | all | M2c | §27 |
| W29 | Onboarding (shipped) | screens | M1 ✅ | §28 |

---

## 3. W01 — Global shell

**Viewport** 402 × 840. **Persistent on every tab:** top bar (56) + bottom nav (58).
**Content budget:** 840 − 56 − 58 = **726 px**, minus safe-area insets.

```
┌──────────────────────────────────────────────┐
│ ЛОМ24.7k ТОП18.3k ЭЛК10.6k ЕДА620  Д5·А1  ⚙ │ 56  PERSISTENT
│ ▓▓▓▓▓▓░░ ▓▓▓▓░░░░ ▓▓▓▓▓▓▓▓ ▓▓░░▼            │
├──────────────────────────────────────────────┤
│                                              │
│                                              │
│                                              │
│              СОДЕРЖИМОЕ ТАБА                 │ 726
│                                              │
│                                              │
│                                              │
├──────────────────────────────────────────────┤
│   БАЗА     КАРТА     ВОЙСКА    ОТЧЁТЫ●3     │ 58  PERSISTENT
└──────────────────────────────────────────────┘
```

**Top bar anatomy (left → right)**

| Slot | Content | Tap |
|---|---|---|
| 1–4 | resource value + cap fill bar | opens W10 (resource detail) |
| Food | value + fill bar + `▼` when `netFoodPerHour < 0` | opens W10 |
| chip | `Д5·А1` — day of round, act | opens W11 (round timeline) |
| gear | settings | opens W25 |

- **Number format:** exact below 100 000 (`24 731`), compact above (`124k`). Affordability
  judgements are made in the building sheet against a stated cost, not by eyeballing the bar,
  so compaction at the top end costs nothing. Tabular figures — a value ticking 9 → 10 must
  not move the chip.
- **Fill bar** = `value / storageCaps[kind]`. Full bar + emphasis = production halted.
- The bar is **read-only apart from three deliberate taps.** No actions live in the top bar.

**Bottom nav** — four tabs in M2 (`БАЗА · КАРТА · ВОЙСКА · ОТЧЁТЫ`), ~100 px each. Badges
mean *something needs you*: unread report count on ОТЧЁТЫ. Settings is never a tab.

**Layer model (z-order)**

```
  4  Toast              (transient, top edge, ≤1 at a time, ~4s)
  3  Sheet              (bottom, ≤60% height, drag/back dismissible)
  2  Offline banner     (below top bar, persistent while offline)
  1  Tab content
  0  Top bar + bottom nav        ← NEVER covered
```

**Rule: sheets sit above the bottom nav, never over it.** The nav is persistent chrome
(UX §7.1); a sheet that hides it would make "persistent" false and trap the player behind a
dismiss gesture. A sheet's maximum height is therefore `726 × 0.6 ≈ 435 px`, expandable to
`~650 px`, always stopping short of the nav.

**Sheets never stack.** Opening a sheet from a sheet replaces it, and back returns to the
previous one.

**Navigation:** tabs are routes (`/base`, `/map`, `/army`, `/reports`). Sheets push a
history entry so browser/Android back closes the sheet rather than leaving the screen.

---

## 4. W02 — Base, steady state

**The screen answers:** *what is my settlement, and what should I build next?*

```
┌──────────────────────────────────────────────┐
│ ЛОМ24.7k ТОП18.3k ЭЛК10.6k ЕДА620  Д5·А1  ⚙ │ 56
│ ▓▓▓▓▓▓░░ ▓▓▓▓░░░░ ▓▓▓▓▓▓▓▓ ▓▓░░             │
├──────────────────────────────────────────────┤
│ Лагерь «Грань»                        5:−24 │ 36  контекст
├──────────────────────────────────────────────┤
│                                              │
│   ┌────────┐  ┌────────┐  ┌────────┐        │
│   │ ШТАБ   │  │ МЕТАЛЛ │  │  НПЗ   │        │
│   │  ур.4  │  │  ур.3  │  │  ур.2  │        │
│   └────────┘  └────────┘  └────────┘        │
│                                              │
│   ┌────────┐  ┌────────┐  ┌────────┐        │ ~500
│   │ ТЕПЛИЦА│  │ СКЛАД  │  │ БАРАКИ │        │ грунт
│   │  ур.5  │  │  ур.2  │  │  ур.1  │        │
│   └────────┘  └────────┘  └────────┘        │
│                                              │
│   ┌────────┐                                 │
│   │   +    │                                 │
│   │построить│                                │
│   └────────┘                                 │
│                                              │
├──────────────────────────────────────────────┤
│ ⏱ ШТАБ ур.5            01:24:15          ›  │ 44  очередь
│ ▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░  1/3            │
├──────────────────────────────────────────────┤
│ Влияние 240 / 400 — второе поселение         │ 28
│ ▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░                    │
├──────────────────────────────────────────────┤
│ → Очередь освободится через 01:24            │ 32  след. шаг
├──────────────────────────────────────────────┤
│ [            ПОСТРОЙКИ                    ] │ 48  PRIMARY
├──────────────────────────────────────────────┤
│   БАЗА     КАРТА     ВОЙСКА    ОТЧЁТЫ●3     │ 58
└──────────────────────────────────────────────┘
```

### 4.1 Specification

| Aspect | Value |
|---|---|
| **Viewport** | 402 × 840 |
| **Persistent** | top bar, bottom nav |
| **Main content** | the ground: built buildings + one `+` plot |
| **Primary CTA** | `[ ПОСТРОЙКИ ]` — pinned in the thumb zone |
| **Secondary** | tap a building (→ W05), tap `+` (→ W08), tap queue strip (→ W09), tap Influence (no-op in M2), tap `→` line (navigates to whatever resolves it) |
| **Selection state** | tapping a plot marks it selected (outline emphasis) and opens its sheet; selection clears on sheet dismiss |
| **Disabled state** | none on this screen — the ground is never disabled; blocking happens inside sheets, where a reason fits |
| **Overlay** | none by default |
| **Navigation** | four tabs; no back (this is a root) |
| **Nothing scrolls** | the ground auto-fits; every strip is always visible |

### 4.2 Plot anatomy

A plot is a labelled box. Level is **text, not a badge on art** — the wireframe test
demands the level survive the removal of the sprite.

```
 built                in queue (waiting)      building now
┌────────┐            ┌────────┐             ┌────────┐
│ ТЕПЛИЦА│            │ СКЛАД  │             │ ШТАБ   │
│  ур.5  │            │ ур.2→3 │             │ ур.4→5 │
└────────┘            │ в очер.│             │⏱24:15  │
                      └────────┘             │▓▓▓░░░░ │
                                             └────────┘
```

**This resolves a state the UX record did not define** (§30.1): a building that is queued
or under construction must be legible *on the ground*, not only in the queue strip.
Otherwise the player taps a building, is told "уже в очереди", and learns nothing from the
screen they were looking at.

### 4.3 W04 — variant: build in progress

Identical to W02 except: the constructing plot renders the third form above, and the queue
strip shows the active item with its countdown and progress. When the queue is empty the
strip reads `Очередь пуста` with emphasis — idle capacity is a **problem**, presented as one.

```
├──────────────────────────────────────────────┤
│ ⏱ Очередь пуста                          ›  │ 44
├──────────────────────────────────────────────┤
│ → Очередь пуста — заложите постройку         │ 32
```

### 4.4 Transitions

| From | Trigger | To |
|---|---|---|
| W02 | tap built plot | W05 (building detail sheet) |
| W02 | tap `+` plot | W08 (ПОСТРОЙКИ sheet) |
| W02 | tap `[ ПОСТРОЙКИ ]` | W08 |
| W02 | tap queue strip | W09 (queue expanded) |
| W02 | tap a resource | W10 |
| W02 | tap `Д5·А1` | W11 |
| W02 | tap `→` line | context-dependent (table in §33) |
| W02 | build completes (countdown → 0 → refetch) | W02 with plot level incremented + toast |

---

## 5. W03 — Base, first session (day 1)

The hardest screen in the game to get right: one building, negative Food, twelve blocked
options. **UX goal: this must read as one instruction, not twelve failures.**

```
┌──────────────────────────────────────────────┐
│ ЛОМ 750  ТОП 750  ЭЛК 400  ЕДА 600     Д1·А1 ⚙│ 56
│ ▓░░░░░░  ▓░░░░░░  ▓░░░░░░  ▓░░░▼            │
├──────────────────────────────────────────────┤
│ Лагерь «Грань»                        5:−24 │ 36
├──────────────────────────────────────────────┤
│                                              │
│                                              │
│   ┌────────┐                                 │
│   │ ШТАБ   │                                 │
│   │  ур.1  │                                 │ ~500
│   └────────┘                                 │
│                                              │
│   ┌────────┐                                 │
│   │   +    │                                 │
│   │построить│                                │
│   └────────┘                                 │
│                                              │
├──────────────────────────────────────────────┤
│ ⏱ Очередь пуста                          ›  │ 44
├──────────────────────────────────────────────┤
│ Влияние 3 / 400 — второе поселение           │ 28
│ ░░░░░░░░░░░░░░░░░░░░░░░░░                    │
├──────────────────────────────────────────────┤
│ → Еда в минусе — постройте Теплицу        ›  │ 32  ← the instruction
├──────────────────────────────────────────────┤
│ [            ПОСТРОЙКИ                    ] │ 48
├──────────────────────────────────────────────┤
│   БАЗА     КАРТА     ВОЙСКА    ОТЧЁТЫ       │ 58
└──────────────────────────────────────────────┘
```

- The Food tile carries `▼`. The `→` line names the cause **and** the fix, and is tappable
  straight to the Greenhouse row in W08.
- The `+` plot is the only affordance on the ground besides the Command Center.
- Tapping either the `→` line or `[ ПОСТРОЙКИ ]` lands on W08 with `Теплица` first and
  `▸ Ещё 11 — недоступны` collapsed. **The player never sees eleven rejections unless they
  ask for them.**

---

## 6. W05 — Building detail (sheet)

**Opened by:** tapping a built plot. **Type:** bottom sheet over Base, nav still visible.

```
        ← Base visible + dimmed above ─────────
┌──────────────────────────────────────────────┐
│  ──                                       ✕  │  drag handle
│  ТЕПЛИЦА                              ур. 5  │
│  Производит еду                              │
├──────────────────────────────────────────────┤
│  Производство      сейчас 120/ч → 148/ч      │
│  Содержание        сейчас  12/ч →  14/ч      │
├──────────────────────────────────────────────┤
│  СЛЕДУЮЩИЙ УРОВЕНЬ                      6    │
│  ЛОМ 340   ТОП 120   ЭЛК 0   ЕДА 180         │
│  Время постройки              00:12:40       │
├──────────────────────────────────────────────┤
│ [            УЛУЧШИТЬ                     ] │ PRIMARY
└──────────────────────────────────────────────┘
```

### 6.1 Specification

| Aspect | Value |
|---|---|
| **Persistent** | top bar + nav remain visible and tappable |
| **Main content** | current level, what it does *in numbers*, next-level cost + time |
| **Primary CTA** | `[ УЛУЧШИТЬ ]` (or `[ ПОСТРОИТЬ ]` at level 0) |
| **Secondary** | `✕`, drag-down, back |
| **Disabled state** | see §6.3 — reason always immediately below the button |
| **Transition** | commit → W07 (committed state, same sheet) |

**Production buildings show current → next output.** Without it an upgrade decision requires
the player to do arithmetic the client already does. This applies to all four resource
buildings, Warehouse/Cold Storage (cap), Command Center (build speed) and Wall (defence, M3).

### 6.2 Sizing

Sheet height ≈ 360 px — comfortably inside the 435 px default and well clear of the nav.

### 6.3 W06 — blocked variants

Every blocked state names the blocker **and** the fix. A greyed button with no sentence is
treated as a bug.

```
 a) prerequisites               b) not yet affordable
├──────────────────────────┤   ├──────────────────────────┤
│ [    ПОСТРОИТЬ    ]✗     │   │ [    УЛУЧШИТЬ     ]✗     │
│ Нужен Штаб ур.3          │   │ Доступно через 04:12     │
│  › Штаб  ур.1 → 3        │   │ Не хватает: ЛОМ 120      │
└──────────────────────────┘   └──────────────────────────┘

 c) Food gate                   d) queue full
├──────────────────────────┤   ├──────────────────────────┤
│ [    УЛУЧШИТЬ     ]✗     │   │ [    УЛУЧШИТЬ     ]✗     │
│ Еда уйдёт в минус        │   │ Очередь заполнена  3/3   │
│  › Улучшите Теплицу      │   │  › Открыть очередь       │
└──────────────────────────┘   └──────────────────────────┘

 e) storage too small           f) max level          g) already queued
├──────────────────────────┤   ├──────────────────┤  ├──────────────────┤
│ [    УЛУЧШИТЬ     ]✗     │   │ Максимальный     │  │ Уже в очереди    │
│ Не хватит вместимости    │   │ уровень 20       │  │  › Открыть оче…  │
│  › Улучшите Склад        │   │ (кнопки нет)     │  │ (кнопки нет)     │
└──────────────────────────┘   └──────────────────┘  └──────────────────┘
```

Each `›` line is a **link that navigates to the fix** — to the blocking building's sheet, to
the queue, to the Greenhouse. This is what turns a rejection into a next step. Order of
checks mirrors `computeBuildEligibility` exactly, so the client never blocks for a different
reason than the server would.

---

## 7. W07 — Building upgrade, after commit

**Not a new screen** — the same sheet, changed. The player must see the result without
navigating anywhere to verify it.

```
before                              after [ УЛУЧШИТЬ ]
├──────────────────────────┤        ├──────────────────────────┤
│ СЛЕДУЮЩИЙ УРОВЕНЬ    6   │        │ ✓ Поставлено в очередь   │
│ ЛОМ 340 ТОП 120 ЕДА 180  │   →    │ ТЕПЛИЦА ур.6             │
│ Время          00:12:40  │        │ Начнётся после «Штаб 5»  │
├──────────────────────────┤        │ ⏱ 01:37:00               │
│ [      УЛУЧШИТЬ       ]  │        ├──────────────────────────┤
└──────────────────────────┘        │ (Отменить)   [ ЗАКРЫТЬ ] │
                                    └──────────────────────────┘
```

**What changes elsewhere, immediately** (the server returns the full `SettlementStateView`,
so all of this is one render, not four refetches):

1. top bar resource values drop by the cost — deduction is at enqueue;
2. the plot on the ground gains its `ур.5→6 / в очереди` form;
3. the queue strip becomes `2/3`;
4. the `→` line recomputes.

**Transition:** `[ ЗАКРЫТЬ ]` → W02. `(Отменить)` → 100% refund, sheet returns to the
pre-commit form. No confirmation on cancel — the refund is total, so there is nothing to
protect against.

---

## 8. W08 — ПОСТРОЙКИ list (sheet)

**Decision §29.1: one list, not two.** Upgrades and new builds live together, buildable
first, blocked collapsed. Opened from `[ ПОСТРОЙКИ ]`, from a `+` plot, or from a `→` line.

```
┌──────────────────────────────────────────────┐
│  ──                                       ✕  │
│  ПОСТРОЙКИ                             3/3  │  ← queue capacity
├──────────────────────────────────────────────┤
│  ДОСТУПНО                                    │
│  ┌────────────────────────────────────────┐  │
│  │ ТЕПЛИЦА                       ур.5 → 6 │  │
│  │ ЛОМ340 ТОП120 ЭЛК0 ЕДА180 · 00:12:40   │  │
│  │ Еда 120/ч → 148/ч        [ ПОСТРОИТЬ ] │  │
│  └────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────┐  │
│  │ СКЛАД                          — → 1   │  │
│  │ ЛОМ90 ТОП30 ЭЛК0 ЕДА40 · 00:08:10      │  │
│  │ Вместимость 800          [ ПОСТРОИТЬ ] │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  СКОРО                                       │
│  ┌────────────────────────────────────────┐  │
│  │ МЕТАЛЛОЛОМ                    ур.3 → 4 │  │
│  │ Доступно через 04:12  · не хватает ЛОМ │  │
│  └────────────────────────────────────────┘  │
├──────────────────────────────────────────────┤
│  ▸ Ещё 8 — недоступны                        │
└──────────────────────────────────────────────┘
```

### 8.1 Ordering rule — the single most important rule on this surface

1. **ДОСТУПНО** — can be started right now, cheapest-first.
2. **СКОРО** — blocked only by resources, with a countdown (`msUntilAffordable`).
3. **▸ Ещё N — недоступны** — collapsed. Expanding reveals prerequisites, max level,
   storage and Food-gate blocks, each with its `›` fix link.

This ordering is what makes W03 (day one) read as an instruction. It is not cosmetic.

### 8.2 Specification

| Aspect | Value |
|---|---|
| **Type** | sheet, expandable to ~650 px, scrolls internally |
| **Primary CTA** | `[ ПОСТРОИТЬ ]` per row (the sheet itself has no single CTA) |
| **Secondary** | row tap → W05 (that building's detail); `▸` expand |
| **Disabled** | rows in СКОРО / недоступны carry no button, only a reason and a fix link |
| **Empty state** | impossible (13 types always exist); if the list renders empty it is an error state, not an empty one |
| **Transition** | `[ ПОСТРОИТЬ ]` → row collapses into a `✓ в очереди` state in place; the sheet stays open so the player can queue a second item |

**Queue capacity is in the sheet header** (`3/3`). When full, every `[ ПОСТРОИТЬ ]` is
replaced by `Очередь заполнена › Открыть очередь` — one message, not thirteen.

---

## 9. W09 — Build queue, expanded (sheet)

```
┌──────────────────────────────────────────────┐
│  ──                                       ✕  │
│  ОЧЕРЕДЬ ПОСТРОЕК                       2/3  │
├──────────────────────────────────────────────┤
│  1  ШТАБ ур.5                    В РАБОТЕ    │
│     ⏱ 01:24:15                               │
│     ▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░  38%           │
│                                (Отменить)    │
├──────────────────────────────────────────────┤
│  2  ТЕПЛИЦА ур.6                 ОЖИДАНИЕ    │
│     Начнётся ≈ 15:41 · займёт 00:12:40       │
│                                (Отменить)    │
├──────────────────────────────────────────────┤
│  3  —  свободный слот                        │
└──────────────────────────────────────────────┘
```

| Aspect | Value |
|---|---|
| **Primary CTA** | none — this surface is for cancelling, not committing |
| **Secondary** | `(Отменить)` per row — refunds 100%, no confirmation |
| **Engineers** | two rows can read `В РАБОТЕ` simultaneously (parallel slot); the header reads `2 активных` |
| **Empty state** | `Очередь пуста. Заложите постройку.` + `[ ПОСТРОЙКИ ]` |
| **Time format** | remaining is primary; wall-clock start (`≈ 15:41`) secondary for waiting items — a player planning a session needs the clock, not the delta |
| **Transition** | active item hits 0 → refetch (bounded retry, already shipped) → row disappears, plot level increments, toast |

---

## 10. W10 — Resource detail (sheet)

Opened by tapping any resource in the top bar. Shows all four — tapping one resource to see
only that one would force four taps to answer "am I fine?".

```
┌──────────────────────────────────────────────┐
│  ──                                       ✕  │
│  РЕСУРСЫ                                     │
├──────────────────────────────────────────────┤
│  ЛОМ            24 731 / 32 000              │
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░  +420/ч             │
│  Заполнится через 17:18                      │
├──────────────────────────────────────────────┤
│  ТОПЛИВО        18 300 / 32 000              │
│  ▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░  +310/ч             │
│  Заполнится через 44:11                      │
├──────────────────────────────────────────────┤
│  ЭЛЕКТРОНИКА    32 000 / 32 000       ПОЛНО  │
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  +90/ч              │
│  Производство остановлено                    │
├──────────────────────────────────────────────┤
│  ЕДА              620 / 8 000            ▼   │
│  ▓▓░░░░░░░░░░░░░░░░░░░░░  −12/ч              │
│  Производство      +148/ч                    │
│  Здания           −132/ч                     │
│  Войска            −28/ч                     │
│  Опустеет через 51:40                        │
└──────────────────────────────────────────────┘
```

- **Exact values here**, always — this is the surface for planning.
- **Food gets a breakdown**, because the net number is the one that blocks builds and
  training and the player must be able to see *which side* to fix.
- **`ПОЛНО` states the consequence** («производство остановлено»), not just the condition.

---

## 11. W11 — Round timeline (sheet)

```
┌──────────────────────────────────────────────┐
│  ──                                       ✕  │
│  РАУНД 1                    ДЕНЬ 5 ИЗ 21     │
├──────────────────────────────────────────────┤
│  ▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░  осталось 16 дн.  │
├──────────────────────────────────────────────┤
│  ✓ АКТ I — Выживание            дни 1–7      │
│    Развитие, разведка, первые рейды          │
│                                              │
│    АКТ II — Эскалация           дни 8–14     │
│    Через 2 дня                               │
│                                              │
│    АКТ III — Источник           дни 15–21    │
├──────────────────────────────────────────────┤
│  Мир стирается в конце раунда                │
└──────────────────────────────────────────────┘
```

**Data dependency:** needs `world.startedAt` in `MapWorldView` (UX §18.1 — still not
exposed). Until it is, the chip cannot render and must be hidden rather than faked.

---

## 12. W12 — Map, grid view

**The screen answers:** *who and what is around me, and what can I reach?*

```
┌──────────────────────────────────────────────┐
│ ЛОМ24.7k ТОП18.3k ЭЛК10.6k ЕДА620  Д5·А1  ⚙ │ 56
│ ▓▓▓▓▓▓░░ ▓▓▓▓░░░░ ▓▓▓▓▓▓▓▓ ▓▓░░             │
├──────────────────────────────────────────────┤
│ ‹КАРТА›  СПИСОК                    5:−24    │ 36
├──────────────────────────────────────────────┤
│ · · · · · · · · · · · ·                      │
│ · · · ▲ · · · · · · · ·   ▲ поселение        │
│ · · · · · · · ◆ · · · ·   ◆ оазис            │
│ · · · · · · · · · · · ·   ⊙ моё поселение    │
│ · · ⊙ · · · · · · · · ·   ⇢ моя разведка     │ ~600
│ · · · · ⇢ · · · · · · ·                      │
│ · · · · · · · ▲ · · · ·                      │
│ · · · · · · · · · · · ·                      │
│ · · · ▲ · · · · · ▲ · ·                      │
│ · · · · · · · · · · · ·                      │
├──────────────────────────────────────────────┤
│ (⌖ к себе) (⊞ 1×) (# коорд.)                │ 48
├──────────────────────────────────────────────┤
│   БАЗА     КАРТА     ВОЙСКА    ОТЧЁТЫ●3     │ 58
└──────────────────────────────────────────────┘
```

### 12.1 Specification

| Aspect | Value |
|---|---|
| **Persistent** | top bar, nav |
| **Main content** | pan/zoom tile grid; ~12 × 18 tiles visible at 1× |
| **Primary CTA** | none — the map is a selection surface; the CTA lives in the tile sheet |
| **Secondary** | `⌖` recentre, `⊞` zoom step, `#` jump-to-coordinates, `‹КАРТА›/СПИСОК` toggle |
| **Selection** | tapped tile gets an outline and opens W14; selection survives tab switches |
| **Disabled** | none |
| **State kept** | pan offset, zoom step and selected tile persist across tab switches (UX §5.3) |

### 12.2 What renders at each zoom

| Zoom | Terrain | Settlements | Names | Oases | Own |
|---|---|---|---|---|---|
| 0.5× | flat tint per terrain | dot | no | dot | ring |
| 1× (default) | tile | marker | no | marker | ring |
| 2× | tile | marker | yes, truncated | marker | ring |

**Own settlement carries its ring at every zoom** — "where am I" must never require reading
a name. **Tap tolerance is 44 px** even though a tile is 32 px at 1×; selection is confirmed
by the sheet opening, not by a hairline highlight (UX §11.1).

### 12.3 The wireframe test, applied

With all art removed the map is a grid of `·` with `▲ ◆ ⊙ ⇢` glyphs and a legend. That is
still playable: the player can see density, find their own settlement, and tell a settlement
from an oasis. **Terrain carries no meaning in v1** (cosmetic except that lakes can't be
settled, which is not a v1 player action) — so losing terrain art loses no information. This
is the justification for terrain being art-only.

---

## 13. W13 — Map, «СПИСОК» view

Same tab, same chrome, different body. Sorted by Chebyshev distance from the player's
settlement.

```
├──────────────────────────────────────────────┤
│  КАРТА  ‹СПИСОК›                    5:−24    │ 36
├──────────────────────────────────────────────┤
│  Форпост «Рваный Флаг»                       │
│  Коршун · Рейдеры · Маяк                     │
│  4 тайла · разведка 00:18      разведано 14ч │
├──────────────────────────────────────────────┤
│  Мастерская «Седьмой Цех»                    │
│  Гайка · Инженеры · Тишина                   │
│  6 тайлов · разведка 00:27                   │
├──────────────────────────────────────────────┤
│  Стоянка «Сухой Брод»                        │
│  Талый · Кочевники · —                       │
│  9 тайлов · разведка 00:40                   │
├──────────────────────────────────────────────┤
│  ···                                         │
└──────────────────────────────────────────────┘
```

| Aspect | Value |
|---|---|
| **Rows** | every settlement except the player's own, distance-sorted, virtualised (~150) |
| **Row content** | name, owner, faction, side, distance, **scout travel time** (`travelTimeMs` — the same formula the send preview uses), and intel age when the player has scouted it |
| **Oases** | excluded in M2 — they cannot be scouted or raided yet, so a row would offer nothing |
| **Primary CTA** | none — tapping a row is the action |
| **Transition** | tap row → switch to `КАРТА`, centre on the tile, open W14 |
| **Empty state** | impossible (135 NPCs); an empty list is an error state |

**Travel time is per-row and depends on the player's slowest scout**, so the column is
honest about what *this player* can do, not about abstract distance.

---

## 14. W14 — Tile sheet, four variants

Opened by tapping a tile (grid) or a row (list). Nav stays visible; the selected tile stays
visible above the sheet.

### 14.1 Other settlement — never scouted

```
┌──────────────────────────────────────────────┐
│  ──                                       ✕  │
│  Форпост «Рваный Флаг»               12:−21  │
│  Коршун · Рейдеры · Маяк                     │
│  4 тайла · разведка 00:18                    │
├──────────────────────────────────────────────┤
│  Разведданных нет                            │
├──────────────────────────────────────────────┤
│ [            РАЗВЕДАТЬ                    ] │ PRIMARY
└──────────────────────────────────────────────┘
```

### 14.2 Other settlement — with remembered intel

```
┌──────────────────────────────────────────────┐
│  ──                                       ✕  │
│  Форпост «Рваный Флаг»               12:−21  │
│  Коршун · Рейдеры · Маяк                     │
│  4 тайла · разведка 00:18                    │
├──────────────────────────────────────────────┤
│  РАЗВЕДАНО 14 Ч НАЗАД                        │
│  ЛОМ ~1 200   ТОП ~340   ЭЛК ~80   ЕДА ~610  │
│  Войска дома          2 разведчика           │
│  Постройки            нет данных             │
│                                (Отчёт ›)     │
├──────────────────────────────────────────────┤
│ [         РАЗВЕДАТЬ СНОВА                 ] │ PRIMARY
└──────────────────────────────────────────────┘
```

- Intel is **visually separated** from the public card by a divider and a header stating its
  age — it is never merged into the live data.
- `Постройки — нет данных` states *why* something is missing (base-tier report), turning an
  absence into a lesson about the Radio Tower.
- Older intel is de-emphasised as it ages. It **never** enables or disables an action.

### 14.3 Own settlement / oasis / empty tile

```
 own settlement                     oasis
┌──────────────────────────┐      ┌──────────────────────────┐
│ Лагерь «Грань»    5:−24  │      │ Ферма-оазис      8:−19   │
│ Ваше поселение           │      │ Заброшенная ферма        │
│ ⏱ ШТАБ ур.5   01:24:15   │      │ Разведка недоступна      │
├──────────────────────────┤      │ Рейды — позже            │
│ [   ПЕРЕЙТИ В БАЗУ    ]  │      │        (нет действий)    │
└──────────────────────────┘      └──────────────────────────┘

 empty tile                        blocked: no scouts
┌──────────────────────────┐      ┌──────────────────────────┐
│ Пустошь          7:−22   │      │ Форпост «Рваный Флаг»    │
│ Свободный тайл           │      │ 4 тайла · разведка 00:18 │
│ Основание — позже        │      ├──────────────────────────┤
│        (нет действий)    │      │ [   РАЗВЕДАТЬ    ]✗      │
└──────────────────────────┘      │ Нет разведчиков дома     │
                                  │  › Обучить в Бараках     │
                                  └──────────────────────────┘
```

**«Разведка недоступна» and «Основание — позже» are deliberate.** A tile that simply offers
nothing, with no sentence, reads as a broken screen. Stating the rule teaches the game's
shape; the `›` link on the blocked variant navigates to the fix.

---

## 15. W15 — Send scout, form

**The same sheet, expanded in place.** The map stays visible above it. This is one surface
in three states: info (W14) → form (W15) → status (W17).

```
┌──────────────────────────────────────────────┐
│  ──                                       ✕  │
│  РАЗВЕДКА → «Рваный Флаг»            12:−21  │
├──────────────────────────────────────────────┤
│  ДОЗОРНЫЙ                        дома 3      │
│         ( − )      2      ( + )       [все]  │
├──────────────────────────────────────────────┤
│  Расстояние                     4 тайла      │
│  В пути                         00:18:00     │
│  На месте                          14:32     │
│  Возврат                           14:50     │
├──────────────────────────────────────────────┤
│  Отозвать можно 90 секунд после отправки     │
├──────────────────────────────────────────────┤
│ (Отмена)     [        ОТПРАВИТЬ           ] │ PRIMARY
└──────────────────────────────────────────────┘
```

| Aspect | Value |
|---|---|
| **Count picker** | bounded by `troops` at home; `[все]` shortcut; long-press repeats |
| **Live consequences** | travel time, arrival wall-clock and return wall-clock update with the count (slowest unit decides — relevant from M3) |
| **Primary CTA** | `[ ОТПРАВИТЬ ]` — commits immediately |
| **Secondary** | `(Отмена)` collapses back to W14; `✕`/back/drag dismiss |
| **Disabled** | count 0 → `[ ОТПРАВИТЬ ]✗` + `Выберите хотя бы одного разведчика` |
| **The recall line is shown *before* sending** — the player must know the undo exists at the moment they are deciding, not after |

**Arrival is shown as a wall-clock, not only a duration.** «На месте 14:32» is the number a
player schedules their day around; «через 18 минут» is not.

---

## 16. W16 — Send confirmation: deliberately absent

**There is no confirmation dialog, at any point in M1 or M2.** Recorded here as a wireframe
so its absence is a decision, not an oversight.

```
   NOT BUILT
┌──────────────────────────┐
│  Отправить 2 разведчика? │      ← rejected (UX §8)
│  Они могут погибнуть.    │
│  (Отмена)   [ ДА ]       │
└──────────────────────────┘
```

**What replaces it:** the commit itself is explicit (`[ ОТПРАВИТЬ ]` on a form that states
cost in scouts, travel time and arrival), and the reversal is real — 90 seconds of recall,
surfaced twice (W17 and W20). A per-send modal is dismissed blind within a day and protects
nobody.

Confirmations are reserved for genuinely irreversible acts, which arrive in M3 (committing an
army to a battle) and M5 (switching sides — zeroes contribution). Both are out of scope here.

---

## 17. W17 — Send scout, status + recall

**Same sheet, third state.** Persists until dismissed or until the 90 s window closes
(decision §29.4).

```
┌──────────────────────────────────────────────┐
│  ──                                       ✕  │
│  ✓ ОТПРАВЛЕНО → «Рваный Флаг»                │
├──────────────────────────────────────────────┤
│  2 разведчика в пути                         │
│  Прибытие              14:32   ⏱ 00:17:42    │
│  ▓▓░░░░░░░░░░░░░░░░░░░░░░░░                  │
├──────────────────────────────────────────────┤
│ ( ОТОЗВАТЬ  0:74 )          [   ЗАКРЫТЬ   ] │
└──────────────────────────────────────────────┘
```

**Simultaneously, elsewhere:**

1. a `⇢` marker appears on the map, interpolated between origin and target;
2. `ВОЙСКА` gains a `В ПУТИ` row with the same two countdowns and the same recall button;
3. home scout count drops (`дома 3` → `дома 1`).

| Trigger | Result |
|---|---|
| `( ОТОЗВАТЬ )` within 90 s | movement flips to `returning`; sheet becomes «Возвращается ⏱ 00:02:18»; map marker reverses |
| 90 s elapse | the recall button disappears from the sheet and from ВОЙСКА; the arrival countdown continues |
| `[ ЗАКРЫТЬ ]` | sheet dismisses; the movement lives on in ВОЙСКА and on the map |
| tab switch | sheet dismisses; recall remains one tap away in ВОЙСКА |

**Rejected:** a global 90-second recall strip above the nav — a fourth piece of persistent
chrome that exists for 90 seconds, and it would collide with the strip M3 needs for incoming
attacks.

---

## 18. W18 — Movement in transit

There is no dedicated screen. In-flight movement is visible in exactly two places, with no
duplication of role:

```
 MAP — spatial                     ВОЙСКА — canonical
┌──────────────────────────┐      ┌──────────────────────────┐
│ · · · · · · · · · ·      │      │ В ПУТИ                   │
│ · · ⊙ ⇢ · · ▲ · ·        │      │ → «Рваный Флаг»          │
│ · · · · · · · · · ·      │      │   2 разведчика           │
│                          │      │   ⏱ 00:17:42  на 14:32   │
│ tap ⇢ → ВОЙСКА           │      │   ( ОТОЗВАТЬ 0:74 )      │
└──────────────────────────┘      └──────────────────────────┘
```

- The map shows **where**; ВОЙСКА shows **what, when and undo**. Neither repeats the other.
- Only the player's own movements are ever drawn. Nobody can query anyone else's in M2, and
  incoming visibility is M3 by design.
- Marker position is computed client-side from `departAt` / `arriveAt` against `serverTime`.

---

## 19. W19 — Arrival (composite)

Arrival is not a screen — it is a coordinated change across four surfaces. Wireframed
together because getting one of them wrong makes the loop feel broken.

```
  t = arrival
  ┌────────────────────────────────────────────┐
  │ TOAST:  Пришёл отчёт разведки          ›   │  ← tappable → W24
  └────────────────────────────────────────────┘

  MAP            ⇢ marker reverses direction (returning)
  ВОЙСКА         В ПУТИ row → «← возвращается ⏱ 00:18:00»
                 recall button gone
  ОТЧЁТЫ         badge ●3 → ●4
  БАЗА           unchanged

  t = return
  ВОЙСКА         ДОМА: Дозорный ×1 → ×3 ; В ПУТИ empty
  TOAST          Разведчики вернулись                ›
  TOP BAR        ЕДА rate drops again (upkeep resumes for survivors)
```

**Failure variant (all scouts died):** no return leg. The map marker disappears at the
target, `В ПУТИ` empties, `ДОМА` stays at 0, and the toast reads «Разведка провалена». The
report still arrives — a deliberate deviation from Travian, because silence reads as a bug.

**Toast rules:** one at a time, ~4 s, tappable, never covering the primary CTA, and never
used for an error the player's own tap caused (those are inline).

---

## 20. W20 — Войска, populated

**The screen answers:** *what do I have, what is coming, what is out?*

```
┌──────────────────────────────────────────────┐
│ ЛОМ24.7k ТОП18.3k ЭЛК10.6k ЕДА620  Д5·А1  ⚙ │ 56
│ ▓▓▓▓▓▓░░ ▓▓▓▓░░░░ ▓▓▓▓▓▓▓▓ ▓▓░░             │
├──────────────────────────────────────────────┤
│  ДОМА                                        │
│  ДОЗОРНЫЙ                              × 3   │
│  Содержание                          −3 ед/ч │
├──────────────────────────────────────────────┤
│  ТРЕНИРОВКА                        Бараки ›  │
│  ДОЗОРНЫЙ            осталось 2 из 3         │
│  Следующий через            ⏱ 00:04:00       │
│  ▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░                       │
│                                (Отменить)    │
├──────────────────────────────────────────────┤
│  В ПУТИ                                      │
│  → «Рваный Флаг»          2 разведчика       │
│    ⏱ 00:17:42 · на месте 14:32               │
│                          ( ОТОЗВАТЬ 0:74 )   │
│                                              │
│  ← возвращается домой     1 разведчик        │
│    ⏱ 00:03:12                                │
├──────────────────────────────────────────────┤
│   БАЗА     КАРТА     ВОЙСКА    ОТЧЁТЫ●3     │ 58
└──────────────────────────────────────────────┘
```

| Aspect | Value |
|---|---|
| **Sections** | fixed order: ДОМА → ТРЕНИРОВКА → В ПУТИ (have → coming → out) |
| **Primary CTA** | none — this is a status screen; the action lives at the Barracks |
| **Secondary** | `Бараки ›` → W22; `(Отменить)` training; `( ОТОЗВАТЬ )` movement |
| **Training row** | driven by `trainingQueue`: `remainingCount` of `totalCount`, `nextCompletesAt` for the countdown — units are credited one at a time via chained events, so this ticks unit by unit |
| **Upkeep** | shown in ДОМА, because it is the cost the player forgets |
| **Transition** | tap `В ПУТИ` row → Map centred on target |

### 20.3 W21 — Войска, empty (the M2 opening state)

Three empty sections stacked would read as three failures. **One combined empty state.**

```
├──────────────────────────────────────────────┤
│                                              │
│  ВОЙСК НЕТ                                   │
│                                              │
│  Разведчиков обучают в Бараках.              │
│  Бараки открываются на Штабе ур.3.           │
│                                              │
│  Без разведчика дома вы не узнаете,          │
│  что вас разведали.                          │
│                                              │
│  [        ПЕРЕЙТИ В БАЗУ                  ] │
│                                              │
└──────────────────────────────────────────────┘
```

The detection rule appears here because this is the screen where its consequence lives.
When the player has troops but all are away, the same line appears under `ДОМА: 0`.

---

## 21. W22 — Training picker (Barracks sheet)

Opened from the Barracks plot on Base, or from `Бараки ›` in ВОЙСКА. Training is a **section
of the building sheet**, below the upgrade block — the building both levels up and produces.

```
┌──────────────────────────────────────────────┐
│  ──                                       ✕  │
│  БАРАКИ                               ур. 1  │
├──────────────────────────────────────────────┤
│  СЛЕДУЮЩИЙ УРОВЕНЬ                      2    │
│  ЛОМ 210 ТОП 70 ЭЛК 0 ЕДА 90 · 00:09:20      │
│                              [ УЛУЧШИТЬ ]    │
├──────────────────────────────────────────────┤
│  ОБУЧЕНИЕ                                    │
│  ДОЗОРНЫЙ         скорость 9 · развед. 35/20 │
│         ( − )      2      ( + )              │
│                                              │
│  Стоимость   ЛОМ240 ТОП80 ЭЛК40 ЕДА60        │
│  Время               00:08:00 (2 × 00:04:00) │
│  Еда после найма        −12/ч  →  −14/ч      │
├──────────────────────────────────────────────┤
│ [            ОБУЧИТЬ                      ] │ PRIMARY
└──────────────────────────────────────────────┘
```

| Aspect | Value |
|---|---|
| **Three live consequences** | batch cost, batch time (with per-unit breakdown), and **net Food after the batch** — the gate is absolute and includes the whole batch (`wouldStarveWithTroops`) |
| **Disabled variants** | `Еда уйдёт в минус › Улучшите Теплицу` · `Не хватает: ЭЛК 40` · `Нужен Штаб ур.3` (when Barracks absent) |
| **Two CTAs on one sheet** | `[ УЛУЧШИТЬ ]` is scoped inside the level block; `[ ОБУЧИТЬ ]` is the sheet's primary. They are visually and spatially separated, never adjacent |
| **Transition** | commit → row appears in ВОЙСКА ТРЕНИРОВКА; sheet shows `✓ Поставлено в очередь` and stays open |

**Unit stats are shown before the purchase** (speed, scout attack/defence). A player choosing
how many scouts to buy is choosing how much intel-per-hour to own; hiding the stats makes
that decision blind.

---

## 22. W23 — Отчёты, list

```
┌──────────────────────────────────────────────┐
│ ЛОМ24.7k ТОП18.3k ЭЛК10.6k ЕДА620  Д5·А1  ⚙ │ 56
│ ▓▓▓▓▓▓░░ ▓▓▓▓░░░░ ▓▓▓▓▓▓▓▓ ▓▓░░             │
├──────────────────────────────────────────────┤
│  ОТЧЁТЫ                              3 новых │ 36
├──────────────────────────────────────────────┤
│  ● РАЗВЕДКА   «Рваный Флаг»          14:32 ›│
│    Успешно · потери 1                        │
├──────────────────────────────────────────────┤
│  ● ВАС РАЗВЕДАЛИ   «Седьмой Цех»     11:04 ›│
│    Гайка                                     │
├──────────────────────────────────────────────┤
│  ● РАЗВЕДКА   «Сухой Брод»           09:41 ›│
│    Провалено · разведчики не вернулись       │
├──────────────────────────────────────────────┤
│    РАЗВЕДКА   «Рваный Флаг»       вчера 21:0 │
│    Успешно · без потерь                      │
├──────────────────────────────────────────────┤
│  ···                                         │
├──────────────────────────────────────────────┤
│   БАЗА     КАРТА     ВОЙСКА    ОТЧЁТЫ●3     │ 58
└──────────────────────────────────────────────┘
```

| Aspect | Value |
|---|---|
| **Row** | type + subject + time; second line states the **outcome in words**, so the list is scannable without opening anything |
| **Unread** | `●` marker + emphasis; read-on-open; badge clears as they are read |
| **Order** | newest first, cursor-paginated |
| **Primary CTA** | none — a row tap is the action |
| **Time** | wall-clock for today, `вчера HH:MM`, then a date |
| **M3** | gains a type segment when raid/assault/trade reports multiply — designed for, not built |

---

## 23. W24 — Отчёты, detail (4 variants)

Full screen, not a sheet: a buildings-tier report carries 13 rows and would fight a sheet's
height limit. **Reports are frozen snapshots** — no countdowns, no live values, always
stamped with capture time.

### 23.1 Scout success — base tier

```
┌──────────────────────────────────────────────┐
│ ‹ Отчёты                          14:32     │
├──────────────────────────────────────────────┤
│  РАЗВЕДКА УСПЕШНА                            │
│  Форпост «Рваный Флаг» · Коршун      12:−21  │
├──────────────────────────────────────────────┤
│  ВАШИ ПОТЕРИ                                 │
│  Дозорный          отправлено 2 · погиб 1    │
├──────────────────────────────────────────────┤
│  РЕСУРСЫ ЦЕЛИ                                │
│  ЛОМ  1 204 / 4 000                          │
│  ТОП    340 / 4 000                          │
│  ЭЛК     80 / 4 000                          │
│  ЕДА    610 / 2 000                          │
├──────────────────────────────────────────────┤
│  ВОЙСКА ДОМА                                 │
│  Дозорный                              × 2   │
├──────────────────────────────────────────────┤
│  ПОСТРОЙКИ                     нет данных    │
│  Нужна Радиовышка выше, чем у цели           │
├──────────────────────────────────────────────┤
│ (Разведать снова)        [   НА КАРТУ    ]  │
└──────────────────────────────────────────────┘
```

### 23.2 Scout success — buildings tier

Identical, with the `ПОСТРОЙКИ` block replaced by the real list:

```
├──────────────────────────────────────────────┤
│  ПОСТРОЙКИ                                   │
│  Штаб 6 · Металлолом 7 · НПЗ 5 · Теплица 8   │
│  Склад 4 · Холодильник 3 · Бараки 3 · ···    │
└──────────────────────────────────────────────┘
```

### 23.3 Scout failed / 23.4 Counter-report

```
 FAILED                             DETECTED (you were scouted)
┌──────────────────────────┐      ┌──────────────────────────┐
│ ‹ Отчёты        09:41    │      │ ‹ Отчёты        11:04    │
├──────────────────────────┤      ├──────────────────────────┤
│ РАЗВЕДКА ПРОВАЛЕНА       │      │ ВАС РАЗВЕДАЛИ            │
│ «Сухой Брод»    −3:−28   │      │ «Седьмой Цех» · Гайка    │
├──────────────────────────┤      │                  4:−17   │
│ ВАШИ ПОТЕРИ              │      ├──────────────────────────┤
│ Дозорный  отправлено 2   │      │ Ваш разведчик заметил    │
│           погибли оба    │      │ чужую разведку.          │
├──────────────────────────┤      │ Что они узнали —         │
│ Разведданных нет.        │      │ неизвестно.              │
│ Никто не вернулся.       │      ├──────────────────────────┤
├──────────────────────────┤      │ (Разведать в ответ)      │
│ (Обучить ещё)  [НА КАРТУ]│      │        [   НА КАРТУ   ]  │
└──────────────────────────┘      └──────────────────────────┘
```

**Every report ends with a destination.** `[ НА КАРТУ ]` opens the Map centred on the
subject with its tile sheet open — the loop closes without the player copying coordinates.
A report that cannot be acted on is a dead end.

**Server contract:** the server ships ids, numbers and keys; the client renders every word
above. This requires the report payload to carry the subject settlement id **and**
coordinates (§31.3).

---

## 24. W25 — Settings (sheet)

```
┌──────────────────────────────────────────────┐
│  ──                                       ✕  │
│  НАСТРОЙКИ                                   │
├──────────────────────────────────────────────┤
│  Позывной                          Коршун    │
│  Фракция                          Рейдеры    │
│  Сторона                              Маяк   │
├──────────────────────────────────────────────┤
│  Язык                        ‹ РУС › ENG     │
├──────────────────────────────────────────────┤
│  Версия ядра                        0.5.0    │
│  Связь с сервером                  Онлайн    │
├──────────────────────────────────────────────┤
│                              ( Выйти )       │
└──────────────────────────────────────────────┘
```

The connection state moves **here** from M1's `ConnectionBadge` in the app header. A
permanent "Онлайн" badge above every screen spends persistent chrome on information that only
matters when it is *not* fine — and when it is not fine, the offline banner (§27.1) says so.
This is a required amendment to the shipped shell (§30.4).

---

## 25. W26 — Loading states

**Rule: skeleton of the real layout, never a spinner on empty space.** A refetch never blanks
a screen that already had content.

```
 BASE (cold)                        MAP (cold)              ОТЧЁТЫ (cold)
┌──────────────────────────┐      ┌──────────────┐        ┌──────────────┐
│ ⌷⌷⌷⌷ ⌷⌷⌷⌷ ⌷⌷⌷⌷ ⌷⌷⌷⌷      │      │ ⌷⌷⌷⌷⌷⌷⌷⌷⌷⌷  │        │ ⌷⌷⌷⌷⌷⌷⌷ ⌷⌷⌷ │
│ ⌷⌷⌷⌷⌷⌷⌷⌷ ⌷⌷⌷⌷⌷⌷          │      │ ⌷⌷⌷⌷⌷⌷⌷⌷⌷⌷  │        │ ⌷⌷⌷⌷⌷        │
├──────────────────────────┤      │ ⌷⌷⌷⌷⌷⌷⌷⌷⌷⌷  │        ├──────────────┤
│ ⌷⌷⌷⌷⌷⌷⌷⌷⌷⌷        ⌷⌷⌷⌷  │      │ ⌷⌷⌷⌷⌷⌷⌷⌷⌷⌷  │        │ ⌷⌷⌷⌷⌷⌷⌷ ⌷⌷⌷ │
├──────────────────────────┤      │              │        │ ⌷⌷⌷⌷⌷        │
│ ┌────┐ ┌────┐ ┌────┐     │      │ (сетка       │        ├──────────────┤
│ │ ⌷⌷ │ │ ⌷⌷ │ │ ⌷⌷ │     │      │  рисуется    │        │ ⌷⌷⌷⌷⌷⌷⌷ ⌷⌷⌷ │
│ └────┘ └────┘ └────┘     │      │  сразу —     │        │ ⌷⌷⌷⌷⌷        │
│ ┌────┐ ┌────┐            │      │  тайлы из    │        └──────────────┘
│ │ ⌷⌷ │ │ ⌷⌷ │            │      │  seed)       │        │
│ └────┘ └────┘            │      └──────────────┘
└──────────────────────────┘
```

| Surface | Loading behaviour |
|---|---|
| Base (cold) | plot-shaped skeletons in the real grid; top bar shows `—` not `0` (a real zero and an unknown must never look alike) |
| Base (refetch) | keeps showing current data; no visual change at all |
| Map | **terrain renders immediately** — it is derived from the seed client-side; only settlement/oasis markers wait on `GET /api/map` |
| ВОЙСКА / ОТЧЁТЫ | row skeletons matching real row height |
| Sheets | never open empty; a sheet opens only when its data is present |
| Action in flight | button → `Отправка…`, disabled; the rest of the screen stays live |

---

## 26. W27 — Empty states

**Rule: state the rule that makes it empty, then the fix, then a link.** An empty state that
says only «Пусто» teaches nothing.

| Surface | Copy | Action |
|---|---|---|
| Очередь | `Очередь пуста` (emphasis — this is a *problem*) | `[ ПОСТРОЙКИ ]` |
| ВОЙСКА | `Войск нет. Разведчиков обучают в Бараках. Бараки открываются на Штабе ур.3.` | `[ ПЕРЕЙТИ В БАЗУ ]` |
| ВОЙСКА · В ПУТИ | `Никто не в пути.` | `(Открыть карту)` |
| ОТЧЁТЫ | `Отчётов пока нет. Отправьте разведчика на карту.` | `[ ОТКРЫТЬ КАРТУ ]` |
| Intel on a tile | `Разведданных нет` | `[ РАЗВЕДАТЬ ]` |
| Buildings tier | `Постройки — нет данных. Нужна Радиовышка выше, чем у цели.` | — |
| ПОСТРОЙКИ | cannot be empty — 13 types always exist | if empty → error state |
| Map / СПИСОК | cannot be empty — 135 NPCs exist | if empty → error state |

```
┌──────────────────────────────────────────────┐
│                                              │
│  ОТЧЁТОВ ПОКА НЕТ                            │
│                                              │
│  Отправьте разведчика на карту, чтобы        │
│  узнать, что у соседей.                      │
│                                              │
│  [        ОТКРЫТЬ КАРТУ                   ] │
│                                              │
└──────────────────────────────────────────────┘
```

---

## 27. W28 — Error states

Four distinct kinds, each with its own treatment. **They must not be conflated** — a failed
tap and a dead server are different problems with different fixes.

### 27.1 Connection lost (persistent, global)

```
├──────────────────────────────────────────────┤
│ Нет связи с сервером            (Повторить)  │ 32
├──────────────────────────────────────────────┤
```

- Sits directly under the top bar, above tab content, on every screen.
- **Countdowns keep running** from the last known `serverTime` — freezing them would make the
  player think the game stopped.
- All commit buttons disable with `Нет связи`.
- Auto-retries with backoff; `(Повторить)` forces it.

### 27.2 Action failed (inline, at the action)

```
├──────────────────────────────────────────────┤
│ [            УЛУЧШИТЬ                     ] │
│ ! Недостаточно ресурсов                      │
└──────────────────────────────────────────────┘
```

**Never a toast.** The player must see the failure next to what they tried. Text comes from
the server's i18n key (`{ key, params }`) — never raw prose, never a status code.

**Race case that will actually happen:** the client thinks a build is affordable, the server
disagrees (a completing event changed state between render and tap). The inline error is the
correct and sufficient handling; the response carries fresh state, so the screen self-corrects
in the same render.

### 27.3 Session expired (401)

```
┌──────────────────────────────────────────────┐
│                                              │
│  СЕССИЯ ИСТЕКЛА                              │
│  Войдите снова, чтобы продолжить.            │
│  Прогресс сохранён.                          │
│                                              │
│  [        ВОЙТИ СНОВА                     ] │
│                                              │
└──────────────────────────────────────────────┘
```

«Прогресс сохранён» is load-bearing: a strategy player who is bounced to a login screen
assumes the worst.

### 27.4 Screen failed to load

```
┌──────────────────────────────────────────────┐
│                                              │
│  НЕ УДАЛОСЬ ЗАГРУЗИТЬ КАРТУ                  │
│  Проверьте связь и попробуйте снова.         │
│                                              │
│  [        ПОВТОРИТЬ                       ] │
│                                              │
└──────────────────────────────────────────────┘
```

Scoped to the failing tab — the other three tabs stay usable. The nav and top bar never
disappear behind an error.

---

## 28. W29 — Onboarding (shipped, M1)

Unchanged by this session; wireframed for completeness. Full screens, no nav, no top bar —
there is no settlement yet, so there are no resources to show.

```
 1 WELCOME                2 REGISTER              3 FOUND
┌──────────────────┐    ┌──────────────────┐   ┌──────────────────┐
│ ПОСЛЕДНИЙ СИГНАЛ │    │ Кто вы в этом    │   │ Пора заложить    │
│                  │    │ мире?            │   │ поселение        │
│ Эфир молчит уже  │    │                  │   │                  │
│ который день…    │    │ Позывной         │   │ Без поселения не │
│                  │    │ [____________]   │   │ выжить в Пустоши.│
│                  │    │                  │   │                  │
│ [ ИГРАТЬ КАК     │    │ Фракция          │   │ [ ОСНОВАТЬ       │
│   ГОСТЬ        ] │    │ ┌────┐┌────┐┌───┐│   │   ПОСЕЛЕНИЕ    ] │
│                  │    │ │Рейд││Инже││Коч││   │                  │
└──────────────────┘    │ └────┘└────┘└───┘│   └──────────────────┘
                        │ [ ПОДТВЕРДИТЬ  ] │
                        └──────────────────┘
```

**One wireframe-level note:** the faction cards must state each faction's *mechanical*
identity before the choice is locked — Engineers' second parallel build slot is a real,
permanent advantage, and «Дорогие сильные бойцы» does not convey it. Recorded in §31.7.

---

## 29. Design decisions made in this session

| # | Decision | Rationale | Rejected |
|---|---|---|---|
| 1 | **One ПОСТРОЙКИ list**, not a separate plot picker | plots are generic (UX §12.2), so a plot carries no context a filtered list could honour; filtering would only hide options | two surfaces per UX §12.4; one sheet with `УЛУЧШИТЬ/ПОСТРОИТЬ` segments (nested tabs, rejected by UX §10) |
| 2 | **Ground shows built buildings + one `+` at the next free slot** | keeps direct manipulation (the reason to be spatial) without a day-one wall of 15 empty boxes; pairs with the one-hint «Следующий шаг» | all 16 plots always (15 identical empties on day one, 3 unfillable in v1); built-only read-only ground (loses direct manipulation) |
| 3 | **Base is a fixed board — nothing scrolls** | everything Base owns stays visible, which is what makes the 1–2 s read true; no scroll state to remember or restore | vertical page scroll (queue and next-step can scroll out of sight); pan/zoom ground (a second pan surface, viewport state, part of the base always off-screen) |
| 4 | **Recall lives in the persisting status sheet, with ВОЙСКА as fallback** | no new chrome; the canonical army tab is already one tap from anywhere | a global 90-second recall strip above the nav (fourth chrome element, collides with M3's incoming-attack strip); ВОЙСКА-only with the sheet auto-closing (undo invisible at the exact moment it is needed) |

---

## 30. Required amendments to `docs/design/UX_DESIGN.md`

Wireframing exposed four points where the UX record is incomplete or now wrong. Recorded per
the project convention rather than diverged from silently.

1. **§12.4 — the build picker is removed.** One ПОСТРОЙКИ list serves both entry points
   (decision §29.1). §12.4's ordering rule (buildable first, blocked collapsed) survives
   unchanged and moves into the single list.
2. **§12.2 — empty plots.** "Empty plots as subtle `+` markers" (plural) becomes **one** `+`
   at the next free slot (decision §29.2). The "plain ground once all 13 are built" rule
   already covers the end state and is unchanged.
3. **§12 — a missing state.** The UX record defines no on-ground representation for a
   building that is **queued** or **under construction**. §4.2 adds both forms. Without them
   the ground contradicts the queue strip.
4. **§7.1 / shipped shell — connection state moves to Settings.** M1's `ConnectionBadge`
   occupies header space above every screen to say "Онлайн". Persistent chrome is for
   information needed on every screen (§7.1); a healthy connection is not. The offline banner
   (§27.1) covers the case that matters. This retires `ConnectionBadge` from the app header.

---

## 31. Data dependencies exposed by wireframing

Additive to UX §18; none is a game-design change.

1. `world.startedAt` in `MapWorldView` — W11 and the `Д5·А1` chip cannot render without it.
   **Still not exposed.** Until it is, the chip is hidden, not faked.
2. `GET /api/movements/mine` must return `{id, type, status, fromSettlementId, target{x,y},
   targetName, units[], departAt, arriveAt, cancellableUntil}` — W17/W18/W20 need
   `targetName` to avoid a second lookup, and `cancellableUntil` so the recall countdown is
   server-authoritative rather than a client-side 90 s guess.
3. Report payloads must carry the **subject settlement id and coordinates** (target for scout
   reports, attacker for counter-reports) — required by W14.2 (map intel) and W24's
   `[ НА КАРТУ ]`.
4. Report payloads must carry **what was sent and what was lost**, not just survivors — W24
   shows «отправлено 2 · погиб 1», which cannot be derived from survivors alone.
5. The unread report count must be cheap for the nav badge (the planned partial index on
   `{accountId, read}` covers it).
6. Building **production output per level** must be reachable client-side for W05/W08's
   `сейчас → станет` lines. `game-core` already exposes the formulas; no server work.
7. Faction descriptions need a mechanical line, not only a flavour line (§28).

---

## 32. Navigation map

```
                    ┌──────── onboarding (no chrome) ────────┐
                    │ Welcome → Register → Found settlement  │
                    └───────────────────┬────────────────────┘
                                        ▼
   ┌──────────┬───────────────┬───────────────┬───────────────┐
   │  /base   │    /map       │    /army      │   /reports    │
   │  (home)  │               │               │               │
   └────┬─────┴───────┬───────┴───────┬───────┴───────┬───────┘
        │             │               │               │
   sheets:       views:          sections:        /reports/:id
   • building    • grid          • дома           (full screen)
   • ПОСТРОЙКИ   • список        • тренировка          │
   • очередь     sheets:         • в пути              │
   • ресурсы*    • tile (×4)          │                │
   • раунд*      • send form          │                │
   • настройки*  • send status ───────┘                │
                      │                                │
                      └──────── [НА КАРТУ] ◀───────────┘

   * reachable from every tab (top bar)
```

- **Tabs are routes**; sheets push history and are back-dismissible.
- **Cross-tab links** are the only permitted duplication, and each is one-directional and
  purposeful (UX §5.4).
- Back from `/reports/:id` returns to the list with scroll position intact; back from a
  `[ НА КАРТУ ]` jump returns to the report.

---

## 33. State transitions

### 33.1 Build

```
idle ──[ПОСТРОИТЬ]──▶ committed ──queue──▶ waiting ──slot free──▶ building
                          │                   │                      │
                     (Отменить)          (Отменить)             (Отменить)
                          ▼                   ▼                      ▼
                    refund 100% ──────────────┴──────────────────────┘
                                                                     │
                                              countdown 0 → refetch ──▼
                                        built (level+1) + toast + plot updates
```

### 33.2 Scout

```
tile selected ──[РАЗВЕДАТЬ]──▶ form ──[ОТПРАВИТЬ]──▶ outbound
                                 │                       │
                            (Отмена)              (ОТОЗВАТЬ ≤90s)
                                 ▼                       ▼
                           tile selected            returning ──▶ home
                                                         ▲
   outbound ──arrive──▶ resolve ──survivors?──yes──▶ returning ──▶ home
                            │                                       │
                            └──no──▶ ended (no return)              │
                            │                                       │
                            └──▶ report created ──▶ toast + badge ◀─┘
```

### 33.3 «Следующий шаг» ladder (first match wins) — and where each line navigates

| # | Condition | Line | Tap target |
|---|---|---|---|
| 1 | `netFoodPerHour < 0` | Еда в минусе — постройте Теплицу | W08, Greenhouse row |
| 2 | queue empty and something affordable | Очередь пуста — заложите постройку | W08 |
| 3 | any resource at cap | Склад полон, производство встало | W10 |
| 4 | no Barracks, CC < 3 | Штаб ур.3 откроет Бараки | W05, Command Center |
| 5 | Barracks built, 0 scouts, affordable | Обучите разведчика в Бараках | W22 |
| 6 | ≥1 scout home, no scout in flight | Есть разведчик — найдите цель на карте | W12 |
| 7 | unread reports > 0 | Пришёл отчёт разведки | W23 |
| 8 | otherwise | Влияние N из M — второе поселение | — (no-op in M2) |

---

## 34. Interaction notes

1. **Sheets never cover the bottom nav** (§3). Maximum default height 435 px, expandable to
   ~650 px.
2. **Sheets never stack.** A sheet opened from a sheet replaces it; back returns.
3. **One toast at a time**, ~4 s, tappable, never over the primary CTA, never for an error the
   player's own tap caused.
4. **Every disabled control has an adjacent reason and, where one exists, a `›` link to the
   fix.** A greyed control with no sentence is treated as a defect in review.
5. **Countdowns are server-anchored and must resolve at zero** — refetch, then reflect real
   state. M1's own logged lesson: test the boundary, not the slope.
6. **Remaining time is primary; wall-clock is secondary** and always present for anything over
   ~10 minutes.
7. **Tap tolerance ≥ 44 px** everywhere, including 32 px map tiles.
8. **No layout shift from live data** — tabular figures for every ticking number.
9. **A real zero and an unknown never look alike** (`0` vs `—`).
10. **Nothing on Base scrolls.** If a future addition does not fit, it becomes a sheet — it
    does not turn Base into a document.
11. **Selection is explicit and dismissible**: tapping a tile or plot marks it; dismissing the
    sheet clears it.
12. **RU strings run ~15% longer than English** — every button in these wireframes was sized
    against its longest real string («Максимальный уровень», «Возвращается домой»).

---

## 35. Unresolved questions

None blocks building these wireframes.

| # | Question | Needed by |
|---|---|---|
| 1 | **Ground layout algorithm.** Slot assignment is "automatic and cosmetic" (M1 §8). Does the ground place buildings in slot order (predictable, spatial memory) or by category (resource cluster, military cluster — prettier, but positions shift as you build)? Recommend slot order. | M2c |
| 2 | **Map 0.5× overview:** flat tints or real tiles? Needs to be seen at 402 px. Carried from UX §21.1. | M2c |
| 3 | **Building sprites per level** — one sprite per building exists; a level badge is the fallback. Carried from UX §21.2. | M6 |
| 4 | **`Влияние` tap target** — no-op in M2, opens an expansion screen in M3. Leave inert or make it explain itself in a sheet? | M3 |
| 5 | **Report retention UI** (delete/archive vs append-only for the round). Carried from UX §21.3. | M3 |
| 6 | **Incoming-attack chrome** — the strip §29.4 deliberately kept free. Needs its own design round. | M3 |
| 7 | **Multi-settlement switcher** — designed as a chevron on the Base context row (UX §12.8), not wireframed here because M2 has exactly one settlement. | M3 |
