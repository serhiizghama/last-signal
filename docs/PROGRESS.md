# Last Signal — Progress Log

Single running log of what has actually been built and verified. Maintained by the
orchestrator. Nothing is written here without a green check executed in-session.

Source of truth for design: `docs/IMPLEMENTATION_PLAN.md`.

---

## Current position

**Milestone: M0 — Scaffold — ✅ COMPLETE**, awaiting the user's personal review before M1
(Economy core) starts. Full milestone summary at the bottom of this file.

### M0 decomposition

| Step | Scope | Status |
|---|---|---|
| M0.1 | Workspace foundation: pnpm workspaces, TS base config, ESLint 9 + Prettier, Vitest, root scripts, `packages/game-core` skeleton | ✅ verified |
| M0.2 | `apps/server`: NestJS app, `/api/health`, config, imports `game-core`, tests | ✅ verified |
| M0.3 | `apps/web`: React 18 + Vite, mobile-first shell, calls `/api/health` via dev proxy, imports `game-core`, tests | ✅ verified |
| M0.4 | GitHub Actions CI, README, dev ergonomics, small cleanups | ✅ verified (after 1 fix round) |

### Environment (this machine)

- Node v24.11.1, pnpm 10.29.2, Docker 29.4.0 available.
- `gh` CLI is **not** installed → GitHub Actions workflows are validated by config
  review plus running the exact same commands locally, not by an actual remote CI run.

---

## Technical decisions (orchestrator-level, non-design)

Recorded here as required by the orchestrator brief. None of these touch game design.

- **Node 22+ / pnpm 10**, `packageManager` pinned in the root `package.json`.
- **Vitest everywhere** (server included) instead of Jest for the server. The plan allows
  "Vitest/Jest"; one runner across all three packages keeps config, CI and DX uniform.
- **`game-core` is built with `tsup`** to dual ESM + CJS + `.d.ts`. Reason: NestJS builds
  to CommonJS while Vite consumes ESM; a dual build removes all interop friction with a
  single dev dependency and no runtime cost.
- **NestJS stays on its default CommonJS build** (`nest build`) — friendliest to pm2 on
  the VPS.
- Package scope: `@last-signal/*`. Server on port 3000 (API prefix `/api`), web dev
  server on 5173 proxying `/api` → 3000.
- No MongoDB anywhere in M0 — the scaffold must boot with zero infrastructure. MongoDB 7+
  (transactions available) enters in M1.
- **TypeScript pinned to `^5.9.3`, deliberately not the latest major.** TS 7 is published,
  but `typescript-eslint@8` declares a peer range of `>=4.8.4 <6.1.0`, so TS 7 produces an
  unmet-peer warning and would eventually break `lint`/`typecheck`. Revisit once
  typescript-eslint supports TS 7.
- **`apps/server` Vitest config is `vitest.config.mts`, not `.ts`.** The package is CommonJS
  (no `"type": "module"`), so a `.ts` config gets loaded as CJS and Vite warns about ESM
  syntax. The `.mts` extension forces ESM parsing. Do not "normalise" this to `.ts`.

---

## Log

<!-- Newest entries at the bottom. -->

### M0.1 — Workspace foundation ✅

**What was done.** pnpm workspace (`apps/*`, `packages/*`, `tools/*`), shared
`tsconfig.base.json` (strict + `noUncheckedIndexedAccess`), ESLint 9 flat config with
typescript-eslint and `eslint-config-prettier`, Prettier, `.editorconfig`, `.nvmrc`, and
root scripts `lint / lint:fix / format / format:check / typecheck / test / build`.
`packages/game-core` created as a dual ESM+CJS tsup build with pure time helpers
(`msUntil`, `secondsUntil`, `formatDuration`), the `RESOURCE_KINDS` / `Resources` types
and a version constant — all clock-free (time is always passed in as an argument).

**Files touched.** `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`,
`tsconfig.base.json`, `eslint.config.js`, `.prettierrc.json`, `.prettierignore`,
`.editorconfig`, `.nvmrc`, `packages/game-core/**` (package.json, tsconfig.json,
tsup.config.ts, vitest.config.ts, src/{index,version,time,types}.ts + 3 test files),
`README.md` (trailing newline only, from `prettier --write`).

**Verification — actually executed by the orchestrator, not the subagent:**

