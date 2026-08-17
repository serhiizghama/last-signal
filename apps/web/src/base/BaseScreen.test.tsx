import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BuildingLevels, UnitType } from '@last-signal/game-core';
import {
  DEFAULT_CONFIG,
  calcBuildCost,
  calcBuildTimeMs,
  calcNetFoodPerHour,
  calcNetRates,
  calcStorageCaps,
  calcTrainCost,
  canAfford,
  floorForDisplay,
  settleResources,
  settlementsAllowed,
  wouldStarveSettlement,
  wouldStarveWithTroops,
} from '@last-signal/game-core';

import type {
  AccountView,
  SettlementBuildingView,
  SettlementBuildQueueItemView,
  SettlementStateView,
  SettlementTrainingQueueItemView,
  SettlementTroopView,
} from '../api/types';
import { Onboarding } from '../onboarding/Onboarding';
import { BaseScreen } from './BaseScreen';
import { toTroopCounts } from './settlementSelectors';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

function errorResponse(key: string, params: Record<string, unknown> = {}, status = 400): Response {
  return jsonResponse({ error: { key, params } }, status);
}

function parseBody(init: RequestInit | undefined): Record<string, unknown> {
  return init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
}

const ACCOUNT: AccountView = {
  id: 'acc-1',
  name: 'Скиталец',
  isGuest: false,
  faction: 'raiders',
  contribution: 0,
  medals: [],
  createdAt: 0,
};

// No `faction` key at all (matches the optional field's real "unset" shape, e.g. a guest that
// never registered — see `SettlementsService.trainUnits`'s comment on why this is rejected
// with `errors.training.noFaction` rather than defaulting to one).
const ACCOUNT_NO_FACTION: AccountView = {
  id: 'acc-2',
  name: 'Скиталец',
  isGuest: true,
  contribution: 0,
  medals: [],
  createdAt: 0,
};

// Command Center L1 + Scrap Yard L5: gives a real, non-trivial scrap production rate (120/h
// — see `calcNetRates` below) without needing a fabricated number, and matches the actual
// game balance where net Food is already negative at this stage (only the Greenhouse Farm
// is a safe build — see `settlements.constants.ts`'s `STARTING_RESOURCES` comment).
const BASE_BUILDINGS: SettlementBuildingView[] = [
  { id: 'b-cc', type: 'commandCenter', level: 1, slot: 0 },
  { id: 'b-sy', type: 'scrapYard', level: 5, slot: 1 },
];
const BASE_LEVELS = BASE_BUILDINGS.map((b) => ({ type: b.type, level: b.level }));
const BASE_CAPS = calcStorageCaps(DEFAULT_CONFIG, BASE_LEVELS);

// Barracks requires Command Center L3 (`config.buildings.barracks.requires`). Greenhouse Farm
// L1 nets a modest +27.5 Food/h at zero troops (verified against the live config) — enough
// that a small batch (the tests' default `count`s) trains without tripping the Food gate, but
// low enough that `pickStarvingTrainCount` below finds a starving batch well within its search
// bound, unlike a high-level farm that would outrun any troop count worth testing.
const BARRACKS_BUILDINGS: SettlementBuildingView[] = [
  { id: 'b-cc', type: 'commandCenter', level: 3, slot: 0 },
  { id: 'b-gf', type: 'greenhouseFarm', level: 1, slot: 1 },
  { id: 'b-br', type: 'barracks', level: 1, slot: 2 },
];
const BARRACKS_LEVELS = BARRACKS_BUILDINGS.map((b) => ({ type: b.type, level: b.level }));
// Ample enough to afford any batch these tests submit, so affordability never masks the
// specific gate (would-starve, queue-busy, …) each test targets.
const BARRACKS_RESOURCES = { scrap: 100_000, fuel: 100_000, electronics: 100_000, food: 100_000 };

// Raiders' own scout (§7's unit table) — matches `ACCOUNT.faction`.
const RAIDER_SCOUT: UnitType = 'lookout';

function trainingQueueItem(
  overrides: Partial<SettlementTrainingQueueItemView> = {},
): SettlementTrainingQueueItemView {
  return {
    id: 'train-1',
    unitType: RAIDER_SCOUT,
    totalCount: 1,
    remainingCount: 1,
    unitTrainTimeMs: 1000,
    startedAt: 0,
    nextCompletesAt: 1000,
    cost: calcTrainCost(DEFAULT_CONFIG, RAIDER_SCOUT, 1),
    ...overrides,
  };
}

