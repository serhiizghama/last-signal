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
- **MongoDB**, kept 3.6-compatible — no multi-document transactions; single-document atomic
  operations and a custom `events` collection act as the scheduler.
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

**Prerequisites:** Node.js >= 22, pnpm 10.

```bash
pnpm install
cp apps/server/.env.example apps/server/.env
```

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

**M0 — scaffold.** Monorepo, NestJS server, Vite web client, and `game-core` are wired
together with a shared lint/format/typecheck/test/build pipeline and CI.

Milestones: M0 scaffold · M1 economy core · M2 map & movement · M3 combat · M4 NPCs ·
M5 sides & endgame · M6 visual polish · M7 launch round.

See [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) for the design source of
truth and [`docs/PROGRESS.md`](docs/PROGRESS.md) for the running build log.