- `pnpm lint` → exit 0, 0 errors / 0 warnings.
- `pnpm typecheck` → `tsc --noEmit` clean.
- `pnpm test` → Vitest 4.1.10, **3 files / 18 tests passed**, 95 ms.
- `pnpm format:check` → "All matched files use Prettier code style!".
- `pnpm build` (after `rm -rf dist`) → emits `index.js`, `index.cjs`, `index.d.ts`,
  `index.d.cts` + sourcemaps.
- **Anti-false-green checks:** listed the files ESLint actually inspects (all 7
  `game-core` `.ts` sources + configs — the flat-config "green because it lints nothing"
  trap is not present), and probed with a deliberate `any` + unused variable, which
  correctly failed with `@typescript-eslint/no-explicit-any` and `no-unused-vars`. Probe
  file deleted afterwards.

**Notes / debt carried forward:**

- `tsconfig.base.json` uses `moduleResolution: "Bundler"`. The NestJS app must override
  this (`module: CommonJS` + `moduleResolution: Node16/Node10`) or TS raises TS5095 —
  passed as an explicit constraint into step M0.2.
- `tsup.config.ts` and `vitest.config.ts` sit outside `include: ["src"]`, so they are
  linted but not typechecked. Accepted as-is; not worth a second tsconfig yet.

### M0.2 — `apps/server` (NestJS) ✅

**What was done.** NestJS 11 app (`@last-signal/server`, CommonJS, `nest build`) with
`ConfigModule.forRoot({ isGlobal: true })`, global `/api` prefix, global `ValidationPipe`
(`whitelist`, `transform`), CORS for the Vite dev origin, and `PORT`/`HOST` from env.
`GET /api/health` returns `{ status, serverTime, uptimeMs, version, gameCoreVersion }`,
where `gameCoreVersion` is imported from `@last-signal/game-core` — that field is what
proves the workspace wiring end to end. `serverTime` is plain epoch ms so the client can
run countdowns locally against it. Unit test + supertest integration test.

**Files touched.** `apps/server/**` — `package.json`, `tsconfig.json`,
`tsconfig.build.json`, `nest-cli.json`, `.env.example` (placeholders only),
`src/main.ts`, `src/app.module.ts`, `src/health/{health.module,health.controller,health.service}.ts`,
`src/health/{health.service,health.integration}.spec.ts`. Plus `pnpm-lock.yaml`.

**Verification — actually executed by the orchestrator:**

- `pnpm lint` → exit 0, clean. `pnpm format:check` → clean.
- `pnpm typecheck` → both packages `Done` (game-core + server).
- `pnpm test` → game-core 18/18 **and** server 3/3 across 2 files.
- `pnpm build` after `rm -rf` of both `dist/` dirs → topological order respected
  (game-core built first), `apps/server/dist/main.js` emitted.
- Build output audited: `dist/` contains **no** `.spec.js` files (`tsconfig.build.json`
  excludes them) — 10 files, all production.
- **Runtime smoke check (real process, real HTTP):** started `node apps/server/dist/main.js`,
  then:
  - `GET /api/health` → `HTTP/1.1 200 OK`,
    body `{"status":"ok","serverTime":1786788791847,"uptimeMs":2863.37,"version":"0.0.0","gameCoreVersion":"0.0.0"}`,
    with `Access-Control-Allow-Origin: http://localhost:5173`;
  - `GET /health` (no prefix) → `404` as required;
  - Nest log confirms `Mapped {/api/health, GET}` and `Server listening on http://0.0.0.0:3000/api`.
  - Process killed; port 3000 confirmed free afterwards.

**Deviations from the brief (reviewed and accepted):**

- `class-validator` + `class-transformer` were added. Not in the approved list, but
  `ValidationPipe` genuinely needs them the moment the first DTO lands in M1. Accepted.
- No `apps/server/vitest.config.ts` was created; tests are discovered by Vitest defaults
  and do pass. Folded into M0.4 as a consistency cleanup.
- DI uses an explicit `@Inject(HealthService)` token rather than relying on
  `emitDecoratorMetadata`, so Vitest's esbuild transform works without pulling in SWC.
  Good call — it avoided an extra toolchain dependency.

**Debt logged (deliberately not fixed now):**

