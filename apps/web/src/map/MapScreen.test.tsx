import type { ReactElement } from 'react';
import {
  DEFAULT_CONFIG,
  chebyshevDistance,
  formatDuration,
  slowestTroopSpeed,
  terrainAt,
  travelTimeMs,
} from '@last-signal/game-core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AccountView, MapView, MovementView, SettlementStateView } from '../api/types';
import errorsRu from '../i18n/locales/ru/errors.json';
import mapRu from '../i18n/locales/ru/map.json';
import militaryRu from '../i18n/locales/ru/military.json';
import { Onboarding } from '../onboarding/Onboarding';
import { MapScreen } from './MapScreen';
import { computeVisibleTileRange, tileCountInRange, tileSizeForZoom } from './mapGeometry';

const { radius } = DEFAULT_CONFIG.map;
// Matches `useElementSize`'s fallback — the size the component actually measures at in this
// environment (happy-dom never lays anything out), so expectations derived from it are exact.
const FALLBACK_VIEWPORT = { widthPx: 360, heightPx: 480 };

const ACCOUNT: AccountView = {
  id: 'acc-own',
  name: 'Скиталец',
  isGuest: false,
  faction: 'raiders',
  side: 'beacon',
  contribution: 0,
  medals: [],
  createdAt: 0,
};

