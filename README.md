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
- `GET /api/settlements/:id` — current settlement state (buildings, resources, build
  queue), settling lazy resource accrual up to the request time first.
- `POST /api/settlements/:id/build` — enqueue a building level (`{ "type": "<buildingType>" }`).
- `POST /api/settlements/:id/build/:queueItemId/cancel` — cancel a queued/active build,
  refunding its cost in full.
- `POST /api/dev/seed-settlement` — creates a guest account + a level-1 Command Center
  settlement for local testing. Dev-only: returns 404 once `NODE_ENV=production`. Stands
  in for real registration until M1b ships guest auth.

All build-command mutations run under the transaction + version-guard concurrency pattern
described in [`docs/CONCURRENCY_PLAYBOOK.md`](docs/CONCURRENCY_PLAYBOOK.md).

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

**M1a — Economy foundations — complete.** MongoDB 7 single-node replica set (schemas,
indexes, transactions), the `events` scheduler (claim/lease/sweep, retry → dead-letter,
`dueAt`-order replay), and the build command flow (enqueue/cancel a building level through
`/api/settlements`, transaction + version-guarded writes, idempotent completion handling)
are implemented and tested — see [`docs/CONCURRENCY_PLAYBOOK.md`](docs/CONCURRENCY_PLAYBOOK.md)
for how. UI for it lands in M1c.

Milestones: M0 scaffold · M1 economy core · M2 map & movement · M3 combat · M4 NPCs ·
M5 sides & endgame · M6 visual polish · M7 launch round.

See [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) for the design source of
truth and [`docs/PROGRESS.md`](docs/PROGRESS.md) for the running build log.