- CORS origin is hardcoded to `http://localhost:5173`; should become config-driven before
  deploy (in production Caddy serves web and API from one origin, so it is harmless today).
- `version` reads `process.env.npm_package_version`, which is unset under pm2's
  `node dist/main.js` — it silently falls back to `'0.0.0'`. Needs a real source later.
- `uptimeMs` is fractional (`performance.now()` delta); should be rounded for an API.

### M0.3 — `apps/web` (React 18 + Vite) ✅

**What was done.** Mobile-first React 18 + Vite + TS app (`@last-signal/web`). A `useHealth()`
hook fetches the **relative** path `/api/health` (never a hardcoded origin, so the same code
works behind Caddy in production) with `AbortController` cleanup and a discriminated-union
state (`loading | ok | error`). The shell renders the title, a connection badge, a resource
bar mapped over `RESOURCE_KINDS` **from game-core** (not a local array), the server's
`gameCoreVersion`, and a live 1 Hz countdown rendered with game-core's `formatDuration` +
`msUntil`. Styling is a single `styles.css` using the art-direction palette tokens
(`--bg-deep #16100B`, `--panel #2A211A`, `--accent #D9772F`, `--bone #E8D9B0`, …); `index.html`
is `lang="ru"` with `theme-color`. No Zustand / TanStack Query / i18next / router yet — those
land in M1 with real screens.

**Files touched.** `apps/web/**` — `package.json`, `tsconfig.json`, `vite.config.ts`
(Vite + Vitest merged, proxy `/api` → `:3000`, `happy-dom`), `index.html`,
`src/{main.tsx,App.tsx,useHealth.ts,styles.css,setupTests.ts}`,
`src/{App.test.tsx,useHealth.test.ts}`. Plus `pnpm-lock.yaml`.

**Verification — actually executed by the orchestrator:**

- `pnpm lint` → clean. `pnpm format:check` → clean.
- `pnpm typecheck` → all three packages `Done`.
- `pnpm test` → game-core 18/18, server 3/3, **web 9/9 across 2 files** (fetch is mocked;
  no test touches the network).
- `pnpm build` after wiping all three `dist/` dirs → game-core → server → web in topological
  order; web emits `dist/index.html` + hashed CSS/JS (**143.24 kB JS, 47.01 kB gzip**).
- **Runtime smoke check (two real processes):** started the built Nest server and the Vite
  dev server, then `curl http://localhost:5173/api/health` → `HTTP/1.1 200` returning the
  Nest JSON — proving the **proxy** works, not just the API; `curl http://localhost:5173/`
  returned the app shell.
- **Real browser check (Chrome, 414×896 mobile viewport):** the app mounts and renders
  `ОНЛАЙН`, all four resources, `Версия ядра: 0.0.0`, and a countdown that visibly ticked
  `00:57 → 00:41` across observations — i.e. the client is genuinely running game-core's
  formulas against the server's clock. No console errors or warnings.
- **Error path verified live:** killed the API process and reloaded — the UI switched to the
  red `НЕТ СВЯЗИ` badge and `Ошибка соединения: Сервер ответил статусом 502`.
- All processes killed; ports 3000 and 5173 confirmed free; browser tab closed.

**Notable improvement over the brief (accepted).** `useCountdown` anchors on
`performance.now()` and derives "now" as `serverTime + elapsed monotonic time`, so the
countdown follows the *server's* notion of time and is immune to browser wall-clock drift or
adjustment. That is exactly the behaviour the plan wants for build queues and troop
movements, so it should be kept and generalised in M1.

**Debt logged:**

- UI strings (`Металлолом`, `Онлайн`, …) are hardcoded in `App.tsx`. The plan requires all
  strings behind i18n keys with RU as default — M1 must move them into the i18n scaffold.
- Resource values in the bar are placeholders; real state arrives with the M1 game-state API.

### M0.4 — CI, README, cleanups ✅ (required one fix round)

