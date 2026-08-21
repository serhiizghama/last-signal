import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BuildingLevels, UnitType } from '@last-signal/game-core';
import {
  DEFAULT_CONFIG,
  calcNetFoodPerHour,
  calcNetRates,
  calcStorageCaps,
  calcTrainTimeMs,
  calcTroopFoodUpkeepPerHour,
  formatDuration,
} from '@last-signal/game-core';

import type {
  AccountView,
  SettlementBuildingView,
  SettlementStateView,
  SettlementStationedContingentView,
  SettlementTrainingQueueItemView,
} from '../api/types';
import { toTroopCounts } from '../base/settlementSelectors';
import { Onboarding } from '../onboarding/Onboarding';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
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

// Command Center + Barracks + Machine Shop, all built — enough for all three roster cards to
// have something to show, and (at L1) a real, non-zero preview for `calcTrainTimeMs`. A
// Greenhouse Farm is included deliberately (mirrors `BaseScreen.test.tsx`'s own
// `BARRACKS_BUILDINGS`): without one, these three buildings' upkeep alone already nets
// negative Food at zero troops, which would trip `wouldStarve` before any test gets to
// exercise the specific gate it actually targets.
const ALL_BUILDINGS: SettlementBuildingView[] = [
  { id: 'b-cc', type: 'commandCenter', level: 1, slot: 0 },
  { id: 'b-br', type: 'barracks', level: 1, slot: 1 },
  { id: 'b-ms', type: 'machineShop', level: 1, slot: 2 },
  { id: 'b-gf', type: 'greenhouseFarm', level: 1, slot: 3 },
];

// Ample enough to afford any batch these tests submit, so affordability never masks the
// specific gate a given test targets.
const AMPLE_RESOURCES = {
  scrap: 1_000_000,
  fuel: 1_000_000,
  electronics: 1_000_000,
  food: 1_000_000,
};

function trainingQueueItem(
  overrides: Partial<SettlementTrainingQueueItemView> = {},
): SettlementTrainingQueueItemView {
  return {
    id: 'train-1',
    unitType: 'torcher',
    totalCount: 1,
    remainingCount: 1,
    unitTrainTimeMs: 1000,
    startedAt: 0,
    nextCompletesAt: 1000,
    cost: { scrap: 0, fuel: 0, electronics: 0, food: 0 },
    ...overrides,
  };
}