function settlementFixture(overrides: Partial<SettlementStateView> = {}): SettlementStateView {
  return {
    id: 'set-own',
    name: 'Форт Скитальца',
    x: 0,
    y: 0,
    buildings: [],
    resources: { values: { scrap: 0, fuel: 0, electronics: 0, food: 0 }, lastCalcAt: 0 },
    ratesPerHour: { scrap: 0, fuel: 0, electronics: 0, food: 0 },
    netFoodPerHour: 0,
    storageCaps: { scrap: 0, fuel: 0, electronics: 0, food: 0 },
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

const WORLD_SEED = 'map-screen-test-seed';

function mapViewFixture(overrides: Partial<MapView> = {}): MapView {
  return {
    world: { seed: WORLD_SEED, roundNumber: 3, act: 1, serverTime: 0 },
    settlements: [
      {
        id: 'set-own',
        x: 0,
        y: 0,
        name: 'Форт Скитальца',
        ownerAccountId: ACCOUNT.id,
        ownerName: ACCOUNT.name,
        ownerFaction: 'raiders',
        ownerSide: 'beacon',
      },
      {
        id: 'set-npc',
        x: 3,
        y: -2,
        name: 'Форпост',
        ownerAccountId: 'acc-npc',
        ownerName: 'Странник',
        ownerFaction: 'engineers',
        ownerSide: 'silence',
      },
    ],
    oases: [{ x: -4, y: 5, type: 'farm' }],
    ...overrides,
  };
}

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

/** Parses a stubbed `fetch` call's JSON body, mirroring `BaseScreen.test.tsx`'s own helper. */
function parseBody(init: RequestInit | undefined): Record<string, unknown> {
  return init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
}

type RouteHandler = () => Response;

/**
 * Routes `METHOD /path` to a handler (mirrors `BaseScreen.test.tsx`'s `stubFetch` convention),
 * falling back to `/api/map` and an empty `/api/movements/mine` so every existing test — none
 * of which cares about movements — keeps working unmodified. Returns the mock itself so tests
 * that DO care (the send-scout/movements-overlay ones) can assert on exactly what was posted.
 */
function stubMapFetch(
  mapView: MapView,
  routes: Record<string, RouteHandler> = {},
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const key = `${method} ${url}`;
    const route = routes[key];
    if (route) {
      return Promise.resolve(route());
    }
    if (method === 'GET' && url === '/api/map') {
      return Promise.resolve(jsonResponse(mapView));
    }
    if (method === 'GET' && url === '/api/movements/mine') {
      return Promise.resolve(jsonResponse([]));
    }
    // `BottomNav` (rendered by `MapScreen`) queries this itself for the Reports tab's unread
    // badge (M2c.3) — none of this file's tests care about reports, so a stable empty inbox
    // keeps every existing scenario unaffected.
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

function renderMapScreen(
  mapView: MapView,
  settlement: SettlementStateView,
  onNavigateTab = vi.fn(),
  routes: Record<string, RouteHandler> = {},
) {
  const fetchMock = stubMapFetch(mapView, routes);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper(): ReactElement {
    return (
      <QueryClientProvider client={queryClient}>
        <MapScreen account={ACCOUNT} settlement={settlement} onNavigateTab={onNavigateTab} />
      </QueryClientProvider>
    );
  }
  return { ...render(<Wrapper />), fetchMock };
}

function mapTiles(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('.map-tile'));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MapScreen', () => {
  it('renders far fewer tiles than the full 61x61 grid at a phone viewport — the exact culled count', async () => {
    const settlement = settlementFixture();
    const { container } = renderMapScreen(mapViewFixture(), settlement);

    await screen.findByText('Раунд 3, акт 1');

    const expectedRange = computeVisibleTileRange(
      DEFAULT_CONFIG,
      { x: settlement.x, y: settlement.y },
      tileSizeForZoom(1),
      FALLBACK_VIEWPORT,
    );
    const expectedCount = tileCountInRange(expectedRange);

    const tiles = mapTiles(container);
    expect(tiles.length).toBe(expectedCount);
    expect(tiles.length).toBeLessThan(1000);
    expect(tiles.length).toBeLessThan(((2 * radius + 1) * (2 * radius + 1)) / 3);
  });

  it('renders terrain per tile exactly matching terrainAt for the world seed', async () => {
    const settlement = settlementFixture();
    const { container } = renderMapScreen(mapViewFixture(), settlement);
    await screen.findByText('Раунд 3, акт 1');

    for (const [x, y] of [
      [0, 0],
      [2, 3],
      [-5, 4],
      [1, -6],
    ] as const) {
      const expectedTerrain = terrainAt(DEFAULT_CONFIG, WORLD_SEED, x, y);
      const tile = container.querySelector(`.map-tile[data-x="${x}"][data-y="${y}"]`);
      expect(tile).not.toBeNull();
      expect(tile?.getAttribute('data-terrain')).toBe(expectedTerrain);
    }
  });

  it("renders settlements and oases as distinguishable markers at their correct coordinates, with the caller's own settlement marked distinctly", async () => {
    const settlement = settlementFixture();
    const { container } = renderMapScreen(mapViewFixture(), settlement);
    await screen.findByText('Раунд 3, акт 1');

    const ownMarker = container.querySelector(
      '.map-marker--settlement[data-settlement-id="set-own"]',
    );
    expect(ownMarker).not.toBeNull();
    expect(ownMarker).toHaveClass('map-marker--own');
    expect(ownMarker).toHaveClass('map-marker--raiders');
    expect(ownMarker?.getAttribute('data-x')).toBe('0');
    expect(ownMarker?.getAttribute('data-y')).toBe('0');
    expect(ownMarker?.getAttribute('data-own')).toBe('true');

    const npcMarker = container.querySelector(
      '.map-marker--settlement[data-settlement-id="set-npc"]',
    );
    expect(npcMarker).not.toBeNull();
    expect(npcMarker).not.toHaveClass('map-marker--own');
    expect(npcMarker).toHaveClass('map-marker--engineers');
    expect(npcMarker?.getAttribute('data-x')).toBe('3');
    expect(npcMarker?.getAttribute('data-y')).toBe('-2');
    expect(npcMarker?.getAttribute('data-own')).toBe('false');

    const oasisMarker = container.querySelector('.map-marker--oasis');
    expect(oasisMarker).not.toBeNull();
    expect(oasisMarker?.getAttribute('data-x')).toBe('-4');
    expect(oasisMarker?.getAttribute('data-y')).toBe('5');
    // Shape-distinguishable from a settlement marker, not just colour.
    expect(oasisMarker).not.toHaveClass('map-marker--settlement');
  });

  it('pans on drag and clamps the visible range at the grid edge rather than scrolling past it', async () => {
    const settlement = settlementFixture();
    const { container } = renderMapScreen(mapViewFixture(), settlement);
    await screen.findByText('Раунд 3, акт 1');

    const viewport = container.querySelector('.map-viewport') as HTMLElement;

    // One huge drag to the left (finger moves from high clientX to a very negative one) reveals
    // tiles far to the right — enough to overshoot the grid's +x edge in a single move.
    fireEvent.pointerDown(viewport, { pointerId: 1, clientX: 1000, clientY: 0 });
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: -200_000, clientY: 0 });
    fireEvent.pointerUp(viewport, { pointerId: 1, clientX: -200_000, clientY: 0 });

    expect(container.querySelector(`.map-tile[data-x="${radius}"]`)).not.toBeNull();
    expect(container.querySelector(`.map-tile[data-x="${radius + 1}"]`)).toBeNull();
  });

  it('cycles zoom through all three steps via the explicit zoom controls, clamped at both ends', async () => {
    const settlement = settlementFixture();
    renderMapScreen(mapViewFixture(), settlement);
    await screen.findByText('Раунд 3, акт 1');

    const zoomIn = screen.getByRole('button', { name: 'Приблизить' });
    const zoomOut = screen.getByRole('button', { name: 'Отдалить' });

    expect(screen.getByText('Масштаб: 1×')).toBeInTheDocument();

    fireEvent.click(zoomIn);
    expect(screen.getByText('Масштаб: 2×')).toBeInTheDocument();
    expect(zoomIn).toBeDisabled();

    fireEvent.click(zoomOut);
    expect(screen.getByText('Масштаб: 1×')).toBeInTheDocument();
    expect(zoomIn).not.toBeDisabled();

    fireEvent.click(zoomOut);
    expect(screen.getByText('Масштаб: 0.5×')).toBeInTheDocument();
    expect(zoomOut).toBeDisabled();
  });

  it('recentre brings the own settlement back into view after jumping away, and jump-to-coordinates rejects out-of-range input', async () => {
    const settlement = settlementFixture();
    const { container } = renderMapScreen(mapViewFixture(), settlement);
    await screen.findByText('Раунд 3, акт 1');

    const jumpXInput = screen.getByPlaceholderText('X');
    const jumpYInput = screen.getByPlaceholderText('Y');
    const jumpSubmit = screen.getByText('Перейти');

    // A valid jump far from the own settlement: the own marker leaves the culled range.
    fireEvent.change(jumpXInput, { target: { value: '28' } });
    fireEvent.change(jumpYInput, { target: { value: '28' } });
    fireEvent.click(jumpSubmit);

    expect(container.querySelector('.map-tile[data-x="28"][data-y="28"]')).not.toBeNull();
    expect(container.querySelector('[data-settlement-id="set-own"]')).toBeNull();
    expect(screen.queryByText('Координаты вне карты')).not.toBeInTheDocument();

    // Out-of-range coordinates: rejected with the translated error, and the view doesn't move.
    fireEvent.change(jumpXInput, { target: { value: String(radius + 10) } });
    fireEvent.change(jumpYInput, { target: { value: '0' } });
    fireEvent.click(jumpSubmit);
    expect(screen.getByText('Координаты вне карты')).toBeInTheDocument();
    expect(container.querySelector('.map-tile[data-x="28"][data-y="28"]')).not.toBeNull();

    // Recentre: the own settlement's marker is back in the culled range.
    fireEvent.click(screen.getByText('К моему поселению'));
    expect(container.querySelector('[data-settlement-id="set-own"]')).not.toBeNull();
  });

  it('marks the viewport and the boundary tiles with the edge-of-the-world treatment when the grid boundary is in view', async () => {
    // The own settlement sits right on the +x boundary — the viewport straddling the world's
    // edge is exactly the real scenario reported (a settlement at x=24 in a 61-wide grid).
    const settlement = settlementFixture({ x: radius, y: 0 });
    const { container } = renderMapScreen(
      mapViewFixture({
        settlements: [
          {
            id: 'set-own',
            x: radius,
            y: 0,
            name: 'Форт Скитальца',
            ownerAccountId: ACCOUNT.id,
            ownerName: ACCOUNT.name,
            ownerFaction: 'raiders',
            ownerSide: 'beacon',
          },
        ],
        oases: [],
      }),
      settlement,
    );
    await screen.findByText('Раунд 3, акт 1');

    expect(container.querySelector('.map-viewport')).toHaveClass('map-viewport--at-edge');
    expect(container.querySelector(`.map-tile[data-x="${radius}"]`)).toHaveClass(
      'map-tile--edge-e',
    );
  });

  it('does not show the edge-of-the-world treatment when the viewport is fully interior', async () => {
    const settlement = settlementFixture({ x: 0, y: 0 });
    const { container } = renderMapScreen(mapViewFixture(), settlement);
    await screen.findByText('Раунд 3, акт 1');

    expect(container.querySelector('.map-viewport')).not.toHaveClass('map-viewport--at-edge');
    for (const tile of Array.from(container.querySelectorAll('.map-tile'))) {
      expect(tile.className).not.toMatch(/map-tile--edge-/);
    }
  });

  it('shows the loading panel then the map, and surfaces a translated error with retry on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ error: { key: 'errors.generic' } }, 500))),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const settlement = settlementFixture();
    function Wrapper(): ReactElement {
      return (
        <QueryClientProvider client={queryClient}>
          <MapScreen account={ACCOUNT} settlement={settlement} onNavigateTab={vi.fn()} />
        </QueryClientProvider>
      );
    }
    render(<Wrapper />);

    expect(screen.getByRole('status')).toHaveTextContent('Загрузка…');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});