**What was done.** GitHub Actions workflow `.github/workflows/ci.yml` (push + PR to `main`,
single `ubuntu-latest` job, `concurrency` cancel-in-progress, `permissions: contents: read`;
steps: checkout → `pnpm/action-setup@v4` (10.29.2) → `setup-node@v4` (node 22, pnpm cache) →
`install --frozen-lockfile` → `format:check` → `lint` → `typecheck` → `test` → `build`).
A real English README (pitch, CI badge, stack, layout, getting started, scripts table,
milestone status). Root `dev` and `clean` scripts — `dev` uses pnpm's native `--parallel`,
so **no process-manager dependency was added**. Server Vitest config finalised in
`apps/server/vitest.config.mts` (`include: ['src/**/*.spec.ts']`, `environment: 'node'`,
`globals: false`) — NestJS uses `.spec.ts` while the other packages use `.test.ts`, and the
`.mts` extension is deliberate: `apps/server` has no `"type": "module"`, so a plain `.ts`
config is loaded as CommonJS and Vite warns about ESM syntax. `uptimeMs` is now
`Math.round(...)`.

**Files touched.** `.github/workflows/ci.yml`, `README.md`, root `package.json`,
`apps/server/vitest.config.mts`, `apps/server/src/health/health.service.ts` (+ its spec).

#### ⚠ Defect found during verification and fixed (worth remembering)

The first delivery of this step **would have failed CI on the very first run**. Because
`game-core` is consumed through its built `dist/` (its `exports`/`types` point there), and
the CI order is `typecheck` → `test` → `build`, nothing built `game-core` before `typecheck`.
On a clean checkout:

```
$ pnpm typecheck
apps/server typecheck: src/health/health.service.ts(3,35): error TS2307:
  Cannot find module '@last-signal/game-core' or its corresponding type declarations.
$ pnpm test
apps/server test:  Test Files  2 failed (2) / Tests  no tests
```

It only looked green locally because stale `dist/` directories were lying around from the
earlier steps. Caught by running `pnpm clean` before re-verifying — a habit worth keeping
for every future milestone.

**Fix (verified):** a root `prepare` script (`pnpm --filter @last-signal/game-core build`)
that pnpm runs automatically after `pnpm install` — covering the fresh-clone/CI path — plus
`typecheck` and `test` now invoking `pnpm run prepare` first, so they are order-independent
even after `pnpm clean`. Rejected alternative: TypeScript `paths` aliases to `game-core/src`,
which would make typecheck/test resolve different files than the real build — precisely the
drift the architecture forbids.

**Verification — actually executed by the orchestrator:**

- **Clean-tree sequence** (`pnpm clean` before each): `typecheck` → all three `Done`;
  `test` → 18 + 3 + 9 = **30 passed**; `build` → all three emit artifacts.
- **Cold CI simulation** — `rm -rf node_modules apps/*/node_modules packages/*/node_modules`
  and all `dist`, then `pnpm install --frozen-lockfile` (lockfile accepted, no regeneration;
  the `prepare` hook visibly ran and built game-core), then the workflow's exact step order:
  `format:check` → `lint` → `typecheck` → `test` (30 passed) → `build`, **all green**.
- CI workflow parsed as YAML (via `js-yaml`) — structure, triggers and step order confirmed;
  `pnpm/action-setup` correctly precedes `setup-node` with `cache: 'pnpm'`.
- **`pnpm dev` smoke check:** booted both dev servers in parallel; `http://localhost:5173/`
  → 200 and `http://localhost:5173/api/health` → `{"status":"ok",...,"uptimeMs":15963,...}` —
  which also confirms the `uptimeMs` rounding fix at runtime. Processes killed, ports free.
- Final gate after `pnpm clean`: format:check ✔ lint ✔ typecheck ✔ test ✔ build ✔.

#### ⚠ Second defect — caused by the orchestrator, found and fixed

While checking whether `apps/server` had a Vitest config, the orchestrator ran
`cat apps/server/vitest.config.ts`, got "No such file", and concluded none existed. In fact
`apps/server/vitest.config.mts` had been there since M0.2. Acting on that wrong premise, a
subagent was told to create `vitest.config.ts` — producing **two Vitest configs in one
package**, where the new `.ts` shadowed the `.mts` and made every server test run print:

```
(!) Your Vite config uses features that are unsupported by `configLoader: 'native'` ...
  - ESM syntax in a file loaded as CommonJS (vitest.config.ts:1:1)
```

Compounding it, the first subagent given this task was recorded as having "stalled". It had
not: it detected the pre-existing `.mts`, correctly refused to create a conflicting second
config, and **asked for direction** — its messages simply had not been delivered yet. That
judgement call was right and prevented a worse outcome.