function settlementFixture(overrides: Partial<SettlementStateView> = {}): SettlementStateView {
  const buildings = overrides.buildings ?? BASE_BUILDINGS;
  const levels = buildings.map((b) => ({ type: b.type, level: b.level }));
  // Real troops, not an implicit `[]` — a fixture that overrides `troops` but not
  // `ratesPerHour`/`netFoodPerHour` directly must still get numbers that reflect them,
  // exactly the correctness fix under test below (see "accounts for troop Food upkeep...").
  const troops = toTroopCounts(overrides.troops ?? []);
  return {
    id: 'set-1',
    name: 'Форт Скитальца',
    x: 12,
    y: 34,
    buildings,
    resources: { values: { scrap: 100, fuel: 100, electronics: 100, food: 300 }, lastCalcAt: 0 },
    ratesPerHour: calcNetRates(DEFAULT_CONFIG, levels, troops),
    netFoodPerHour: calcNetFoodPerHour(DEFAULT_CONFIG, levels, troops),
    storageCaps: calcStorageCaps(DEFAULT_CONFIG, levels),
    buildQueue: [],
    troops: [],
    awayTroops: [],
    stationedTroops: [],
    trainingQueue: [],
    influence: 0,
    serverTime: 0,
    ...overrides,
  };
}

function queueItem(overrides: Partial<SettlementBuildQueueItemView>): SettlementBuildQueueItemView {
  return {
    id: 'q-1',
    type: 'wall',
    targetLevel: 1,
    cost: { scrap: 0, fuel: 0, electronics: 0, food: 0 },
    enqueuedAt: 0,
    startedAt: null,
    completesAt: null,
    ...overrides,
  };
}

type RouteHandler = () => Response;

function stubFetch(
  settlement: SettlementStateView,
  routes: Record<string, RouteHandler> = {},
  account: AccountView = ACCOUNT,
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const key = `${method} ${url}`;
      const route = routes[key];
      if (route) {
        return Promise.resolve(route());
      }
      if (method === 'GET' && url === '/api/auth/me') {
        return Promise.resolve(jsonResponse(account));
      }
      if (method === 'GET' && url === '/api/settlements/mine') {
        return Promise.resolve(jsonResponse([settlement]));
      }
      // `BottomNav` (rendered by `BaseScreen`) queries this itself for the Reports tab's
      // unread badge (M2c.3) — none of this file's tests care about reports, so a stable empty
      // inbox keeps every existing scenario unaffected.
      if (method === 'GET' && url.startsWith('/api/reports')) {
        return Promise.resolve(
          jsonResponse({ reports: [], nextCursor: null, unreadCount: 0, serverTime: 0 }),
        );
      }
      return Promise.reject(new Error(`Unhandled request: ${key}`));
    }),
  );
}

/** Flushes the `me` -> `settlements/mine` query chain under fake timers (each hop is a microtask/state-update round trip, not a real timer). */
async function flushLoad(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

/**
 * Advances fake time in small steps rather than one big jump. A single large
 * `advanceTimersByTimeAsync` call can race past a `setTimeout` that a `useEffect` only
 * registers *in response to* an earlier tick within that same call (the effect needs its own
 * `act()` flush to run before the fake clock can pick up the timer it schedules) — stepping
 * keeps the fake clock and React's effect flushing in lockstep.
 */
async function advanceTime(totalMs: number, stepMs = 500): Promise<void> {
  let remaining = totalMs;
  while (remaining > 0) {
    const step = Math.min(stepMs, remaining);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(step);
    });
    remaining -= step;
  }
}

function renderBase(
  settlement: SettlementStateView,
  routes: Record<string, RouteHandler> = {},
  account: AccountView = ACCOUNT,
) {
  stubFetch(settlement, routes, account);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper(): ReactElement {
    return (
      <QueryClientProvider client={queryClient}>
        <Onboarding />
      </QueryClientProvider>
    );
  }
  return render(<Wrapper />);
}

function resourceTileValue(container: HTMLElement, resource: string): string | null | undefined {
  return container
    .querySelector(`[data-resource="${resource}"]`)
    ?.closest('.resource-tile')
    ?.querySelector('.resource-tile__value')?.textContent;
}

function buildingCard(name: string): HTMLElement {
  const nameNode = screen.getByText(name);
  const card = nameNode.closest('.building-card');
  if (!card) {
    throw new Error(`No .building-card ancestor for "${name}"`);
  }
  return card as HTMLElement;
}

// Scopes a query to the Barracks card's training section specifically — the surrounding
// `.building-card` also renders the ordinary build/upgrade action, which can independently
// land on the exact same RU reason text (e.g. "Не хватает ресурсов.") or unit name, so
// asserting against the whole card risks an ambiguous multi-match.
function trainingSectionOf(card: HTMLElement): HTMLElement {
  const section = card.querySelector('.training-section');
  if (!section) {
    throw new Error('No .training-section inside the given building card');
  }
  return section as HTMLElement;
}

// The minimal count of `unitType` such that its Food upkeep alone (on top of `buildings`,
// no other troops) tips `type`'s next build at `targetLevel` into the Food gate — derived
// from the live `game-core` config, never a hardcoded number. Mirrors
// `pickStarvingTrainCount` in `settlements.integration.spec.ts` (server side) for the same
// reason: whatever the config's upkeep numbers happen to be tuned to, this fixture stays
// correct.
function pickStarvingTroopCount(
  buildings: BuildingLevels,
  type: SettlementBuildingView['type'],
  targetLevel: number,
  unitType: UnitType,
): number {
  for (let count = 1; count <= 1000; count += 1) {
    const troops = [{ unitType, count }];
    if (wouldStarveSettlement(DEFAULT_CONFIG, buildings, type, targetLevel, troops)) {
      return count;
    }
  }
  throw new Error('pickStarvingTroopCount: no starving count found within 1000');
}

