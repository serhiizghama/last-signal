# Last Signal

![CI](https://github.com/serhiizghama/last-signal/actions/workflows/ci.yml/badge.svg)

A mobile-first, Russian-language browser strategy game inspired by classic Travian, re-themed
as post-apocalyptic. Players — and indistinguishable NPCs — develop settlements, raid each
other, and pick one of two global sides, **Beacon** or **Silence**, to fight over the
**Signal Source** at the centre of a 61×61 map during a three-week seasonal round. No
monetization.

## Tech stack

- **pnpm TypeScript monorepo**
- **NestJS** — API server
- **React 18 + Vite** — web client
- A shared, pure **`game-core`** package: every game formula (economy, movement, combat)
  lives here, imported by both server and web so their logic can never drift.
- **MongoDB 7+** (single-node replica set) — multi-document transactions for multi-step
  flows; a custom `events` collection acts as the scheduler.
- Deployed with **pm2** + **Caddy** on a single VPS.

## Repository layout

```
last-signal/
├── apps/
│   ├── server/          # NestJS API
│   └── web/              # React + Vite client
├── packages/
│   └── game-core/        # Pure, deterministic game formulas/types shared by server and web
├── tools/                 # Standalone scripts (asset pipeline, balance simulator)
├── docs/                  # Design plan, progress log, asset prompts
└── art/                   # Reference mockups and generated art sheets
```

All game formulas live in `game-core`; both `server` and `web` import them, so they can
never drift out of sync.

## Getting started

**Prerequisites:** Node.js >= 22, pnpm 10, Docker (for local MongoDB).

```bash
pnpm install
cp apps/server/.env.example apps/server/.env
docker compose up -d
```

`docker compose up -d` starts a single-node MongoDB 7 replica set on host port 27117
(not the default 27017, to avoid clashing with other local containers). The server
fails fast at boot if it can't reach Mongo, so this has to be up before `pnpm dev`.

Run both dev servers together:

```bash
pnpm dev
```

Or run them individually:

```bash
pnpm --filter @last-signal/server dev
pnpm --filter @last-signal/web dev
```

The web app runs at http://localhost:5173 and proxies `/api` requests to the server on
port 3000.

## API

- `GET /api/health` — liveness check.
- `POST /api/auth/guest` — guest login; sets the httpOnly session cookie.
- `GET /api/auth/me` — the current account, or `401` when not authenticated.
- `POST /api/auth/logout` — revokes the session server-side and clears the cookie.
- `POST /api/accounts/register` — claims a name and a faction (and optionally a side).
- `POST /api/settlements` — founds the account's settlement at a deterministic outer-ring tile.
- `GET /api/settlements/mine` — the authenticated account's settlements.
- `GET /api/settlements/:id` — current settlement state (buildings, resources, build
  queue, troops, training queue), settling lazy resource accrual up to the request time
  first.
- `POST /api/settlements/:id/build` — enqueue a building level (`{ "type": "<buildingType>" }`).
- `POST /api/settlements/:id/build/:queueItemId/cancel` — cancel a queued/active build,
  refunding its cost in full.
- `POST /api/settlements/:id/train` — enqueue a scout-training order
  (`{ "unitType": "<yourFaction'sScout>", "count": <positive integer> }`; must be your own
  faction's scout, one active order per settlement, no cancel). Deducts the whole batch's
  cost up front; units complete and are credited to `troops` one at a time via chained
  events, each consuming Food upkeep from the moment it's credited.
- `GET /api/map` — the world header (seed, round, act) plus every settlement's public info
  only (coordinates, name, owner name/faction/side) and every oasis (coordinates, type); no
  terrain (derived client-side from the seed) and no internals — resources, buildings, troops —
  those need scouting (M2b).
- `POST /api/movements` — send a scout movement
  (`{ "type": "scout", "fromSettlementId": "...", "target": { "x": <int>, "y": <int> },
"units": [{ "unitType": "<yourFaction'sScout>", "count": <positive integer> }] }`). M2 ships
  exactly one movement type; the target must be another account's settlement (not your own,
  not an oasis). Departs immediately (no rally-point building); travel time is Chebyshev
  distance over the slowest unit's speed. Deducts the sent units from `troops` up front.
- `POST /api/movements/:id/cancel` — recall an `outbound` movement within the configured
  cancel window (draft 90s) after send; turns it around to head straight home. Rejected once
  the window has passed or the movement has already progressed past `outbound`.
- `GET /api/movements/mine` — the authenticated account's own movements only (no visibility
  into anyone else's incoming/outgoing movements in M2), server time included for client-side
  countdowns.

Scout movements resolve scout-vs-scout combat at arrival (Kirilloid-style casualty curve,
defender scouts never die on defence) and write reports into the `reports` collection: the
attacker always gets one (`scout` with intel, or `scoutFailed` with none — including the
defended-but-impossible "target no longer exists" case), and the defender gets a
`scoutDetected` counter-report iff they had at least one scout home at arrival. Intel depth
depends on the Radio Tower level differential: resources/storage caps/troop counts always,
the full building list once the attacker's tower is far enough ahead.

- `GET /api/reports` — the caller's own inbox, newest first, cursor-paginated
  (`?cursor=<opaque>&limit=<1..100, default 20>`): `{ reports, nextCursor, unreadCount,
serverTime }`. `nextCursor` is `null` once there's nothing older left. Every report's
  `payload` is structured ids/numbers exactly as written by the report's producer (e.g.
  `movements/handlers/movement-arrive.handler.ts`) — the client renders prose from it, never
  the server.
