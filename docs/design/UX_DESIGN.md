# Last Signal — UX design record

**Status: the UX model below is RESOLVED for everything M1 and M2 ship.** Settled with the
owner in the UX design session of 2026-08-16 (three rounds of structured Q&A). This document
is the **binding UX record**: for questions of screen structure, navigation, information
hierarchy and interaction model it **wins over `IMPLEMENTATION_PLAN.md` §3.5 and over
`M2_DESIGN_DECISIONS.md` §11** where they disagree. The three §11 items it overrides are
listed explicitly in §20 — they must be amended there, not silently diverged from.

It does **not** touch game mechanics. Every rule, formula, gate and number referenced here
comes from `docs/M1_DESIGN_DECISIONS.md` and `docs/M2_DESIGN_DECISIONS.md`; where this
document appears to state a mechanic, it is quoting them.

**Shapes vs decoration** (the analog of M1/M2's "numbers vs shapes"). Screen responsibilities,
information hierarchy, navigation, interaction patterns and state coverage below are **final
shapes**. Exact pixel sizes, spacing, sprite choices, copy and colour assignments are
**decoration** — first-pass drafts, tuned during implementation and the M6 visual pass. No
pixel value below is sacred; every responsibility is.

**Scope of the analysis.** Written against what exists in the repository as of 2026-08-16:
M0+M1 shipped and committed, M2a complete (world, spawn, `GET /api/map`, 135 inert NPCs),
M2b/M2c in flight in a parallel process. Screens that only exist from M3 (Market, combat
reports, support), M5 (Side, Source, rankings, medals) or M7 are designed only to the depth
needed to prove the navigation and information model won't have to be rebuilt for them.

---

## 0. What changed the starting position

Four findings from the repository inspection, because they invalidate assumptions in the
existing records and explain several decisions below.

1. **The asset pipeline has already run.** `apps/web/public/assets/` holds ~100 sliced
   sprites (13 buildings, 15 units, 9 terrain tiles, 4 settlement markers, 4 resource icons,
   9-slice panels and bars, 8 nav icons in default + hover, faction/side emblems, medals,
   battle art) plus `manifest.json`. `M2_DESIGN_DECISIONS.md` §11 chose **flat placeholder
   tiles** and put slicing in M6 — that constraint no longer holds. The spatial base and
   real terrain tiles are available *now*, which is why §12 and §13 below assume them.
2. **The owner's `apps/web/public/_mockup.html`** is a hand-assembled phone-sized concept
   (402×840) using those sprites: a *spatial* base, a tiled map with a bottom tap-sheet, a
   compact 4-resource top bar, and a 6-item bottom nav. It contradicts the shipped M1c list
   UI. Treated here as **art direction and intent, not spec** — two of its details are
   knowingly wrong against the locked design and are **not** adopted: resource-field badges
   on map tiles (§2.3 locks "no separate field ring — resource buildings are regular
   buildings inside the settlement") and nav entries for Рынок (M3) / Сторона (M5).
3. **There is no router and no screen container.** `Onboarding.tsx` is a state machine whose
   terminal state renders `BaseScreen`; `BottomNav` renders seven buttons of which six are
   `disabled`. M2c's Map and Reports tabs have nowhere to mount. The navigation model in §5
   is therefore being built from zero — choosing it now costs nothing.
4. **`art/reference/mockup_ui_pixel.png` is a desktop-shaped four-panel art board**, not a
   mobile layout. It is binding for *style* (per plan §6) and useful for component anatomy
   (stat rows, cost rows, report structure, ±count picker). It is **not** binding for layout:
   its left-rail nav, its 6-across unit grid and its side-by-side panels do not survive a
   402px viewport.

---

## 1. UX goals

In priority order. Later goals never win against earlier ones.

1. **The state of a screen is readable in 1–2 seconds.** A player checks in twice a day for
   two minutes. Every screen answers its own question at a glance, before any tapping.
2. **The game teaches itself through its own rules.** The Food gate, prerequisites and
   Influence are the tutorial. Guidance is *derived from live state*, never authored
   content that can go stale (§12.6).
3. **Every action ends somewhere useful.** No dead ends: after each action the player can
   see what changed and what to do next, without navigating to verify.
4. **Time is always legible.** This is a real-time game played across time zones on a 21-day
   deadline. Countdowns, arrival clocks and the round clock are first-class, always anchored
   to the server clock, never the browser's.
5. **One canonical home per concept.** Contextual entry points may link *into* the canonical
   home; they never duplicate it. (Troops live in Войска; the Barracks links there.)
6. **Undo beats confirm.** Where the mechanics already provide a reversal window, use it
   instead of a modal. (Scout recall: 90 s. Build cancel: 100% refund.)
7. **Clarity outranks decoration.** The pixel art carries identity; it never carries meaning
   that isn't also stated in text or number.

---

## 2. Core gameplay loops

Three nested loops. The UX exists to make each one's next step obvious.

**Loop A — Economy (minutes; the whole of M1, every session forever).**
`check resources → pick the best affordable upgrade → enqueue → wait → repeat`
Bottleneck the UI must expose: *which upgrade is affordable now, which is blocked and why,
and how long until the blocked one isn't.* Already computed by `computeBuildEligibility`.

**Loop B — Intel (hours; M2's payoff).**
`train scouts → pick a target → send → wait travel → read report → decide`
Bottleneck: *finding a target worth the trip*, on a 61×61 map at ~12 tiles per phone screen.
Solved by the «Рядом» list (§13.3) and by intel persisting on the map (§14.4).

**Loop C — Round arc (days; M5 completes it).**
`grow influence → expand → pick fights → contribute to your side → season ranking`
Only its *pressure* exists in M2: the 21-day clock, the act, and Influence progress toward
settlement #2. Exposed as the round chip (§7.2) and the Influence line (§12.7).

Loops A and B compete for the same resources — Food gates both builds and troops. That
tension is the game; the UI must never hide either side of it, which is why net Food is
persistent (§7.1) and the training gate reads the same way as the build gate (§15.2).

---

## 3. Primary player journeys

Format per the session brief: **GOAL → ENTRY → ACTION → UI RESPONSE → NEXT DECISION →
RESULT → NEXT DESTINATION.**

### J1 — First session (cold start to first build)

- **Goal:** exist in the world.
- **Entry:** app opens with no session → Welcome.
- **Action:** «Играть как гость» → name + faction → «Основать поселение».
- **UI response:** each step replaces the previous full screen; the faction cards state the
  faction's actual mechanical identity (Engineers' second parallel build slot is a real
  advantage and must be readable *before* choosing, not after).
- **Next decision:** what to build first.
- **Result:** Base screen. Command Center L1 on the ground, 15 empty plots, net Food
  negative, and **exactly one legal build** — the Greenhouse. The «Следующий шаг» line reads
  «Еда в минусе — постройте Теплицу». The build picker sorts buildable first and collapses
  the twelve blocked ones behind «Ещё 12 — недоступны».
- **Next destination:** stays on Base, queue strip now counting down.
- *Design note:* the single-choice opening is intended (`M1 §4`). The UX obligation is to
  make it read as *a clear instruction*, not as *twelve failures*.

### J2 — Routine check-in (the most-repeated journey in the game)

- **Goal:** don't waste idle time.
- **Entry:** app opens → Base (always; §5.2).
- **Action:** read the top bar; read the queue strip; read «Следующий шаг».
- **UI response:** fill bars show cap pressure without text; the queue strip shows the active
  build's remaining time or «Очередь пуста»; the Отчёты badge shows unread count.
- **Next decision:** enqueue something / go read a report / send a scout.
- **Result:** ≤ 2 taps to the decision, from a cold open.
- **Next destination:** stays on Base, or one tab hop.

### J3 — Unlocking and training scouts

- **Goal:** be able to see other players.
- **Entry:** «Следующий шаг» reads «Штаб ур.3 откроет Бараки», then «Обучите разведчика».
- **Action:** tap the Barracks on the ground → building sheet → count picker `[−] 2 [+]` →
  «Обучить».
- **UI response:** the sheet shows batch cost, batch time, and the **net-Food-after-batch**
  figure — the same absolute gate the server enforces (`wouldStarveWithTroops`). Blocked
  states name the blocker, never just grey out.
- **Next decision:** how many to train (Food upkeep is permanent; the picker must show it).
- **Result:** training queue starts; the Войска tab gains a countdown row; scouts are
  credited one at a time (chained events).
- **Next destination:** Войска (to watch), or Map (to plan).

### J4 — Finding a target and scouting it

- **Goal:** learn what a neighbour has.
- **Entry:** Map tab, or «Следующий шаг» → «Есть разведчик — найдите цель на карте».
- **Action:** either pan the map, or flip to «СПИСОК» and read neighbours sorted by
  distance with their scout travel time; tap one.
- **UI response:** map centres on the target and its bottom sheet opens: name, owner,
  faction, side, distance — plus last-known intel if any (§14.4).
- **Next decision:** worth the trip?
- **Action:** «РАЗВЕДАТЬ» → the same sheet expands into the send form: unit stepper bounded
  by scouts at home, travel time and **arrival wall-clock** previewed from `travelTimeMs`.
- **Action:** «ОТПРАВИТЬ» — no confirmation dialog.
- **UI response:** sheet becomes a live status card: recall countdown `[Отозвать 0:74]`,
  arrival countdown; a movement marker appears on the map and animates along the line.
- **Result:** scouts en route.
- **Next destination:** stays on Map. The player watches, or leaves.

### J5 — Recalling (the undo)

- **Goal:** I picked the wrong target / I need those scouts home.
- **Entry:** the post-send status card, **or** the Войска tab's «В пути» row (both show the
  same countdown — Войска is the canonical home, reachable from anywhere).
- **Action:** «Отозвать» within 90 s.
- **UI response:** the row flips to «Возвращается» with the return countdown; the map marker
  reverses direction.
- **Result:** scouts come home; nothing was spent but time.
- **Next destination:** wherever they were.

### J6 — The report arrives

- **Goal:** find out what's there.
- **Entry:** a toast «Пришёл отчёт разведки» (tappable), or the Отчёты badge on return.
- **Action:** open Отчёты → tap the unread report.
- **UI response:** the report detail renders by outcome:
  - **success (base tier):** target resources, storage caps, troops at home;
  - **success (buildings tier, Radio Tower diff ≥ 1):** the above plus the full building list
    with levels;
  - **failure:** «Разведчики не вернулись» — losses, no intel. This report exists on purpose
    (deliberate Travian deviation, §8 of the M2 record): silence would read as a bug.
  - **detected (counter-report):** *someone scouted you* — attacker settlement and owner,
    nothing about what they learned.
- **Next decision:** raid later (M3) / scout again / scout someone else.
- **Result:** the report is marked read on open; the intel is now attached to that tile on
  the map (§14.4).
- **Next destination:** «На карту» from the report opens the Map centred on the target with
  its sheet open — the loop closes without hunting for coordinates.

### J7 — Being scouted

- **Goal:** know that I'm being looked at.
- **Entry:** the counter-report, and only it. M2 ships **no incoming-movement visibility**
  (owner decision, M2 §8) — the defender learns about it after the fact, and only if they
  had a scout at home.
- **UI obligation:** the counter-report must make the *conditionality* legible, otherwise
  players conclude the game is broken when a scout slips past. The Войска screen carries a
  one-line rule statement while the player has zero scouts at home: «Без разведчика дома вы
  не узнаете о чужой разведке».

### J8 — Long-term goal (Influence)

- **Goal:** a second settlement.
- **Entry:** Base, below the queue strip.
- **UI response:** «Влияние 240 из 400 — второе поселение» with a progress bar.
- **Result in M2:** display only; the founding action is M3 (settler convoy is a movement
  type M2 doesn't ship). The line must therefore state the gate, not offer a button.
- **Next destination:** back to Loop A — which is exactly the point of showing it.

---

## 4. Screen / state inventory

Complete list of every surface, with its milestone. `S` = bottom sheet, `F` = full screen,
`O` = overlay/toast, `C` = persistent chrome.

| # | Surface | Type | Milestone |
|---|---|---|---|
| 1 | Boot / session check | F | M1 ✅ |
| 2 | Connection error / offline | F+O | M1 ✅ |
| 3 | Welcome (guest login) | F | M1 ✅ |
| 4 | Register (name + faction) | F | M1 ✅ |
| 5 | Found settlement | F | M1 ✅ |
| 6 | **Top bar** (resources, round chip, gear) | C | M2c |
| 7 | **Bottom nav** (4 tabs + badges) | C | M2c |
| 8 | **Base** — spatial settlement | F | M2c/M6 (§20.4) |
| 9 | Building detail (level, cost, upgrade) | S | M2c |
| 10 | Build picker (from an empty plot) | S | M2c |
| 11 | Buildings list (all 13, sortable) | S | M2c |
| 12 | Build queue — strip + expanded | C+S | M1 ✅ / M2c |
| 13 | Resource detail (caps, rates, ETA, upkeep) | S | M2c |
| 14 | Round timeline (day, act, next act) | S | M2c |
| 15 | **Map** — pan/zoom tile grid | F | M2c |
| 16 | Map «СПИСОК» — neighbours by distance | F | M2c |
| 17 | Tile sheet — other settlement | S | M2c |
| 18 | Tile sheet — own settlement | S | M2c |
| 19 | Tile sheet — oasis | S | M2c |
| 20 | Tile sheet — empty tile | S | M2c |
| 21 | Send-scout form (expanded #17) | S | M2c |
| 22 | Post-send status + recall | S | M2c |
| 23 | Jump-to-coordinates | S | M2c |
| 24 | **Войска** — home / training / in flight | F | M2c |
| 25 | Training picker (from Barracks) | S | M2c |
| 26 | **Отчёты** — list with unread badges | F | M2c |
| 27 | Report detail (4 outcome variants) | F | M2c |
| 28 | Settings (language, account, logout) | S | M2c |
| 29 | Toasts | O | M2c |
| 30 | Рынок | F | M3 |
| 31 | Settlement switcher (2–3 settlements) | S | M3 |
| 32 | Combat reports (raid/assault) | F | M3 |
| 33 | Incoming movements surface | C | M3 |
| 34 | Сторона / Source / contribution | F | M5 |
| 35 | Rankings / medals | F | M5/M6 |

---

## 5. Navigation model

### 5.1 Bottom tabs — only what is live

**Decision: the tab bar contains only tabs that work, and grows one milestone at a time.**

- **M2:** `База · Карта · Войска · Отчёты` — four tabs, ~100 px each at 402 px.
- **M3:** `+ Рынок` (five).
- **M5:** `+ Сторона` (six). Rankings live inside Сторона, not as a seventh tab.
- **Settings** is never a tab — it is the gear in the top bar, at every milestone.

**Rejected:** *all seven tabs with future ones disabled* (the shipped M1c behaviour) — at
402 px that is ~57 px per target, five of which exist only to reject taps; the roadmap is not
the player's problem. *Five fixed slots + «Ещё» overflow* — stable bar shape forever, but it
buries Рынок, a screen Travian-likes visit constantly.

This supersedes `BottomNav.tsx`'s current "visibly present but disabled" rationale.

### 5.2 Landing screen

**Decision: always Base**, post-onboarding, every cold open. Predictability is the point —
the check-in ritual (§J2) becomes muscle memory precisely because the app always looks the
same on open. Deep links (a report, an M7 Telegram push) may open Map or Отчёты directly;
that is the *only* exception.

**Rejected:** *always Map* (nothing to do there in Act 1, and every decision is on Base);
*remember the last screen* (cheaper friction, but the app never looks the same twice);
*adaptive* (a rule the player cannot see or predict).

### 5.3 Routing, history and back

- **Tabs are routes:** `/base`, `/map`, `/army`, `/reports`. Browser/Android back moves
  between them; a shared link opens the right screen. This app is a browser game and will be
  a Telegram Mini App — a broken back button is a bug, not a style choice.
- **Sheets are not routes but are back-dismissible.** Opening a sheet pushes a history entry;
  back closes the sheet instead of leaving the screen. Nothing that can be opened may trap
  the player.
- **Tab state persists within a session:** the map keeps its pan/zoom and selected tile; the
  reports list keeps its scroll position; the buildings list keeps its sort. Switching tabs
  is navigation, not a reset.
- **One modal-ish surface at a time.** A sheet replaces a sheet; sheets never stack.

### 5.4 Cross-screen links (the only permitted duplication)

| From | To | Why |
|---|---|---|
| Barracks building sheet | Войска | training's canonical home |
| Войска training row | Barracks sheet | «Бараки ›» — where you train more |
| Map tile sheet (own) | Base | «Перейти в базу» |
| Report detail | Map, centred + sheet open | closes the intel loop |
| Report detail | Отчёты list | «Назад к отчётам» |
| Map movement marker | Войска | the canonical movement list |
| «Следующий шаг» line | the relevant screen | it is a link, not a label |

---

## 6. Screen responsibilities

Each screen answers exactly one question. If a screen needs two sentences to describe, it is
two screens.

| Screen | The one question it answers | Owns | Must never own |
|---|---|---|---|
| **База** | *What is my settlement, and what should I build next?* | buildings, levels, build queue, Influence, the next-step line | map data, other players, movement lists |
| **Карта** | *Who and what is around me, and what can I reach?* | terrain, settlements, oases, distances, travel previews, last-known intel, target selection | build actions, training actions |
| **Войска** | *What do I have, what is coming, what is out?* | home troops, training queue, in-flight movements, recall | target selection, the send form |
| **Отчёты** | *What did I learn, and what happened to me?* | report list, unread state, report detail | live state (a report is a frozen snapshot) |
| **Top bar** | *Can I afford things, and how much round is left?* | 4 resources + cap pressure, round/act chip, settings | anything screen-specific |
| **Bottom nav** | *Where am I, and what needs attention?* | current tab, unread/attention badges | actions |

**Войска is the canonical army screen** (owner decision). Training *starts* at the Barracks —
because "buildings do things" is the mental model M1 spent a milestone teaching — but the
queue it produces, the troops it yields and the movements they join are all read in one
place. This supersedes M2 §11's "movements as an overlay list on the Map tab": the Map keeps
*spatial* movement markers, Войска keeps the *list* and the recall button, and neither
duplicates the other.

**Rejected:** *no Войска tab in M2* (leanest, matches §11 literally — but the 90 s recall
window would then live only on a screen the player may not be looking at); *Войска owns
training too* (fewest surfaces, but it severs actions from the buildings that grant them).

---

## 7. Information hierarchy

### 7.1 Persistent — visible on every screen, always

**The top bar** (`C`, ~56 px including fill bars):

| Element | Encodes | Why persistent |
|---|---|---|
| 4 resource values | affordability | every decision in the game is a purchase |
| 4 fill bars under the values | cap pressure | production halts at cap — silent waste otherwise |
| Food deficit marker | net Food < 0 | blocks all builds and training; must never be discovered by failing |
| Round chip «Д5·А1» | days left, act | the 21-day wipe is the game's core pressure |
| Gear | settings | at every milestone; never a tab |

**Decision: value + fill bar, tap for detail.** The bar answers "can I afford it" and "am I
about to waste production" in under a second with no text. Rates, caps, «заполнится через» and
the Food upkeep breakdown live one tap deeper, in the resource sheet.

**Rejected:** *values only* (slimmest, matches the owner's mockup — but cap pressure and
deficit then rely on a colour change alone); *full M1c tiles always* (nothing hidden, but
~90–120 px of a 840 px phone on every screen, forever).

**The bottom nav** carries attention badges: unread reports (count), and — from M3 —
incoming attacks. Badges mean *something needs you*, never *something exists*.

### 7.2 Contextual — appears with the screen

Base: settlement name (a switcher from M3), coordinates, queue strip, next-step line,
Influence line. Map: viewport centre coordinates, zoom control, recentre, jump-to-coords,
КАРТА/СПИСОК toggle. Войска: section headers with counts. Отчёты: filter/segment (M3, when
report types multiply).

### 7.3 On demand — appears only after selection

Building cost vectors and build times; block reasons; per-resource rates and ETAs; a
settlement's public card; last-known intel; travel previews; report bodies; the round
timeline. **Rule:** anything requiring a number the player didn't ask for is on demand.

### 7.4 Never shown

Terrain type names (cosmetic in v1 — the tile art *is* the information); slot numbers;
`isNpc` (NPCs must be indistinguishable — the server already omits it from `MapView`, and the
client must not infer it from name patterns or building profiles); other players' movements;
internal ids; `configVersion`; anything the server declines to send.

---

## 8. Primary and secondary actions

**One primary action per surface.** Primary = accent-filled button, thumb-reachable, bottom
of its surface. Secondary = outline/ghost. Destructive = danger, and never adjacent to the
primary.

| Surface | Primary | Secondary | Destructive |
|---|---|---|---|
| Welcome | Играть как гость | — | — |
| Register | Подтвердить | — | — |
| Base | (none — the ground is the interface) | ПОСТРОЙКИ, plot taps | — |
| Building sheet | Улучшить / Построить | — | — |
| Build picker | Построить (per row) | — | — |
| Queue (expanded) | — | — | Отменить (100% refund) |
| Barracks sheet | Обучить | Войска › | — |
| Map tile sheet | РАЗВЕДАТЬ | Отчёт, Перейти в базу | — |
| Send form | ОТПРАВИТЬ | Отмена (closes) | — |
| Post-send card | — | — | Отозвать (90 s) |
| Report detail | На карту | Разведать снова | Удалить (M3+) |
| Войска movement row | — | — | Отозвать |

**Confirmation policy — undo over confirm.** Nothing in M1/M2 raises a confirmation dialog.
Send-scout commits on «ОТПРАВИТЬ» and is undone by the 90 s recall; enqueuing a build is
undone by cancel-with-full-refund. Both reversals are *cheaper and more honest* than a modal
players learn to dismiss blind. Confirmations are reserved for genuinely irreversible acts,
which arrive in M3 (sending an army to its death) and M5 (switching sides — resets
contribution to zero) and will be decided then.

---

## 9. Important states

Every surface must define all of these before it is built. Missing-state bugs are the most
common way a strategy UI reads as broken.

### 9.1 Global

| State | Treatment |
|---|---|
| Loading (first paint) | skeleton of the real layout, not a spinner on empty space |
| Loading (refetch) | keep showing stale data; never blank a screen that had content |
| Offline / server unreachable | persistent banner under the top bar; countdowns keep running from the last server clock; actions disabled with a reason |
| Session expired (401) | return to Welcome with «Сессия истекла», no data loss panic |
| Action in flight | the button becomes «Отправка…» and disables; the screen does not lock |
| Action failed | inline error at the action, from the server's i18n key — never a raw message, never a toast (the player must see it next to what they tried) |

### 9.2 Economy

| State | Signal |
|---|---|
| Resource at cap | fill bar full + accent; resource sheet says «производство остановлено» |
| Net Food negative | Food bar marked danger + ▼; every build/training block reason names it |
| Queue empty | queue strip reads «Очередь пуста» in accent — idle capacity is a *problem*, shown as one |
| Queue full (3/3) | build actions blocked with «Очередь заполнена» |
| Build affordable | primary enabled |
| Build not yet affordable | «Доступно через 04:12» — a countdown, not a flat refusal |
| Build never affordable at current storage | «Не хватит вместимости склада» — a different problem with a different fix |
| Prerequisite missing | the missing buildings and levels listed, tappable to jump to them |
| Max level | row reads «Максимальный уровень», no button |

### 9.3 Map & movement

| State | Signal |
|---|---|
| No scouts at home | tile sheet's «РАЗВЕДАТЬ» disabled with «Нет разведчиков дома» + link to Barracks |
| Own settlement selected | sheet shows «Перейти в базу», never a scout action |
| Oasis selected | public card + «Разведка недоступна» (oasis scouting is M3) |
| Empty tile selected | terrain + coordinates only; no actions in v1 |
| Movement outbound | marker + ETA countdown; recall available for 90 s |
| Movement returning | marker reversed; «Возвращается», arrival countdown |
| Movement arrived, report pending | Отчёты badge; toast |
| All scouts lost | Войска «Дома: 0» + the failure report |

### 9.4 Empty states — each states the rule that makes it empty, then the fix

| Surface | Empty copy pattern |
|---|---|
| Отчёты | «Отчётов пока нет. Отправьте разведчика на карту.» + link |
| Войска — дома | «Нет войск. Постройте Бараки и обучите разведчика.» + link |
| Войска — в пути | «Никто не в пути.» |
| Build queue | «Очередь пуста» (accent — see 9.2) |
| Map «СПИСОК» | cannot be empty (135 NPCs); if it is, that's an error state, not an empty one |

---

## 10. Interaction patterns

A closed vocabulary. Anything not in this table needs a decision before it is built.

| Pattern | Used for | Rules |
|---|---|---|
| **Bottom sheet** | detail + action for a selected object (building, plot, tile, resource, round) | drag-to-dismiss; back-dismissible; ≤ 60% viewport height by default, expandable to 90%; the context behind stays visible and dimmed |
| **Full screen** | the four tabs, report detail, onboarding | never for a single object's detail |
| **Expanding sheet** | send-scout (info → form → status, one surface) | never navigates; the map stays visible |
| **Strip** | build queue on Base, in-flight summary | one line, always tappable to the full list |
| **Toast** | events that happened elsewhere | one at a time, ~4 s, tappable to navigate, never covering the primary action, never for errors caused by a tap |
| **Badge** | unread/attention on a tab | count for reports; dot for state |
| **Inline error** | an action the player just took | at the action, from the server's i18n key |
| **Count picker** `[−] n [+]` | train N units, send N scouts | bounded by what is actually available; long-press to repeat; shows the *consequence* (batch cost, upkeep, travel time) live |
| **Progress bar** | build/training progress, resource cap, Influence | always paired with a number; never the only signal |
| **Countdown** | anything with `completesAt`/`arriveAt` | remaining time is primary, wall-clock arrival secondary; server-clock anchored; must reach zero and *resolve* (M1's own lesson: test the boundary, not the slope) |

**Rejected patterns:** hover states as a source of information (no hover on touch — the
hover-variant nav sprites are used for *active*, not hover); horizontal card carousels for
primary content; nested tabs inside a tab; long-press as the only route to an action;
confirmation dialogs (§8).

---

## 11. Mobile UX rules

Baseline viewport **402 × 840** (the owner's mockup, ≈ iPhone 16 Pro). Portrait is the design
target; landscape must not break, but is not designed for.

1. **Touch targets ≥ 44 px** in both dimensions. Map tiles are 32 px at 1× — a tap therefore
   uses a 44 px tolerance around the tile centre, and selection is confirmed by the sheet, not
   by a hairline highlight.
2. **Thumb zone.** Primary actions sit in the bottom third. The top bar is read-only apart
   from two deliberate taps (resources, round chip) and the gear.
3. **No horizontal scrolling** of primary content. The only permitted horizontal strips are
   deliberate and obviously scrollable (the unit roster in the mockup).
4. **Vertical budget.** 840 px − top bar 56 − nav 58 − safe areas ≈ **700 px** of content.
   Any screen needing more must be a sheet or a separate surface. This is the number that
   killed the always-visible full resource tiles.
5. **Russian text runs ~15% longer than English.** No fixed-width labels, no truncation of
   building names, no relying on a term fitting a button. Test with the longest RU string
   («Электронная мастерская», «Возвращается», «Максимальный уровень»).
6. **Pixel art integrity:** `image-rendering: pixelated` everywhere (already global in
   `styles.css`); sprites scale at integer factors only; never scale a 32 px tile to 44 px.
7. **No layout shift from live data.** Countdowns, resource values and progress bars are
   tabular-figure or fixed-width — a number ticking from 9 to 10 must not move a button.
8. **Safe-area insets** honoured top and bottom (`env(safe-area-inset-*)`) — the nav bar must
   clear the home indicator.
9. **`touch-action` disciplined:** the map pans and pinch-zooms; the rest of the app does not
   double-tap-zoom or rubber-band horizontally.
10. **Sheets never cover their own trigger context** entirely: the tile being scouted stays
    visible above the map sheet.
11. **Everything through i18n keys, RU shipped.** The server ships keys + params, never prose
    (M1 §15). New namespaces for M2: `map`, `units`, `reports`.
12. **Accessibility floor:** every icon-only control has an `aria-label`; state is never
    encoded by colour alone (cap = full bar *and* colour; deficit = ▼ *and* colour); minimum
    11 px for secondary text, 13 px for body.

---

## 12. Base UX

### 12.1 The model — spatial home, list on demand

**Decision: the settlement is drawn spatially; the list is a sheet.**

The ground shows the settlement as a place: built buildings as sprites on their slots, empty
plots as subtle `+` markers. Tapping a building opens its detail sheet with the upgrade
action. Tapping an empty plot opens the build picker. A «ПОСТРОЙКИ» button opens the full
13-row list — the dense, scannable surface for comparing costs and blockers.

Rationale: the picture carries identity, progress and at-a-glance composition ("I have no
Barracks yet") that a list cannot; the list carries comparison that a picture cannot. Neither
alone is sufficient on a phone, and the art to do it now exists (§0.1).

**Rejected:** *list-only* (the shipped M1c model — cheapest and art-free, but it reads as a
prototype and wastes the building art entirely); *spatial-only* (most authentic to Travian,
but comparing 13 costs and blockers means 13 taps); *list home + spatial as a decorative
second view* (splits the base in two and the picture never earns its keep).

### 12.2 Plots and slots

- The schema is `{id, type, level, slot}` over **16 fixed slots**, one instance per building
  type in v1 (M1 §8) — so with 13 types, **3 plots can never be filled in v1**.
- **Plots are generic.** No plot is "for" a building; slot assignment stays automatic and
  cosmetic, exactly as M1 decided. Tapping any empty plot opens the same picker.
- **When all 13 types are built, the remaining plots render as plain ground** — no `+`, no
  affordance. An empty affordance that can never be satisfied is a bug in the UI, not a
  feature of the world.
- Multi-instance (a config change per M1 §8) drops in without a UX change: more plots become
  fillable, the picker gains repeat entries.

### 12.3 Building detail sheet

Level, next level, cost vector, build time, and one primary action. Blocked states name the
blocker and, for prerequisites, link to the buildings that satisfy it. Production buildings
additionally show their current and next-level output per hour — the only way an upgrade
decision can be made without arithmetic. The Barracks sheet additionally carries the
training picker (§15.2).

### 12.4 Build picker (from an empty plot)

Rows for every not-yet-built type, **buildable first**, blocked ones collapsed behind «Ещё N
— недоступны». This single ordering rule is what turns the first session from "twelve
rejections" into "one instruction". Each row: name, cost, time, and the block reason when
blocked.

### 12.5 Build queue

- **Strip (persistent on Base):** active build name + target level + remaining countdown, or
  «Очередь пуста» in accent. Tap expands.
- **Expanded sheet:** up to 3 items (Engineers: 2 active + 2 waiting), each with position or
  countdown, progress bar, and «Отменить» (100% refund).
- Completion is client-detected from the countdown reaching zero, then confirmed by refetch
  with the bounded retry already shipped in `BuildQueueList.tsx` — and now also raises a
  toast «Штаб ур.5 готов».

### 12.6 «Следующий шаг» — rules-derived guidance

**Decision: one always-present line on Base, computed from live state, never authored
content.** First match in this ladder wins:

| # | Condition | Line |
|---|---|---|
| 1 | net Food < 0 | «Еда в минусе — улучшите Теплицу» |
| 2 | build queue empty and something is affordable | «Очередь пуста — заложите постройку» |
| 3 | any resource at cap | «Склад полон, производство встало» |
| 4 | Barracks not built, CC < 3 | «Штаб ур.3 откроет Бараки» |
| 5 | Barracks built, 0 scouts, batch affordable | «Обучите разведчика в Бараках» |
| 6 | ≥ 1 scout home, no scout movement in flight | «Есть разведчик — найдите цель на карте» |
| 7 | unread reports > 0 | «Пришёл отчёт разведки» |
| 8 | otherwise | Influence progress toward settlement #2 |

The line is a **link**: it navigates to the surface that resolves it. It cannot go stale, it
needs no server state, no tutorial state machine, and it keeps earning its place on day 14 —
it is not a first-session device.

**Rejected:** *nothing beyond block reasons* (most respectful of a strategy audience, and the
single-choice opening is intended — but minute one then reads as "everything is broken");
*a real objectives/quest system* (strong retention, but it is authored content + server state
+ its own UI, and it is already parked in the backlog per M2 §14); *a one-time first-launch
overlay* (effective for five minutes, dead weight afterwards, and useless to a player who
returns confused on day 9).

### 12.7 Influence

A line below the queue: «Влияние 240 из 400 — второе поселение», with a progress bar.
**Display only in M2** — the founding action is M3. The line states the gate; it does not
offer a button it cannot honour.

### 12.8 Multiple settlements (M3)

The settlement name in the Base context row becomes a switcher (chevron → sheet listing the
account's settlements with their queue state). With one settlement it is a plain label, no
chevron. Designed now so the header is not rebuilt in M3.

---

## 13. Map UX

### 13.1 Rendering

DOM tile grid with viewport culling, 32 px base tile, pinch/drag pan, three zoom steps
(0.5× / 1× / 2×) — as M2 §11 specifies. **Real terrain sprites**, not flat placeholders
(§0.1, §20.3): `map.tile.*` from the manifest, chosen by `terrainAt(config, seed, x, y)`
client-side. Terrain never arrives over the wire.

What renders at each zoom:

| Zoom | Terrain | Settlement markers | Names | Oases |
|---|---|---|---|---|
| 0.5× (overview) | tinted tiles | dots, faction/side coloured | no | dots |
| 1× (default) | full tiles | `map.marker.village.*` sprites | no | sprite |
| 2× (detail) | full tiles | markers + own-settlement ring | yes, truncated | sprite + label |

Own settlement always carries a distinct ring at every zoom — "where am I" must never require
reading a name.

### 13.2 Map controls

Recentre-on-own-settlement, jump-to-coordinates, zoom stepper, and the КАРТА/СПИСОК toggle.
All in the bottom third; none in the top bar.

### 13.3 «СПИСОК» — the target list

**Decision: the Map tab has two views.** «СПИСОК» lists settlements sorted by Chebyshev
distance from the player's settlement: marker, name, owner, faction/side, distance in tiles,
and **scout travel time** computed from the same `travelTimeMs` the send preview uses. Tapping
a row centres the map on it and opens its sheet.

Rationale: a 61×61 world is ~5 phone screens wide; finding the fourth-nearest neighbour by
dragging is a chore, not a decision. The list turns target selection into something readable.
All of its data is already in `GET /api/map` — no new endpoint, no new server work.

**Rejected:** *map only* (exactly M2 §11 — most authentic, cheapest, and map-browsing is half
the social fun at 15 players; but it makes the M2 acceptance flow tedious); *map + name
search* (valuable with real friends, near-useless when 135 of 136 settlements are randomly
named NPCs — kept in §17 as a backlog item for M7); *mini-map* (answers "where am I", never
"who should I scout").

### 13.4 Tile sheets

| Tile | Contents | Actions |
|---|---|---|
| Other settlement | name, owner, faction, side, distance, + last-known intel (§14.4) | РАЗВЕДАТЬ, Отчёт |
| Own settlement | name, coordinates, queue summary | Перейти в базу |
| Oasis | type, coordinates, «Разведка недоступна» (M3) | — |
| Empty tile | terrain, coordinates | — (settling is M3) |

Everything shown is public by design (M2 §5: no fog of war). The sheet must never display a
field the server didn't send — and specifically must never let an NPC settlement be
distinguishable from a human one.

### 13.5 Movement markers

Own in-flight movements render as markers interpolated between origin and target from
`departAt`/`arriveAt` — the same `travelTimeMs` formula, run client-side against the server
clock. Outbound and returning are visually distinct. Tapping a marker opens Войска.
Only *own* movements: nobody can query anyone else's in M2, and incoming visibility is M3.

---

## 14. Scouting UX

### 14.1 Where scouts come from

Players build them (M2 §7): resources → Command Center 3 → Barracks → train. The UX
obligation is that this chain is *discoverable*, which is what ladder steps 4–6 of
«Следующий шаг» do.

### 14.2 The send flow

**Decision: the tile sheet expands in place; «ОТПРАВИТЬ» commits; recall is the undo.**

1. Tap tile → info sheet (public info + intel).
2. «РАЗВЕДАТЬ» → the *same* sheet grows into the send form: `[−] n [+]` bounded by scouts at
   home, live travel time, live arrival wall-clock.
3. «ОТПРАВИТЬ» → committed. No confirmation dialog.
4. The sheet becomes a status card: recall countdown, arrival countdown. The player stays on
   the map and watches the marker move.

**Rejected:** *full-screen send screen* (room to breathe and it scales to M3's unit mix — but
it drops the map context at the exact moment the player is thinking geographically; revisit
in M3 when the form genuinely outgrows a sheet); *explicit confirm dialog* (the stakes are
real — scouts cost resources and can die — but a per-send modal is dismissed blind within a
day, and the 90 s recall already covers the mistake); *jump to Войска after sending* (makes
the army screen the home of consequences, at the cost of yanking the player off the map).

### 14.3 Reading the outcome

Four outcomes, four distinct report layouts (§16.2). The **failure** report is not an error
state — it is a first-class outcome that must look deliberate, because M2 §8 chose to ship it
precisely so that silence doesn't read as a bug.

### 14.4 Intel persistence — the map remembers

**Decision: a scouted tile shows last-known intel with its age.** The tile sheet renders,
below the public card and visually separated: «Разведано 14 ч назад», the snapshot's key
figures (resources, troops, and buildings when the report carried them), dimmed as it ages,
plus «Отчёт» and «РАЗВЕДАТЬ СНОВА».

Rationale: scouting *compounds*. The map becomes a living intel layer instead of a phone
book, and stale data visibly asks to be refreshed — which is exactly the M3 raiding loop,
pre-built. Derived client-side from the reports the player already has; **no server change**,
provided reports carry the target settlement id and coordinates (§18.3).

**Rejected:** *reports-only* (cleanest separation, zero risk of a stale number on a live
surface — but intel never accumulates and every re-check is a trip to another tab); *marker +
link only* (avoids stale figures, but the map then remembers *that* you scouted, not *what*
you found — half the value for nearly the same work).

**Staleness rule:** intel is stamped with its capture time and always labelled with age. It is
never presented as current, never merged with the public card, and never used to disable or
enable an action.

---

## 15. Movement & training UX

### 15.1 Войска — the canonical army screen

Three sections, in this order:

1. **ДОМА** — troops at home by unit type with counts, and total Food upkeep per hour.
2. **ТРЕНИРОВКА** — the active training queue with per-unit countdowns (units are credited
   one at a time via chained events, so the list ticks down unit by unit) and a «Бараки ›»
   link back to the training action.
3. **В ПУТИ** — outbound and returning movements: target, direction, ETA countdown, and
   «Отозвать» while the 90 s window is open.

When the player has no scouts at home, the screen also carries the detection rule (§J7).

### 15.2 Training picker (Barracks sheet)

`[−] n [+]`, and three live consequences that update with the count: **batch cost**, **batch
time**, and **net Food after the batch**. The gate is absolute and includes the whole batch
(`wouldStarveWithTroops`) — the same rule as builds, so the block reason reads the same way.
A blocked picker names the blocker; it never merely greys out.

### 15.3 Timing conventions

- Remaining time is primary (`HH:MM:SS` via `formatDuration`); arrival/completion wall-clock
  is secondary and always shown for anything longer than ~10 minutes — a player planning a
  session needs "14:32", not "in 2:41:07".
- All countdowns anchor to the server clock (`serverTime` on every response), never
  `Date.now()`.
- Every countdown must **resolve** at zero — refetch, then reflect the real server state.
  This is M1's own logged lesson ("test time-driven UI at the boundary, not just the slope").

---

## 16. Reports UX

### 16.1 List

Newest first, cursor-paginated. Each row: outcome icon, target/attacker settlement name,
relative time, and unread emphasis. **Read-on-open.** The tab badge carries the unread count
and clears as reports are read. From M3, when raid/assault/trade reports multiply, the list
gains a type segment — designed for, not built now.

### 16.2 Detail — four layouts

| Outcome | Renders |
|---|---|
| **Scout success — base tier** | target resources, storage caps, troops at home, own losses |
| **Scout success — buildings tier** (Radio Tower diff ≥ 1) | the above + full building list with levels |
| **Scout failed** | «Разведчики не вернулись» — losses, no intel, and the reason it is empty |
| **Detected** (counter-report) | attacker settlement + owner, and explicitly *nothing* about what they learned |

Reports are **frozen snapshots**. The detail never re-fetches live state, never shows a
countdown, and always carries its capture timestamp — a report that quietly updated itself
would destroy the whole point of scouting.

### 16.3 Closing the loop

Every report detail ends with a destination: «На карту» (Map centred on the subject, sheet
open) and «Разведать снова» where legal. A report the player cannot act on is a dead end.

### 16.4 Server contract

The server ships **ids, numbers and keys — never prose** (M1 §15); the client renders all
copy. This is why the report payload must carry the target settlement id and coordinates
(§18.3): it is what makes both §14.4 and §16.3 possible without a second round trip.

---

## 17. Live feedback & the return-to-game moment

### 17.1 In-session events — toast + badge

**Decision: a brief non-blocking toast plus a persistent badge.**

| Event | Source | Toast |
|---|---|---|
| Report arrived | WS `reportArrived` (already in M2's scope) | «Пришёл отчёт разведки» → Отчёты |
| Build completed | client countdown → refetch (already shipped) | «Штаб ур.5 готов» → Base |
| Training completed | client countdown → refetch | «Разведчик обучен» → Войска |
| Scouts returned | client countdown → refetch | «Разведчики вернулись» → Войска |

Only report arrival needs a server push; the rest are already derivable from countdowns
anchored to the server clock, so this adds **no server scope**. The toast catches a player
who is looking; the badge catches one who wasn't. Neither ever blocks input, and errors caused
by the player's own tap are *never* toasts (§10).

**Rejected:** *badge only* (most respectful of a player mid-decision, but a scout returning —
the moment the whole M2 loop pays off — would pass unacknowledged); *toast only* (clean nav
bar, but anything arriving while the app is closed is never surfaced).

### 17.2 Returning after hours away

**Decision: no summary in M2.** The three questions a returning player has are already
answered in under a second by the model above: resource fill bars (am I capped or starving),
the queue strip plus «Следующий шаг» (is capacity idle, what now), and the Отчёты badge (did
anything arrive). A summary card in M2 could only ever say «1 постройка завершена».

**Revisit in M3**, when being raided in your sleep makes "what happened while I was away"
genuinely dramatic and worth its cost.

**Rejected:** *«Пока вас не было» card* (warm, and it makes idle progress feel earned — but
it needs server-side "last seen at" plus an event feed to be honest across devices, real scope
for a thin M2 payoff); *unified event log in Отчёты* (one place to answer "what happened",
but it dilutes the unread badge — in M3 a battle report and «Склад ур.7 готов» would compete
for the same attention).

---

## 18. Data dependencies this UX creates

None of these are game-design changes; they are fields the UX needs and the server already
knows. Listed so the M2b/M2c implementation can absorb them rather than discover them.

1. **`GET /api/map` must expose `world.startedAt`.** `World.startedAt` exists in the schema
   but `MapWorldView` omits it. The round chip «Д5·А1» cannot be computed without it. Adding
   a field to that view is backward-compatible.
2. **Settlement state must expose home troops** (`settlements.troops`, added in M2a.5) and the
   **training queue**, or Войска cannot render — and `game-core`'s troop-aware economy
   functions must be passed the real troop list, which is exactly what M2b's acceptance
   criterion ("training a scout makes Food upkeep visibly drop") proves.
3. **Report payloads must carry the target settlement id and its coordinates** (plus the
   attacker's, for counter-reports). Required by §14.4 (map intel) and §16.3 (return path).
4. **`GET /api/movements/mine` must carry** `type, status, from, target {x,y}, targetName,
   units, departAt, arriveAt`, so Войска can render the list and the Map can interpolate
   markers without a second call.
5. **Unread report count** must be cheaply available for the nav badge (the partial index on
   `{accountId, read}` is already planned in M2 §8).
6. **New i18n namespaces** `map`, `units`, `reports` (already reserved in M1 §15 / M2 §11),
   plus keys for the «Следующий шаг» ladder and every empty/blocked state named in §9.

---

## 19. Decisions made with the owner (2026-08-16)

All twelve accepted as recommended. Each is binding; each is expanded above with its
rationale and rejected alternatives.

| # | Decision | Section |
|---|---|---|
| 1 | **Base is spatial**, with a building-list sheet for dense comparison | §12.1 |
| 2 | **Landing screen is always Base** | §5.2 |
| 3 | **Only live nav tabs**, growing per milestone (M2: База/Карта/Войска/Отчёты, settings = gear) | §5.1 |
| 4 | **Resource bar = value + cap fill bar**, detail one tap deeper | §7.1 |
| 5 | **Map + «Рядом» distance-sorted list** for target discovery | §13.3 |
| 6 | **Войска is the canonical army screen**; Barracks stays the training entry point | §6, §15.1 |
| 7 | **Send flow expands in place; send commits; 90 s recall is the undo**; player stays on the map | §14.2 |
| 8 | **Rules-derived «Следующий шаг» line**, not a quest system or a first-launch overlay | §12.6 |
| 9 | **Round clock as a top-bar chip** «Д5·А1», tap for the timeline | §7.1 |
| 10 | **The map remembers intel**, with visible staleness | §14.4 |
| 11 | **Toast + persistent badge** for live events | §17.1 |
| 12 | **No return-summary in M2**; revisit in M3 | §17.2 |

---

## 20. Required amendments to existing records

This document supersedes four points. They must be amended at the source, per the project's
own convention (M2 §15 did the same to the plan) — not silently diverged from.

1. **`M2_DESIGN_DECISIONS.md` §11, "Interactions":** "Own in-flight movements appear as an
   overlay list on the Map tab" → the **canonical list moves to the Войска tab** (with
   recall); the Map keeps *spatial* movement markers only. Reason: the 90 s recall window
   must be reachable from anywhere, and M3's 15 unit types would force this screen anyway.
2. **`M2_DESIGN_DECISIONS.md` §11, "Navigation":** "the Map tab activates; the Reports tab
   activates" → **three tabs activate in M2c: Карта, Войска, Отчёты**, and the remaining
   disabled tabs are removed from the bar until their milestone.
3. **`M2_DESIGN_DECISIONS.md` §11, "Tile art":** "flat placeholders… slicing stays in M6" →
   **the slicing has already happened** (~100 sprites in `apps/web/public/assets/` with a
   manifest). The premise of that decision is gone; M2c should use the real tile, marker and
   building sprites. *Note: `apps/web/public/` is currently untracked, and
   `apps/web/public/_preview.html` fails `pnpm format:check` — both need resolving before the
   next commit or CI will fail.*
4. **`IMPLEMENTATION_PLAN.md` §3.5:** "UI follows the pixel-art mockup (top resource bar,
   left/bottom nav: Map, Base, Units, Market, Reports, Side, Settings)" → the left rail is a
   desktop artifact of the art board and is dropped; the nav is **bottom-only and
   milestone-gated** (§5.1). `art/reference/mockup_ui_pixel.png` remains binding for *style*,
   not for layout.

**Scheduling question for the owner (not a design question):** decision #1 makes the spatial
base a change to M2c's scope, on top of the three new tabs. Either is defensible —
(a) M2c ships the full model including the spatial base, since the art exists; or (b) M2c
ships the structure (nav, top bar, map, scouting, Войска, Отчёты) against the existing list
base, and the spatial base lands in M6's visual pass. This document is agnostic; both paths
reach the same end state.

---

## 21. Open design questions

Genuinely unresolved. None blocks M2c's structure.

| # | Question | Needed by |
|---|---|---|
| 1 | **Zoom-step behaviour on the map:** does 0.5× overview drop terrain art for flat tints (fast, legible density) or keep it (pretty, busy)? Needs to be seen at 402 px before deciding. | M2c |
| 2 | **Building sprite levels:** do buildings visibly change with level (Travian does at thresholds)? The art set has one sprite per building. Cheap fallback: a level badge on the sprite. | M6 |
| 3 | **Report retention UI:** reports live for the round (M2 §8). Does the player get delete/archive, or is the list simply append-only for 21 days? | M3 |
| 4 | **Name search on the map** — parked until M7, when real friends make names meaningful. | M7 |
| 5 | **Confirmation policy for irreversible acts** (sending an army to certain death, switching sides and zeroing contribution). §8 defers this deliberately. | M3 / M5 |
| 6 | **Incoming-attack surface** — persistent chrome (a danger strip) vs a Войска section vs a badge. M2 §8 defers the whole surface to M3 by design; it will need its own round of questions. | M3 |
| 7 | **Landscape and tablet** — tolerated, not designed. Worth one pass in M6. | M6 |

---

## 22. UX principles for future design

The rules this document was written by. New screens are checked against them, and a screen
that fails one is redesigned rather than annotated.

1. **One question per screen.** If describing a screen takes two sentences, it is two screens.
2. **One canonical home per concept.** Contextual entry points link into it; they never
   duplicate it.
3. **Undo beats confirm.** Reach for a modal only when the mechanics offer no reversal.
4. **Every action ends somewhere useful.** Name the next destination before building the
   action.
5. **Blocked states name the blocker and the fix.** A disabled control that doesn't say why is
   a bug.
6. **Guidance is derived, never authored.** A rule that reads live state cannot go stale.
7. **Persistent means "needed on every screen".** Everything else is contextual or on demand.
   Vertical space is the scarcest resource in the game (§11.4).
8. **The server ships keys and numbers; the client renders prose.** No exceptions (M1 §15).
9. **Time is server time.** Every countdown anchors to `serverTime`, and every countdown must
   resolve at zero.
10. **Never leak what the game hides.** NPCs are indistinguishable; internals need scouting;
    a client must not infer what the server declined to send.
11. **Empty states teach.** Each states the rule that makes it empty, then the fix, then a
    link.
12. **Don't solve ambiguity with more UI.** More panels, borders, labels and badges are the
    symptom, not the cure. Cut information or split the surface instead.