// The minimal training-batch `count` such that `wouldStarveWithTroops` — the exact gate
// `TrainingSection` computes eligibility from — trips for `buildings`. Mirrors
// `pickStarvingTroopCount` above; never a hardcoded number.
function pickStarvingTrainCount(buildings: BuildingLevels, unitType: UnitType): number {
  for (let count = 1; count <= 5000; count += 1) {
    if (wouldStarveWithTroops(DEFAULT_CONFIG, buildings, [], [{ unitType, count }])) {
      return count;
    }
  }
  throw new Error('pickStarvingTrainCount: no starving count found within 5000');
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('BaseScreen', () => {
  it('renders all four resources and ticks the value upward over simulated time', async () => {
    const settlement = settlementFixture();
    const { container } = renderBase(settlement);
    await flushLoad();

    expect(screen.getByText('Металлолом')).toBeInTheDocument();
    expect(screen.getByText('Топливо')).toBeInTheDocument();
    expect(screen.getByText('Электроника')).toBeInTheDocument();
    expect(screen.getByText('Еда')).toBeInTheDocument();

    expect(resourceTileValue(container, 'scrap')).toBe('100');

    // Scrap Yard L5 nets 120/h (see `calcNetRates` above) — one unit every 30s; 31s guarantees
    // the floored display has ticked over by exactly one.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });

    expect(resourceTileValue(container, 'scrap')).toBe('101');
  });

  it('shows a resource at its cap as capped and stops it from growing further', async () => {
    const settlement = settlementFixture({
      resources: {
        values: { scrap: BASE_CAPS.scrap, fuel: 100, electronics: 100, food: 300 },
        lastCalcAt: 0,
      },
    });
    const { container } = renderBase(settlement);
    await flushLoad();

    const scrapTile = container.querySelector('[data-resource="scrap"]')?.closest('.resource-tile');
    expect(scrapTile).toHaveClass('resource-tile--full');
    expect(scrapTile?.textContent).toContain('Заполнено');

    const before = resourceTileValue(container, 'scrap');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(resourceTileValue(container, 'scrap')).toBe(before);
  });

  it('disables a building whose prerequisites are unmet and names the missing prerequisite', async () => {
    const settlement = settlementFixture();
    renderBase(settlement);
    await flushLoad();

    // Electronics Workshop requires Command Center L3; this settlement's Command Center is L1.
    const card = buildingCard('Мастерская электроники');
    const button = card.querySelector('button');
    expect(button).toBeDisabled();
    expect(within(card).getByText('Штаб (ур. 3)')).toBeInTheDocument();
  });

  it('starting a build calls the build endpoint and renders the updated queue', async () => {
    const settlement = settlementFixture();
    const completesAt = calcBuildTimeMs(DEFAULT_CONFIG, 'greenhouseFarm', 1, 1);
    const updated: SettlementStateView = {
      ...settlement,
      buildQueue: [
        queueItem({
          id: 'q-new',
          type: 'greenhouseFarm',
          targetLevel: 1,
          cost: calcBuildCost(DEFAULT_CONFIG, 'greenhouseFarm', 1),
          startedAt: 0,
          completesAt,
        }),
      ],
    };

    renderBase(settlement, {
      'POST /api/settlements/set-1/build': () => jsonResponse(updated),
    });
    await flushLoad();

    // Greenhouse Farm has no prerequisites, is affordable from the starting stock, and is the
    // one building that doesn't trip the Food gate at this stage — so its button is enabled.
    const card = buildingCard('Теплица');
    const button = card.querySelector('button');
    expect(button).not.toBeDisabled();

    fireEvent.click(button as HTMLElement);
    await flushLoad();

    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      '/api/settlements/set-1/build',
      expect.objectContaining({ method: 'POST' }),
    );
    const call = vi
      .mocked(fetch)
      .mock.calls.find(([, init]) => parseBody(init as RequestInit).type);
    expect(parseBody(call?.[1] as RequestInit)).toEqual({ type: 'greenhouseFarm' });

    expect(screen.getByText('Осталось: 00:58')).toBeInTheDocument();
  });

  it('renders the translated Russian message for a server wouldStarve error', async () => {
    const settlement = settlementFixture();
    renderBase(settlement, {
      'POST /api/settlements/set-1/build': () =>
        errorResponse('errors.build.wouldStarve', { type: 'greenhouseFarm', targetLevel: 1 }),
    });
    await flushLoad();

    const card = buildingCard('Теплица');
    const button = card.querySelector('button') as HTMLElement;
    fireEvent.click(button);
    await flushLoad();

    expect(screen.getByRole('alert')).toHaveTextContent('Эта постройка приведёт к нехватке еды.');
  });

  it('renders a live countdown for the active queue item that decreases as time advances', async () => {
    const settlement = settlementFixture({
      buildQueue: [
        queueItem({
          id: 'q-active',
          type: 'scrapYard',
          targetLevel: 6,
          startedAt: 0,
          completesAt: 60_000,
        }),
      ],
    });
    renderBase(settlement);
    await flushLoad();

    expect(screen.getByText('Осталось: 01:00')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(screen.getByText('Осталось: 00:59')).toBeInTheDocument();
    expect(screen.queryByText('Осталось: 01:00')).not.toBeInTheDocument();
  });

  it('refetches once the active item expires, riding out a stale first response, and reflects the completed build', async () => {
    const activeItem = queueItem({
      id: 'q-active',
      type: 'greenhouseFarm',
      targetLevel: 1,
      cost: calcBuildCost(DEFAULT_CONFIG, 'greenhouseFarm', 1),
      startedAt: 0,
      completesAt: 60_000,
    });
    const settlement = settlementFixture({ buildQueue: [activeItem] });

    const completedBuildings: SettlementBuildingView[] = [
      ...BASE_BUILDINGS,
      { id: 'b-gf', type: 'greenhouseFarm', level: 1, slot: 2 },
    ];
    const completedLevels = completedBuildings.map((b) => ({ type: b.type, level: b.level }));
    const completedSettlement: SettlementStateView = {
      ...settlement,
      buildings: completedBuildings,
      buildQueue: [],
      ratesPerHour: calcNetRates(DEFAULT_CONFIG, completedLevels),
      netFoodPerHour: calcNetFoodPerHour(DEFAULT_CONFIG, completedLevels),
      storageCaps: calcStorageCaps(DEFAULT_CONFIG, completedLevels),
      serverTime: 65_000,
    };

    // Simulates the real-world race the server's ~1s scheduler poll creates: the 1st call is
    // the initial load, the 2nd is the client's grace-period refetch landing *before* the
    // server has applied the completion (still queued — this is the exact bug reported), and
    // the 3rd is the bounded retry landing *after* the server has caught up.
    let mineCallCount = 0;
    renderBase(settlement, {
      'GET /api/settlements/mine': () => {
        mineCallCount += 1;
        return jsonResponse([mineCallCount <= 2 ? settlement : completedSettlement]);
      },
    });
    await flushLoad();

    const queueSection = document.querySelector('.build-queue') as HTMLElement;
    expect(within(queueSection).getByText('Осталось: 01:00')).toBeInTheDocument();

    // Past completesAt (60s) plus the grace period (1.5s): the first retry attempt fires and
    // comes back stale (mineCallCount becomes 2) — the item must still be shown, not dropped
    // or left in a broken state.
    await advanceTime(58_000);
    await flushLoad();
    expect(mineCallCount).toBe(1);

    await advanceTime(4_000);
    await flushLoad();
    expect(mineCallCount).toBe(2);
    expect(within(queueSection).getByText(/Теплица/)).toBeInTheDocument();

    // Past the retry delay (another 1.5s): the second retry attempt fires and this time the
    // server has actually completed the build.
    await advanceTime(2_000);
    await flushLoad();
    expect(mineCallCount).toBe(3);

    expect(screen.getByText('Очередь пуста')).toBeInTheDocument();
    const card = buildingCard('Теплица');
    expect(within(card).getByText('Ур. 1')).toBeInTheDocument();
  });

  it('arms the refetch for the newly promoted item once the previously active one completes', async () => {
    const first = queueItem({
      id: 'q-first',
      type: 'greenhouseFarm',
      targetLevel: 1,
      startedAt: 0,
      completesAt: 60_000,
    });
    // Waiting behind it — no startedAt/completesAt yet, matching what the server sends for a
    // queued-but-not-yet-active item.
    const second = queueItem({ id: 'q-second', type: 'wall', targetLevel: 1 });
    const settlement = settlementFixture({ buildQueue: [first, second] });

    // Once the first completes, the server promotes the second into the active slot with its
    // own fresh startedAt/completesAt.
    const promotedSecond = { ...second, startedAt: 65_000, completesAt: 95_000 };
    const afterFirstCompletes: SettlementStateView = {
      ...settlement,
      buildings: [...BASE_BUILDINGS, { id: 'b-gf', type: 'greenhouseFarm', level: 1, slot: 2 }],
      buildQueue: [promotedSecond],
      serverTime: 65_000,
    };

    let mineCallCount = 0;
    renderBase(settlement, {
      'GET /api/settlements/mine': () => {
        mineCallCount += 1;
        return jsonResponse([mineCallCount === 1 ? settlement : afterFirstCompletes]);
      },
    });
    await flushLoad();

    expect(screen.getByText('Осталось: 01:00')).toBeInTheDocument();
    expect(screen.getByText('Позиция в очереди: 2')).toBeInTheDocument();

    // Past completesAt (60s) plus the grace period (1.5s).
    await advanceTime(62_000);
    await flushLoad();

    // The second item is now active with its own countdown (95000 - 65000 = 30s) — the
    // promotion re-armed a fresh refetch trigger for *this* item, not just the one that
    // already completed.
    expect(screen.getByText('Осталось: 00:30')).toBeInTheDocument();
    expect(screen.queryByText('Позиция в очереди: 2')).not.toBeInTheDocument();
  });

  it('cancelling a queue item calls the cancel endpoint and removes it', async () => {
    const settlement = settlementFixture({
      buildQueue: [
        queueItem({
          id: 'q-cancel',
          type: 'wall',
          targetLevel: 1,
          startedAt: 0,
          completesAt: 100_000,
        }),
      ],
    });
    const updated: SettlementStateView = { ...settlement, buildQueue: [] };

    renderBase(settlement, {
      'POST /api/settlements/set-1/build/q-cancel/cancel': () => jsonResponse(updated),
    });
    await flushLoad();

    fireEvent.click(screen.getByText('Отменить'));
    await flushLoad();

    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      '/api/settlements/set-1/build/q-cancel/cancel',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(screen.getByText('Очередь пуста')).toBeInTheDocument();
  });

  it('disables further builds with the translated reason once the queue is full', async () => {
    const settlement = settlementFixture({
      buildQueue: [
        queueItem({ id: 'q1', type: 'wall', targetLevel: 1, startedAt: 0, completesAt: 100_000 }),
        queueItem({ id: 'q2', type: 'wall', targetLevel: 2 }),
        queueItem({ id: 'q3', type: 'wall', targetLevel: 3 }),
      ],
    });
    renderBase(settlement);
    await flushLoad();

    // Scrap Yard has no prerequisites, so with the queue already at capacity (3), the queue
    // check is what blocks it.
    const card = buildingCard('Свалка металлолома');
    const button = card.querySelector('button');
    expect(button).toBeDisabled();
    expect(card.textContent).toContain('Очередь построек заполнена.');
  });

  it('accounts for troop Food upkeep in both the live resource tick and build eligibility', async () => {
    // Greenhouse Farm L1 is buildable on `BASE_BUILDINGS` with no troops at home (see
    // "starting a build calls the build endpoint..." above) — its own Food production is
    // what keeps it just on the safe side of the gate. `pickStarvingTroopCount` finds the
    // smallest home-scout count whose upkeep alone (nothing else changes) tips that same
    // build into `wouldStarve`, derived from the live config rather than a hardcoded number.
    const troopCount = pickStarvingTroopCount(BASE_LEVELS, 'greenhouseFarm', 1, 'lookout');
    const troops: SettlementTroopView[] = [{ unitType: 'lookout', count: troopCount }];
    const settlement = settlementFixture({ troops });
    const { container } = renderBase(settlement);
    await flushLoad();

    // Eligibility: `computeBuildEligibility`'s Food gate must now see these troops (via
    // `live.troops`, threaded from `useLiveResources`) — without the fix this button would
    // still read enabled, exactly like the no-troops fixture does.
    const card = buildingCard('Теплица');
    const button = card.querySelector('button');
    expect(button).toBeDisabled();
    expect(card.textContent).toContain('Эта постройка приведёт к нехватке еды.');

    // Live tick: the Food value must decay at the troop-inclusive net rate — computed
    // independently here via `settleResources` (the exact function `useLiveResources`
    // calls), never a hardcoded number. Without the fix, `useLiveResources` would tick Food
    // at the buildings-only rate and this would fail.
    const elapsedMs = 60_000;
    const expectedFood = settleResources(
      DEFAULT_CONFIG,
      BASE_LEVELS,
      { values: settlement.resources.values, lastCalcAt: settlement.resources.lastCalcAt },
      elapsedMs,
      toTroopCounts(troops),
    ).values.food;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(elapsedMs);
    });

    expect(resourceTileValue(container, 'food')).toBe(
      floorForDisplay(expectedFood).toLocaleString('ru-RU'),
    );
  });
});