- `GET /api/reports/:id` — a single report, ownership-checked (404, not 403, for another
  account's report id — same "don't leak existence" convention as every other resource here).
  Read-on-open: fetching it is what marks it `read`; a repeat fetch is a no-op. There is no
  separate mark-read endpoint.
- `POST /api/dev/seed-settlement` — creates a guest account + a settlement (through the real
  placement path) for local testing. Dev-only: returns 404 once `NODE_ENV=production`.
- `POST /api/dev/world/regenerate` — wipes the world and every oasis and bootstraps a fresh
  one (optional `{ "seed": "..." }` body), returning the new seed and oasis count. Dev-only:
  returns 404 once `NODE_ENV=production`. Never touches accounts/settlements.

Every settlement endpoint is ownership-checked: another account's settlement answers `404`,
not `403`, so existence is never leaked. Errors carry i18n keys (`{ key, params }`), never prose.

### Realtime (WebSocket)

A socket.io gateway runs in the same NestJS process, mounted at `/ws` (not socket.io's default
`/socket.io` — matches the ops plan's `/api` + `/ws` Caddy split). The handshake authenticates
from the same session cookie the REST API uses (no second auth mechanism): a connection with
no cookie, or one that doesn't resolve to a live session, is rejected before `connect` ever
fires (the client only ever sees `connect_error`). Every authenticated socket joins a
per-account room, so a push reaches every tab/socket that account has open. CORS mirrors the
REST API's `CORS_ORIGINS` exactly, with credentials.

Events:

- `reportArrived` — pushed to the report's own account the moment a new report is durably
  written (attacker always, defender additionally when detected — §8). Payload is minimal:
  `{ id, type, createdAt }`, enough to invalidate a reports query/badge; the client fetches
  the full report via `GET /api/reports/:id`. Emitted from a MongoDB change stream on the
  `reports` collection rather than from the report-writing code directly, specifically so the
  push can never arrive before the write is committed and visible to a subsequent read — see
  `apps/server/src/reports/reports-realtime.publisher.ts`'s own comment for why.
- `incoming attack` / `queue done` / `world/act changed` — named in the design plan (§3.4) as
  future pushes through this same gateway; nothing in M2 produces them yet.

All command mutations (build, train, movement send/cancel, and their scheduled-event
handlers) run under the transaction + version-guard concurrency pattern described in
[`docs/CONCURRENCY_PLAYBOOK.md`](docs/CONCURRENCY_PLAYBOOK.md).

## Scripts

Run from the repo root:

| Script              | Description                                                            |
| ------------------- | ---------------------------------------------------------------------- |
| `pnpm dev`          | Build `game-core`, then run the server and web dev servers in parallel |
| `pnpm lint`         | Lint the whole monorepo with ESLint                                    |
| `pnpm lint:fix`     | Lint and auto-fix                                                      |
| `pnpm format`       | Format the whole monorepo with Prettier                                |
| `pnpm format:check` | Check formatting without writing                                       |
| `pnpm typecheck`    | Type-check every package                                               |
| `pnpm test`         | Run every package's test suite                                         |
| `pnpm build`        | Build every package                                                    |
| `pnpm clean`        | Remove every package's `dist` directory                                |

## Project status

**M0 — scaffold — complete.** Monorepo, NestJS server, Vite web client, and `game-core`
are wired together with a shared lint/format/typecheck/test/build pipeline and CI.

**M1 — Economy core — complete** (M1a + M1b + M1c):

- **M1a — Economy foundations.** All 13 buildings' formulas in `game-core` behind an
  injectable config, MongoDB 7 single-node replica set (schemas, indexes, transactions), the
  `events` scheduler (claim/lease/sweep, retry → dead-letter, `dueAt`-order replay), and the
  build command flow (enqueue/cancel/complete, transaction + version-guarded writes,
  idempotent completion) — see [`docs/CONCURRENCY_PLAYBOOK.md`](docs/CONCURRENCY_PLAYBOOK.md)
  for the pattern every future command copies.
- **M1b — Auth & account lifecycle.** Guest auth over revocable, Mongo-backed sessions in an
  httpOnly cookie, registration with faction choice, and settlement creation at a
  deterministic outer-ring tile on the 61×61 grid. Telegram Login sits behind the same
  interface as a stub until M7.
- **M1c — Base screen & i18n.** The mobile-first base screen — live resource bar, building
  list, 3-slot build queue with countdowns and cancel — plus the i18next scaffold with RU as
  the shipped locale and every string behind a key.

Next: **M2 — Map & movement.**

Milestones: M0 scaffold · M1 economy core · M2 map & movement · M3 combat · M4 NPCs ·
M5 sides & endgame · M6 visual polish · M7 launch round.

See [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) for the design source of
truth and [`docs/PROGRESS.md`](docs/PROGRESS.md) for the running build log.