function settlementFixture(overrides: Partial<SettlementStateView> = {}): SettlementStateView {
  const buildings = overrides.buildings ?? ALL_BUILDINGS;
  const levels: BuildingLevels = buildings.map((b) => ({ type: b.type, level: b.level }));
  const troops = toTroopCounts(overrides.troops ?? []);
  return {
    id: 'set-1',
    name: 'Форт Скитальца',
    x: 12,
    y: 34,
    buildings,
    resources: { values: AMPLE_RESOURCES, lastCalcAt: 0 },
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

type RouteHandler = () => Response;

function stubFetch(
  settlement: SettlementStateView,
  routes: Record<string, RouteHandler> = {},
  account: AccountView = ACCOUNT,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
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
    if (method === 'GET' && url.startsWith('/api/reports')) {
      return Promise.resolve(
        jsonResponse({ reports: [], nextCursor: null, unreadCount: 0, serverTime: 0 }),
      );
    }
    return Promise.reject(new Error(`Unhandled request: ${key}`));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Flushes the `me` -> `settlements/mine` query chain under fake timers, mirroring `BaseScreen.test.tsx`. */
async function flushLoad(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

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

/**
 * Renders the full `Onboarding` chain (mirrors `MapScreen.test.tsx`'s "Map <-> Base
 * navigation" convention) and switches to the Units tab — `SettlementGate` always lands on
 * `base` first, and the real `SETTLEMENTS_MINE_KEY` query must be live (not bypassed) for the
 * training-queue countdown's cache invalidation/refetch to have anything to invalidate.
 */
async function renderUnits(
  settlement: SettlementStateView,
  routes: Record<string, RouteHandler> = {},
  account: AccountView = ACCOUNT,
) {
  const fetchMock = stubFetch(settlement, routes, account);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper(): ReactElement {
    return (
      <QueryClientProvider client={queryClient}>
        <Onboarding />
      </QueryClientProvider>
    );
  }
  const result = render(<Wrapper />);
  await flushLoad();
  fireEvent.click(screen.getByRole('button', { name: 'Войска' }));
  await flushLoad();
  return { ...result, fetchMock };
}

function buildingCard(name: 'barracks' | 'machineShop' | 'commandCenter'): HTMLElement {
  const card = document.querySelector(`[data-building="${name}"]`);
  if (!card) {
    throw new Error(`No card for building "${name}"`);
  }
  return card as HTMLElement;
}

function unitRow(card: HTMLElement, unitName: string): HTMLElement {
  const nameNode = within(card).getByText(unitName);
  const row = nameNode.closest('.building-card');
  if (!row) {
    throw new Error(`No .building-card row for unit "${unitName}" inside the given card`);
  }
  return row as HTMLElement;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('UnitsScreen — roster', () => {
  it('groups the roster by the three training buildings, showing only the caller faction plus the Settler, and never wildlife', async () => {
    await renderUnits(settlementFixture());

    const barracks = buildingCard('barracks');
    expect(within(barracks).getByText('Громила')).toBeInTheDocument(); // brute
    expect(within(barracks).getByText('Поджигатель')).toBeInTheDocument(); // torcher
    expect(within(barracks).getByText('Дозорный')).toBeInTheDocument(); // lookout
    // Another faction's Barracks-trained unit must not appear.
    expect(within(barracks).queryByText('Экзо-боец')).not.toBeInTheDocument(); // exoTrooper
    expect(within(barracks).queryByText('Застрельщик')).not.toBeInTheDocument(); // skirmisher

    const machineShop = buildingCard('machineShop');
    expect(within(machineShop).getByText('Байкер')).toBeInTheDocument(); // biker
    expect(within(machineShop).getByText('Таран-грузовик')).toBeInTheDocument(); // ramTruck
    expect(within(machineShop).queryByText('Бронеквадроцикл')).not.toBeInTheDocument(); // armoredQuad

    const commandCenter = buildingCard('commandCenter');
    expect(within(commandCenter).getByText('Поселенец')).toBeInTheDocument(); // settler
    // The Command Center trains nothing else.
    expect(within(commandCenter).queryByText('Громила')).not.toBeInTheDocument();

    // Wildlife is never trainable by anyone and must not appear on any card.
    expect(screen.queryByText('Одичавший пёс')).not.toBeInTheDocument(); // feralDog
    expect(screen.queryByText('Банда падальщиков')).not.toBeInTheDocument(); // scavengerGang
  });

  it('shows a unit blocked by a missing building with the translated reason, without hiding it', async () => {
    await renderUnits(
      settlementFixture({
        buildings: [{ id: 'b-cc', type: 'commandCenter', level: 1, slot: 0 }],
      }),
    );

    const barracks = buildingCard('barracks');
    const row = unitRow(barracks, 'Громила');
    expect(
      within(row).getByText('Нужно построить это здание, чтобы обучать юнитов.'),
    ).toBeInTheDocument();
    expect(within(row).getByText('Начать обучение')).toBeDisabled();
  });

  it('shows a unit blocked by insufficient resources with the translated reason', async () => {
    await renderUnits(
      settlementFixture({
        resources: { values: { scrap: 0, fuel: 0, electronics: 0, food: 0 }, lastCalcAt: 0 },
      }),
    );

    const row = unitRow(buildingCard('barracks'), 'Поджигатель');
    expect(within(row).getByText('Не хватает ресурсов.')).toBeInTheDocument();
    expect(within(row).getByText('Начать обучение')).toBeDisabled();
  });

  it('previews a real, level-derived training time — two different Barracks levels render two different times, both matching calcTrainTimeMs exactly', async () => {
    const levelOneMs = calcTrainTimeMs(DEFAULT_CONFIG, 'brute', 1);
    const levelFiveMs = calcTrainTimeMs(DEFAULT_CONFIG, 'brute', 5);
    expect(levelOneMs).not.toBe(levelFiveMs); // sanity: the config's curve is non-trivial

    const first = await renderUnits(
      settlementFixture({
        buildings: [
          { id: 'b-cc', type: 'commandCenter', level: 1, slot: 0 },
          { id: 'b-br', type: 'barracks', level: 1, slot: 1 },
        ],
      }),
    );
    const bruteAtL1 = unitRow(buildingCard('barracks'), 'Громила');
    expect(
      within(bruteAtL1).getByText(`За юнита: ${formatDuration(levelOneMs)}`),
    ).toBeInTheDocument();
    // Unmount before rendering a second `<Onboarding/>` tree in the same test — otherwise both
    // trees' bottom navs coexist and every subsequent `getByRole('button', { name: 'Войска' })`
    // (inside the next `renderUnits` call) matches more than one element.
    first.unmount();

    await renderUnits(
      settlementFixture({
        buildings: [
          { id: 'b-cc', type: 'commandCenter', level: 1, slot: 0 },
          { id: 'b-br', type: 'barracks', level: 5, slot: 1 },
        ],
      }),
    );
    const bruteAtL5 = unitRow(buildingCard('barracks'), 'Громила');
    expect(
      within(bruteAtL5).getByText(`За юнита: ${formatDuration(levelFiveMs)}`),
    ).toBeInTheDocument();
  });
});

describe('UnitsScreen — training submission and queue', () => {
  it('submitting a specific unit row posts {unitType, count} to the train endpoint and renders the resulting queue row', async () => {
    const settlement = settlementFixture();
    const updated: SettlementStateView = {
      ...settlement,
      trainingQueue: [
        trainingQueueItem({
          id: 'train-new',
          unitType: 'torcher',
          totalCount: 2,
          remainingCount: 2,
          nextCompletesAt: 240_000,
        }),
      ],
    };

    const { fetchMock } = await renderUnits(settlement, {
      'POST /api/settlements/set-1/train': () => jsonResponse(updated),
    });

    const row = unitRow(buildingCard('barracks'), 'Поджигатель');
    fireEvent.change(within(row).getByLabelText('Количество'), { target: { value: '2' } });
    fireEvent.click(within(row).getByText('Начать обучение'));
    await flushLoad();

    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === '/api/settlements/set-1/train' &&
        (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(call).toBeDefined();
    expect(parseBody(call?.[1] as RequestInit)).toEqual({ unitType: 'torcher', count: 2 });

    expect(within(buildingCard('barracks')).getByText('Осталось 2 из 2')).toBeInTheDocument();
  });

  it('the queue countdown ticks down and, exactly at zero, refetches to pick up the credited unit — not just a decreasing timer', async () => {
    const activeItem = trainingQueueItem({
      id: 'train-1',
      unitType: 'torcher',
      totalCount: 1,
      remainingCount: 1,
      startedAt: 0,
      nextCompletesAt: 60_000,
    });
    const settlement = settlementFixture({ trainingQueue: [activeItem] });
    const completed: SettlementStateView = {
      ...settlement,
      trainingQueue: [],
      troops: [{ unitType: 'torcher', count: 1 }],
      serverTime: 65_000,
    };

    let mineCallCount = 0;
    await renderUnits(settlement, {
      'GET /api/settlements/mine': () => {
        mineCallCount += 1;
        return jsonResponse([mineCallCount <= 2 ? settlement : completed]);
      },
    });

    expect(
      within(buildingCard('barracks')).getByText('Следующий через: 01:00'),
    ).toBeInTheDocument();

    // The slope: the countdown visibly decreases.
    await advanceTime(1_000);
    expect(
      within(buildingCard('barracks')).getByText('Следующий через: 00:59'),
    ).toBeInTheDocument();

    // The boundary: crossing zero plus the grace period triggers the first refetch attempt,
    // which can still land stale (mineCallCount 2) before the retry lands resolved (3) — the
    // lesson from `PROGRESS.md` this test exists to not repeat. (58s remaining after the 1s
    // slope check above, so this still lands just short of the 60s boundary.)
    await advanceTime(57_000);
    await flushLoad();
    expect(mineCallCount).toBe(1);

    await advanceTime(4_000);
    await flushLoad();
    expect(mineCallCount).toBe(2);
    expect(
      within(buildingCard('barracks')).getByText('Следующий через: 00:00'),
    ).toBeInTheDocument();

    await advanceTime(2_000);
    await flushLoad();
    expect(mineCallCount).toBe(3);

    const finalCard = buildingCard('barracks');
    expect(finalCard.querySelector('.training-queue-item')).toBeNull();
  });

  it('three concurrent orders — one per training building — each render with their own countdown', async () => {
    const settlement = settlementFixture({
      trainingQueue: [
        trainingQueueItem({
          id: 'train-barracks',
          unitType: 'torcher',
          totalCount: 1,
          remainingCount: 1,
          nextCompletesAt: 30_000,
        }),
        trainingQueueItem({
          id: 'train-machine-shop',
          unitType: 'biker',
          totalCount: 1,
          remainingCount: 1,
          nextCompletesAt: 90_000,
        }),
        trainingQueueItem({
          id: 'train-command-center',
          unitType: 'settler',
          totalCount: 1,
          remainingCount: 1,
          nextCompletesAt: 300_000,
        }),
      ],
    });

    await renderUnits(settlement);

    expect(
      within(buildingCard('barracks')).getByText('Следующий через: 00:30'),
    ).toBeInTheDocument();
    expect(
      within(buildingCard('machineShop')).getByText('Следующий через: 01:30'),
    ).toBeInTheDocument();
    expect(
      within(buildingCard('commandCenter')).getByText('Следующий через: 05:00'),
    ).toBeInTheDocument();

    // No cross-contamination: each card shows exactly one queue row, its own.
    expect(buildingCard('barracks').querySelectorAll('.training-queue-item')).toHaveLength(1);
    expect(buildingCard('machineShop').querySelectorAll('.training-queue-item')).toHaveLength(1);
    expect(buildingCard('commandCenter').querySelectorAll('.training-queue-item')).toHaveLength(1);
  });
});

describe('UnitsScreen — army overview (§3)', () => {
  it('renders all three groups with per-group Food costs derived from game-core, including a non-empty stationed contingent', async () => {
    const stationed: SettlementStationedContingentView = {
      ownerAccountId: 'acc-ally',
      fromSettlementId: 'set-ally',
      troops: [{ unitType: 'exoTrooper', count: 3 }],
    };
    const settlement = settlementFixture({
      troops: [{ unitType: 'brute', count: 5 }],
      awayTroops: [{ unitType: 'torcher', count: 2 }],
      stationedTroops: [stationed],
    });

    const homeFood = calcTroopFoodUpkeepPerHour(DEFAULT_CONFIG, [{ unitType: 'brute', count: 5 }]);
    const awayFood = calcTroopFoodUpkeepPerHour(DEFAULT_CONFIG, [
      { unitType: 'torcher', count: 2 },
    ]);
    const stationedFood = calcTroopFoodUpkeepPerHour(DEFAULT_CONFIG, [
      { unitType: 'exoTrooper' as UnitType, count: 3 },
    ]);
    expect(homeFood).toBeGreaterThan(0);
    expect(awayFood).toBeGreaterThan(0);
    expect(stationedFood).toBeGreaterThan(0);

    await renderUnits(settlement);

    const overview = document.querySelector('.army-overview');
    if (!overview) {
      throw new Error('No .army-overview rendered');
    }

    const homeGroup = overview.querySelector('[data-group="home"]');
    const awayGroup = overview.querySelector('[data-group="away"]');
    const stationedGroup = overview.querySelector('[data-group="stationed"]');
    if (!homeGroup || !awayGroup || !stationedGroup) {
      throw new Error('Missing one of the three army-overview groups');
    }

    expect(within(homeGroup as HTMLElement).getByText('Громила')).toBeInTheDocument();
    expect(
      within(homeGroup as HTMLElement).getByText(`Еда: ${homeFood.toLocaleString('ru-RU')}/ч`),
    ).toBeInTheDocument();

    expect(within(awayGroup as HTMLElement).getByText('Поджигатель')).toBeInTheDocument();
    expect(
      within(awayGroup as HTMLElement).getByText(`Еда: ${awayFood.toLocaleString('ru-RU')}/ч`),
    ).toBeInTheDocument();

    expect(within(stationedGroup as HTMLElement).getByText('Экзо-боец')).toBeInTheDocument();
    expect(
      within(stationedGroup as HTMLElement).getByText('Владелец: acc-ally'),
    ).toBeInTheDocument();
    expect(
      within(stationedGroup as HTMLElement).getByText('Прибыли из: set-ally'),
    ).toBeInTheDocument();
    // The group's own aggregate total, not the single contingent's identical-looking per-row
    // Food line above it (both read "Еда: 3/ч" here, since there is only one contingent) —
    // scoped to the `--total` modifier so the two are never ambiguous even when they agree.
    const stationedTotal = stationedGroup.querySelector('.army-overview__food--total');
    expect(stationedTotal).toHaveTextContent(`Еда: ${stationedFood.toLocaleString('ru-RU')}/ч`);

    expect(
      screen.getByText(
        `Итог по еде поселения: ${settlement.netFoodPerHour.toLocaleString('ru-RU')}/ч`,
      ),
    ).toBeInTheDocument();
  });
});