// M2c.4: scout training on the Barracks card, and the Influence display (§7/§9/§11).
describe('Barracks training section', () => {
  it('appears only on the Barracks card, disabled with the "building missing" reason when it is not built', async () => {
    const settlement = settlementFixture(); // BASE_BUILDINGS has no Barracks.
    renderBase(settlement);
    await flushLoad();

    const barracksCard = buildingCard('Казармы');
    expect(within(barracksCard).getByText('Обучение разведчиков')).toBeInTheDocument();
    expect(
      within(barracksCard).getByText('Нужно построить это здание, чтобы обучать юнитов.'),
    ).toBeInTheDocument();
    expect(within(barracksCard).getByText('Начать обучение')).toBeDisabled();

    const otherCard = buildingCard('Свалка металлолома');
    expect(within(otherCard).queryByText('Обучение разведчиков')).not.toBeInTheDocument();
  });

  it('disables training with the "no faction" reason when the account has no faction', async () => {
    // Bypasses `Onboarding` deliberately: the real onboarding flow routes an account with no
    // faction to `RegisterScreen` before `BaseScreen` ever mounts (`Onboarding.tsx`), so the
    // only way to exercise `TrainingSection`'s `noFaction` gate — mirroring
    // `SettlementsService.trainUnits`'s own defensive check for exactly this account state —
    // is to render `BaseScreen` directly with a factionless account.
    const settlement = settlementFixture({
      buildings: BARRACKS_BUILDINGS,
      resources: { values: BARRACKS_RESOURCES, lastCalcAt: 0 },
    });
    stubFetch(settlement, {}, ACCOUNT_NO_FACTION);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <BaseScreen settlement={settlement} account={ACCOUNT_NO_FACTION} onNavigateTab={() => {}} />
      </QueryClientProvider>,
    );
    await flushLoad();

    const barracksCard = buildingCard('Казармы');
    expect(
      within(barracksCard).getByText('Нужно выбрать фракцию, чтобы обучать юнитов.'),
    ).toBeInTheDocument();
    expect(within(barracksCard).getByText('Начать обучение')).toBeDisabled();
  });

  it('disables training with the "order already running" reason once a training order is queued', async () => {
    const settlement = settlementFixture({
      buildings: BARRACKS_BUILDINGS,
      resources: { values: BARRACKS_RESOURCES, lastCalcAt: 0 },
      trainingQueue: [trainingQueueItem()],
    });
    renderBase(settlement);
    await flushLoad();

    const barracksCard = buildingCard('Казармы');
    expect(within(barracksCard).getByText('В этом здании уже идёт обучение.')).toBeInTheDocument();
    expect(within(barracksCard).getByText('Начать обучение')).toBeDisabled();
  });

  it('disables training with the "would starve" reason once the batch size tips the settlement into a Food deficit', async () => {
    const starvingCount = pickStarvingTrainCount(BARRACKS_LEVELS, RAIDER_SCOUT);
    const settlement = settlementFixture({
      buildings: BARRACKS_BUILDINGS,
      resources: { values: BARRACKS_RESOURCES, lastCalcAt: 0 },
    });
    renderBase(settlement);
    await flushLoad();

    const barracksCard = buildingCard('Казармы');
    const countInput = within(barracksCard).getByLabelText('Количество');
    fireEvent.change(countInput, { target: { value: String(starvingCount) } });

    expect(within(barracksCard).getByText('Обучение приведёт к нехватке еды.')).toBeInTheDocument();
    expect(within(barracksCard).getByText('Начать обучение')).toBeDisabled();
  });

  it('disables training with the "insufficient resources" reason when the batch is unaffordable', async () => {
    const unaffordable = { scrap: 0, fuel: 100_000, electronics: 100_000, food: 100_000 };
    // Sanity check against the live `game-core` formula, not an assumption about the numbers.
    expect(canAfford(unaffordable, calcTrainCost(DEFAULT_CONFIG, RAIDER_SCOUT, 1))).toBe(false);

    const settlement = settlementFixture({
      buildings: BARRACKS_BUILDINGS,
      resources: { values: unaffordable, lastCalcAt: 0 },
    });
    renderBase(settlement);
    await flushLoad();

    const trainingSection = trainingSectionOf(buildingCard('Казармы'));
    expect(within(trainingSection).getByText('Не хватает ресурсов.')).toBeInTheDocument();
    expect(within(trainingSection).getByText('Начать обучение')).toBeDisabled();
  });

  it('submitting posts {unitType, count} for the caller faction scout to the train endpoint, and renders the updated queue', async () => {
    const settlement = settlementFixture({
      buildings: BARRACKS_BUILDINGS,
      resources: { values: BARRACKS_RESOURCES, lastCalcAt: 0 },
    });
    const updated: SettlementStateView = {
      ...settlement,
      trainingQueue: [
        trainingQueueItem({
          id: 'train-new',
          totalCount: 3,
          remainingCount: 3,
          nextCompletesAt: 240_000,
        }),
      ],
    };

    renderBase(settlement, {
      'POST /api/settlements/set-1/train': () => jsonResponse(updated),
    });
    await flushLoad();

    const barracksCard = buildingCard('Казармы');
    const countInput = within(barracksCard).getByLabelText('Количество');
    fireEvent.change(countInput, { target: { value: '3' } });

    const submitButton = within(barracksCard).getByText('Начать обучение');
    expect(submitButton).not.toBeDisabled();
    fireEvent.click(submitButton);
    await flushLoad();

    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      '/api/settlements/set-1/train',
      expect.objectContaining({ method: 'POST' }),
    );
    const call = vi
      .mocked(fetch)
      .mock.calls.find(([, init]) => parseBody(init as RequestInit).unitType);
    expect(parseBody(call?.[1] as RequestInit)).toEqual({ unitType: RAIDER_SCOUT, count: 3 });

    expect(screen.getByText('Осталось 3 из 3')).toBeInTheDocument();
  });

  it('renders the translated Russian message for a server training rejection', async () => {
    const settlement = settlementFixture({
      buildings: BARRACKS_BUILDINGS,
      resources: { values: BARRACKS_RESOURCES, lastCalcAt: 0 },
    });
    renderBase(settlement, {
      'POST /api/settlements/set-1/train': () => errorResponse('errors.training.queueBusy'),
    });
    await flushLoad();

    fireEvent.click(within(buildingCard('Казармы')).getByText('Начать обучение'));
    await flushLoad();

    expect(screen.getByRole('alert')).toHaveTextContent('В этом здании уже идёт обучение.');
  });

  it('shows the training queue as "N of M" with a live countdown to the next unit, and no cancel affordance', async () => {
    const settlement = settlementFixture({
      buildings: BARRACKS_BUILDINGS,
      trainingQueue: [
        trainingQueueItem({
          id: 'train-active',
          totalCount: 5,
          remainingCount: 3,
          nextCompletesAt: 20_000,
        }),
      ],
    });
    renderBase(settlement);
    await flushLoad();

    const barracksCard = buildingCard('Казармы');
    expect(within(barracksCard).getByText('Осталось 3 из 5')).toBeInTheDocument();
    expect(within(barracksCard).getByText('Следующий через: 00:20')).toBeInTheDocument();
    expect(within(barracksCard).queryByText('Отменить')).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(within(barracksCard).getByText('Следующий через: 00:19')).toBeInTheDocument();
  });

  // Boundary regression (found in review): the countdown reaching zero is not the same event
  // as the server actually crediting the unit — without a refetch the UI freezes at "00:00" /
  // the stale remaining count forever. Mirrors `BuildQueueList`'s own "refetches once the
  // active item expires..." test below, including the exact stale-then-resolved timing, via
  // the shared `useRefetchOnExpiry` hook.
  it("refetches once the training order's countdown expires, riding out a stale first response, and reflects the credited unit (troops appear, order clears)", async () => {
    const activeItem = trainingQueueItem({
      id: 'train-1',
      totalCount: 1,
      remainingCount: 1,
      startedAt: 0,
      nextCompletesAt: 60_000,
    });
    const settlement = settlementFixture({
      buildings: BARRACKS_BUILDINGS,
      trainingQueue: [activeItem],
    });
    const completedSettlement: SettlementStateView = {
      ...settlement,
      trainingQueue: [],
      troops: [{ unitType: RAIDER_SCOUT, count: 1 }],
      serverTime: 65_000,
    };

    // Simulates the real-world race the server's ~1s scheduler poll creates (same shape as
    // `BuildQueueList`'s own test): the 1st call is the initial load, the 2nd is the client's
    // grace-period refetch landing *before* the server has applied the completion (still
    // showing "1 of 1" — this is the exact bug reported), and the 3rd is the bounded retry
    // landing *after* the server has caught up.
    let mineCallCount = 0;
    renderBase(settlement, {
      'GET /api/settlements/mine': () => {
        mineCallCount += 1;
        return jsonResponse([mineCallCount <= 2 ? settlement : completedSettlement]);
      },
    });
    await flushLoad();

    expect(within(buildingCard('Казармы')).getByText('Следующий через: 01:00')).toBeInTheDocument();
    expect(
      within(buildingCard('Казармы')).getByText('В поселении пока нет войск'),
    ).toBeInTheDocument();

    // Past nextCompletesAt (60s) plus the grace period (1.5s): the first retry attempt fires
    // and comes back stale (mineCallCount becomes 2) — the order must still be shown, not
    // silently dropped or left showing a wrong state.
    await advanceTime(58_000);
    await flushLoad();
    expect(mineCallCount).toBe(1);

    await advanceTime(4_000);
    await flushLoad();
    expect(mineCallCount).toBe(2);
    expect(within(buildingCard('Казармы')).getByText('Следующий через: 00:00')).toBeInTheDocument();

    // Past the retry delay (another 1.5s): the second retry attempt fires and this time the
    // server has actually credited the unit.
    await advanceTime(2_000);
    await flushLoad();
    expect(mineCallCount).toBe(3);

    const finalCard = buildingCard('Казармы');
    expect(finalCard.querySelector('.training-queue-item')).toBeNull();
    const troopList = finalCard.querySelector('.troop-list');
    if (!troopList) {
      throw new Error('No .troop-list inside the Barracks card');
    }
    expect(within(troopList as HTMLElement).getByText('Дозорный')).toBeInTheDocument();
  });

  // The order keeps the same `id` across its whole batch (unlike a build queue item), so this
  // exercises the subtlety `useRefetchOnExpiry`'s `watchKey` exists for: the refetch must
  // re-arm for the *second* unit's own expiry after the first one already resolved under the
  // same order id.
  it('re-arms the refetch for each unit within a multi-unit training batch, decrementing remaining and clearing once the last unit lands', async () => {
    const settlement = settlementFixture({
      buildings: BARRACKS_BUILDINGS,
      trainingQueue: [
        trainingQueueItem({
          id: 'train-batch',
          totalCount: 2,
          remainingCount: 2,
          startedAt: 0,
          nextCompletesAt: 60_000,
        }),
      ],
    });
    const afterFirstUnit: SettlementStateView = {
      ...settlement,
      trainingQueue: [
        trainingQueueItem({
          id: 'train-batch',
          totalCount: 2,
          remainingCount: 1,
          startedAt: 60_000,
          nextCompletesAt: 120_000,
        }),
      ],
      troops: [{ unitType: RAIDER_SCOUT, count: 1 }],
    };
    const afterSecondUnit: SettlementStateView = {
      ...settlement,
      trainingQueue: [],
      troops: [{ unitType: RAIDER_SCOUT, count: 2 }],
    };

    let phase: 'initial' | 'firstDone' | 'secondDone' = 'initial';
    renderBase(settlement, {
      'GET /api/settlements/mine': () => {
        if (phase === 'initial') {
          return jsonResponse([settlement]);
        }
        if (phase === 'firstDone') {
          return jsonResponse([afterFirstUnit]);
        }
        return jsonResponse([afterSecondUnit]);
      },
    });
    await flushLoad();

    expect(within(buildingCard('Казармы')).getByText('Следующий через: 01:00')).toBeInTheDocument();

    // Cross the first unit's boundary (60s) with enough margin for the bounded retry loop
    // (grace 1.5s + one retry 1.5s = 3s) to land on the resolved response.
    phase = 'firstDone';
    await advanceTime(65_000);
    await flushLoad();

    const midCard = buildingCard('Казармы');
    expect(within(midCard).getByText('Осталось 1 из 2')).toBeInTheDocument();
    const midTroopList = midCard.querySelector('.troop-list');
    if (!midTroopList) {
      throw new Error('No .troop-list inside the Barracks card');
    }
    expect(within(midTroopList as HTMLElement).getByText('Дозорный')).toBeInTheDocument();

    // Cross the second unit's boundary too — its own fresh `nextCompletesAt` is another 60s
    // out. If the refetch hadn't re-armed for this unit (the bug the shared `watchKey` fixes),
    // this would hang exactly like the first defect did.
    phase = 'secondDone';
    await advanceTime(65_000);
    await flushLoad();

    const finalCard = buildingCard('Казармы');
    expect(finalCard.querySelector('.training-queue-item')).toBeNull();
    const finalTroopList = finalCard.querySelector('.troop-list');
    if (!finalTroopList) {
      throw new Error('No .troop-list inside the Barracks card');
    }
    expect(within(finalTroopList as HTMLElement).getByText('2')).toBeInTheDocument();
  });

  it('renders home troops with their Russian unit name and count', async () => {
    const settlement = settlementFixture({ troops: [{ unitType: RAIDER_SCOUT, count: 4 }] });
    renderBase(settlement);
    await flushLoad();

    const barracksCard = buildingCard('Казармы');
    const troopList = barracksCard.querySelector('.troop-list');
    if (!troopList) {
      throw new Error('No .troop-list inside the Barracks card');
    }
    expect(within(troopList as HTMLElement).getByText('Дозорный')).toBeInTheDocument();
    expect(within(troopList as HTMLElement).getByText('4')).toBeInTheDocument();
  });
});