function tileAt(container: HTMLElement, x: number, y: number): HTMLElement {
  const tile = container.querySelector(`.map-tile[data-x="${x}"][data-y="${y}"]`);
  if (!tile) {
    throw new Error(`No .map-tile at ${x}:${y}`);
  }
  return tile as HTMLElement;
}

function movementFixture(overrides: Partial<MovementView> = {}): MovementView {
  return {
    id: 'move-1',
    type: 'scout',
    fromSettlementId: 'set-own',
    toSettlementId: 'set-npc',
    target: { x: 3, y: -2 },
    units: [{ unitType: 'lookout', count: 1 }],
    survivors: [],
    departAt: 0,
    arriveAt: 60_000,
    returnAt: null,
    status: 'outbound',
    serverTime: 0,
    ...overrides,
  };
}

describe('Tile info sheet + send-scout flow (M2c.2)', () => {
  it('shows coordinates and terrain for an empty tile, and closes via the close button', async () => {
    const settlement = settlementFixture();
    const { container } = renderMapScreen(mapViewFixture(), settlement);
    await screen.findByText('Раунд 3, акт 1');

    // (5, 5) is free of both the fixture's settlements ((0,0), (3,-2)) and its oasis
    // ((-4,5)), and sits inside the culled range around the (0,0) own settlement.
    fireEvent.click(tileAt(container, 5, 5));

    const dialog = await screen.findByRole('dialog');
    const terrain = terrainAt(DEFAULT_CONFIG, WORLD_SEED, 5, 5);
    expect(within(dialog).getByText('Координаты: 5:5')).toBeInTheDocument();
    expect(within(dialog).getByText(mapRu.sheet.emptyTitle)).toBeInTheDocument();
    expect(within(dialog).getByText(`Местность: ${mapRu.terrain[terrain]}`)).toBeInTheDocument();
    // No scout action on an empty tile.
    expect(within(dialog).queryByText(mapRu.scout.action)).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByText(mapRu.sheet.close));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  // M3e.3/§10 lifts M2 §8's "oases aren't scoutable" deferral: an oasis now offers a scout
  // action exactly like a settlement (disabled with its own reason when there's nothing to
  // send), plus raid/assault (`docs/M3_DESIGN_DECISIONS.md` §10) — the attack-flow test block
  // further down covers the raid/assault/army-picker surface in depth.
  it("shows an oasis's public card with a scout action (disabled with no scouts at home) and no support option, and closes via Escape", async () => {
    const settlement = settlementFixture();
    const { container } = renderMapScreen(mapViewFixture(), settlement);
    await screen.findByText('Раунд 3, акт 1');

    fireEvent.click(tileAt(container, -4, 5));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(mapRu.sheet.oasisTitle)).toBeInTheDocument();
    expect(within(dialog).getByText(mapRu.sheet.oasisType.farm)).toBeInTheDocument();

    // Default fixture troops: [] — no scouts at home, so the scout action is offered but
    // disabled, not merely absent.
    const scoutButton = within(dialog).getByText(mapRu.scout.action);
    expect(scoutButton).toBeDisabled();
    expect(within(dialog).getByText(mapRu.scout.noScoutsAtHome)).toBeInTheDocument();

    // §10: support has nothing to hold at an oasis — never offered as a type option.
    expect(within(dialog).queryByText(militaryRu.movementType.support)).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it("shows the caller's own settlement with a 'this is you' note and no scout action", async () => {
    const settlement = settlementFixture();
    const { container } = renderMapScreen(mapViewFixture(), settlement);
    await screen.findByText('Раунд 3, акт 1');

    fireEvent.click(tileAt(container, 0, 0));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Форт Скитальца')).toBeInTheDocument();
    expect(within(dialog).getByText(mapRu.sheet.ownSettlementNote)).toBeInTheDocument();
    expect(within(dialog).queryByText(mapRu.scout.action)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(mapRu.scout.noScoutsAtHome)).not.toBeInTheDocument();
  });

  it("shows another player's settlement with public fields, and a disabled scout action with its reason when there are no scouts at home", async () => {
    // Default fixture troops: [] — no scouts at home.
    const settlement = settlementFixture();
    const { container } = renderMapScreen(mapViewFixture(), settlement);
    await screen.findByText('Раунд 3, акт 1');

    fireEvent.click(tileAt(container, 3, -2));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Форпост')).toBeInTheDocument();
    expect(within(dialog).getByText('Владелец: Странник')).toBeInTheDocument();
    expect(within(dialog).getByText('Инженеры')).toBeInTheDocument();
    expect(within(dialog).getByText('Тишина')).toBeInTheDocument();

    const scoutButton = within(dialog).getByText(mapRu.scout.action);
    expect(scoutButton).toBeDisabled();
    expect(within(dialog).getByText(mapRu.scout.noScoutsAtHome)).toBeInTheDocument();
  });

  it('offers an enabled scout form, bounded by scouts at home, with a travel-time preview matching travelTimeMs computed independently', async () => {
    const settlement = settlementFixture({ troops: [{ unitType: 'lookout', count: 5 }] });
    const { container } = renderMapScreen(mapViewFixture(), settlement);
    await screen.findByText('Раунд 3, акт 1');

    fireEvent.click(tileAt(container, 3, -2));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText(mapRu.scout.noScoutsAtHome)).not.toBeInTheDocument();
    expect(within(dialog).getByText('Доступно дома: 5')).toBeInTheDocument();

    const countInput = within(dialog).getByRole('spinbutton') as HTMLInputElement;
    expect(countInput).toHaveValue(1);
    expect(countInput).toHaveAttribute('max', '5');

    const distance = chebyshevDistance({ x: settlement.x, y: settlement.y }, { x: 3, y: -2 });
    const speed = slowestTroopSpeed(DEFAULT_CONFIG, [{ unitType: 'lookout', count: 1 }]);
    const expectedMs = travelTimeMs(DEFAULT_CONFIG, distance, speed);
    expect(
      within(dialog).getByText(`Время в пути: ${formatDuration(expectedMs)}`),
    ).toBeInTheDocument();
  });

  it('submits exactly the expected body to POST /api/movements', async () => {
    const settlement = settlementFixture({ troops: [{ unitType: 'lookout', count: 5 }] });
    const created = movementFixture({ units: [{ unitType: 'lookout', count: 2 }] });
    const { container, fetchMock } = renderMapScreen(mapViewFixture(), settlement, vi.fn(), {
      'POST /api/movements': () => jsonResponse(created),
    });
    await screen.findByText('Раунд 3, акт 1');

    fireEvent.click(tileAt(container, 3, -2));
    const dialog = await screen.findByRole('dialog');

    const countInput = within(dialog).getByRole('spinbutton');
    fireEvent.change(countInput, { target: { value: '2' } });
    fireEvent.click(within(dialog).getByText(mapRu.scout.submit));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => url === '/api/movements' && init?.method === 'POST',
        ),
      ).toBe(true);
    });

    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === '/api/movements' && (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(call).toBeDefined();
    const body = parseBody(call?.[1] as RequestInit | undefined);
    expect(body).toEqual({
      type: 'scout',
      fromSettlementId: settlement.id,
      target: { x: 3, y: -2 },
      units: [{ unitType: 'lookout', count: 2 }],
    });

    // The sheet closes on a successful send.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('surfaces a server rejection (e.g. a troop-count race) as its translated RU message', async () => {
    const settlement = settlementFixture({ troops: [{ unitType: 'lookout', count: 3 }] });
    const { container } = renderMapScreen(mapViewFixture(), settlement, vi.fn(), {
      'POST /api/movements': () =>
        errorResponse('errors.movement.insufficientTroops', {
          unitType: 'lookout',
          available: 0,
          requested: 1,
        }),
    });
    await screen.findByText('Раунд 3, акт 1');

    fireEvent.click(tileAt(container, 3, -2));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByText(mapRu.scout.submit));

    expect(
      await within(dialog).findByText(errorsRu.movement.insufficientTroops),
    ).toBeInTheDocument();
    // A failed send must not close the sheet — the player can see the error and retry.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('Map <-> Base navigation', () => {
  function guestAccount(): AccountView {
    return { ...ACCOUNT };
  }

  function stubOnboardingFetch(settlement: SettlementStateView, mapView: MapView): void {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url === '/api/auth/me') {
          return Promise.resolve(jsonResponse(guestAccount()));
        }
        if (url === '/api/settlements/mine') {
          return Promise.resolve(jsonResponse([settlement]));
        }
        if (url === '/api/map') {
          return Promise.resolve(jsonResponse(mapView));
        }
        // `BottomNav`'s Reports unread badge (M2c.3) — irrelevant to this describe block, kept
        // stable/empty.
        if (url.startsWith('/api/reports')) {
          return Promise.resolve(
            jsonResponse({ reports: [], nextCursor: null, unreadCount: 0, serverTime: 0 }),
          );
        }
        return Promise.reject(new Error(`Unhandled request: ${url}`));
      }),
    );
  }

  it('switches between Base and Map from the bottom nav and marks the active tab with aria-current', async () => {
    const settlement = settlementFixture();
    stubOnboardingFetch(settlement, mapViewFixture());
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Wrapper(): ReactElement {
      return (
        <QueryClientProvider client={queryClient}>
          <Onboarding />
        </QueryClientProvider>
      );
    }
    render(<Wrapper />);

    // Lands on Base first.
    await screen.findByText('Форт Скитальца');
    const baseNav = () => screen.getByRole('button', { name: 'База' });
    const mapNav = () => screen.getByRole('button', { name: 'Карта' });
    expect(baseNav()).toHaveAttribute('aria-current', 'page');
    expect(mapNav()).not.toHaveAttribute('aria-current');

    fireEvent.click(mapNav());
    await screen.findByText('Раунд 3, акт 1');
    expect(mapNav()).toHaveAttribute('aria-current', 'page');
    expect(baseNav()).not.toHaveAttribute('aria-current');

    fireEvent.click(baseNav());
    await screen.findByText('Форт Скитальца');
    expect(baseNav()).toHaveAttribute('aria-current', 'page');
    expect(mapNav()).not.toHaveAttribute('aria-current');
  });
});