**Resolution (verified):** deleted `vitest.config.ts`, folded `globals: false` and an
explanatory comment into `vitest.config.mts`. Confirmed afterwards that
`pnpm --filter @last-signal/server test` passes 2 files / 3 tests **with the warning gone**,
that exactly one Vitest config remains in the package, and that the full gate
(format:check / lint / typecheck / test 30 / build) is green from a `pnpm clean` tree.

**Lessons for future milestones:**

1. Probe for a file by **glob** (`ls vitest.config.*`), never by guessing one extension.
2. Silence from a subagent is not failure — check for a blocking question before assuming a
   stall and dispatching a replacement.
3. Verify the *absence* of warnings, not just exit codes: this defect passed every green
   check and was only visible in stdout.

No work was accepted on the basis of a subagent's report alone.

**Known warning (not blocking):** `pnpm install` prints
`Ignored build scripts: esbuild@0.27.7` (pnpm 10 blocks dependency build scripts by default).
Everything builds and tests fine because esbuild ships its platform binary as an optional
dependency. If CI ever misbehaves around esbuild, add `onlyBuiltDependencies: ['esbuild']`
to `pnpm-workspace.yaml`.

---

## ✅ Milestone M0 — Scaffold: COMPLETE (awaiting user review)

**What was built.** A pnpm TypeScript monorepo with three wired packages:

| Package | What it is |
|---|---|
| `packages/game-core` | Pure, deterministic, clock-free formula package (dual ESM+CJS via tsup). 18 tests. |
| `apps/server` | NestJS 11, port 3000, prefix `/api`, `GET /api/health`. 3 tests. |
| `apps/web` | React 18 + Vite 8, mobile-first shell on 5173, proxies `/api` → 3000. 9 tests. |

Shared toolchain: ESLint 9 flat config + Prettier + Vitest across all packages, root
`lint / format / typecheck / test / build / dev / clean` scripts, and GitHub Actions CI.

**How it was verified (every check run in-session by the orchestrator, not trusted from
subagent reports):**

- `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (**30 tests**), `pnpm build`
  — all green, including from a wiped `node_modules` + `dist` cold start using
  `--frozen-lockfile`, which is the exact sequence CI will run.
- ESLint proven to actually inspect the `.ts` sources and to actually fail on a planted
  `any` + unused variable (guarding against a green-because-it-lints-nothing config).
- Server runtime: real process, `GET /api/health` → 200 with `gameCoreVersion` sourced from
  `game-core`; `/health` without the prefix → 404.
- Web runtime in **real Chrome at a 414×896 mobile viewport**: app mounts, shows `ОНЛАЙН`,
  the four resources from `RESOURCE_KINDS`, the core version, and a countdown that visibly
  ticked `00:57 → 00:41` using game-core's `formatDuration`/`msUntil` against the server's
  clock. No console errors. Killing the API flipped the UI to `НЕТ СВЯЗИ` /
  `Ошибка соединения: Сервер ответил статусом 502`.
- Vite proxy proven end to end (`curl :5173/api/health` returns the Nest JSON).

**M0 acceptance criteria from the plan** — *"CI green, dev servers boot, web calls API"*:
CI config validated and its exact command chain passes locally from a cold start (no remote
run is possible — `gh` is not installed and nothing has been pushed); `pnpm dev` boots both
servers; the web app calls the API through the proxy and renders the result. ✅

**Known gaps / debt entering M1:**

1. UI strings are hardcoded in `App.tsx` — the plan requires all strings behind i18n keys
   (RU default). M1 must introduce the i18n scaffold and migrate them.
2. Server CORS origin is hardcoded to `http://localhost:5173`; make it config-driven.
3. Server `version` comes from `process.env.npm_package_version`, which is unset under pm2's
   `node dist/main.js` — it silently falls back to `'0.0.0'`.
4. Resource values in the web resource bar are placeholders.
5. No MongoDB anywhere yet (deliberate — M0 boots with zero infrastructure). M1 introduces
   MongoDB 7+ (single-node replica set): multi-document transactions for multi-step flows,
   custom `events` scheduler collection.
6. CI has never actually executed on GitHub (nothing pushed yet). The first push should be
   watched.

**Nothing has been committed** — the whole scaffold sits in the working tree for the user's
personal review and commit.