describe('Influence panel', () => {
  it('shows current Influence and progress toward the next settlement threshold', async () => {
    const threshold = DEFAULT_CONFIG.influence.settlementThresholds[0];
    if (threshold === undefined) {
      throw new Error('DEFAULT_CONFIG.influence.settlementThresholds is empty');
    }
    const influence = threshold - 48;
    const settlement = settlementFixture({ influence });
    renderBase(settlement);
    await flushLoad();

    expect(screen.getByText('Влияние')).toBeInTheDocument();
    expect(
      screen.getByText(
        `${influence} из ${threshold} — основание поселения откроется при ${threshold}`,
      ),
    ).toBeInTheDocument();
  });

  it('shows the at-cap message once settlementsAllowed reports the account has reached the settlement cap', async () => {
    const lastThreshold =
      DEFAULT_CONFIG.influence.settlementThresholds[
        DEFAULT_CONFIG.influence.settlementThresholds.length - 1
      ];
    if (lastThreshold === undefined) {
      throw new Error('DEFAULT_CONFIG.influence.settlementThresholds is empty');
    }
    const influence = lastThreshold + 40;
    // Sanity check against the live `game-core` formula, not an assumption about the numbers.
    expect(settlementsAllowed(DEFAULT_CONFIG, influence)).toBe(
      DEFAULT_CONFIG.influence.maxSettlements,
    );

    const settlement = settlementFixture({ influence });
    renderBase(settlement);
    await flushLoad();

    expect(screen.getByText(`${influence} — достигнут предел поселений`)).toBeInTheDocument();
  });
});
