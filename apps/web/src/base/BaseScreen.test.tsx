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
  floorForDisplay,
  settleResources,
  wouldStarveSettlement,
} from '@last-signal/game-core';

import type {
  AccountView,
  SettlementBuildingView,
  SettlementBuildQueueItemView,
  SettlementStateView,
  SettlementTroopView,
} from '../api/types';
import { Onboarding } from '../onboarding/Onboarding';
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
        return Promise.resolve(jsonResponse(ACCOUNT));
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

function renderBase(settlement: SettlementStateView, routes: Record<string, RouteHandler> = {}) {
  stubFetch(settlement, routes);
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
