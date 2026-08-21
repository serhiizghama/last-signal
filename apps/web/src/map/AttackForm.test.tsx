import type { ReactElement } from 'react';
import {
  DEFAULT_CONFIG,
  chebyshevDistance,
  formatDuration,
  slowestTroopSpeed,
  travelTimeMs,
} from '@last-signal/game-core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AccountView,
  MapSettlementView,
  MapView,
  MovementView,
  SettlementStateView,
} from '../api/types';
import errorsRu from '../i18n/locales/ru/errors.json';
import mapRu from '../i18n/locales/ru/map.json';
import militaryRu from '../i18n/locales/ru/military.json';
import unitsRu from '../i18n/locales/ru/units.json';
import { MapScreen } from './MapScreen';

// Everything below mirrors `MapScreen.test.tsx`'s own fixtures/render-harness conventions
// (each test file in this directory keeps its own copy — see `MovementsOverlay.test.tsx`'s
// identical duplication) — this file is scoped to M3e.3's attack flow (the raid/assault/
// support form, protection badges, and the target-legality matrix) so it doesn't grow that
// already-large file further; the send-scout flow itself stays exactly where M2c.2 put it.

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

const WORLD_SEED = 'attack-form-test-seed';

function ownSettlementEntry(): MapSettlementView {
  return {
    id: 'set-own',
    x: 0,
    y: 0,
    name: 'Форт Скитальца',
    ownerAccountId: ACCOUNT.id,
    ownerName: ACCOUNT.name,
    ownerFaction: 'raiders',
    ownerSide: 'beacon',
  };
}

function foreignSettlementEntry(overrides: Partial<MapSettlementView> = {}): MapSettlementView {
  return {
    id: 'set-npc',
    x: 3,
    y: -2,
    name: 'Форпост',
    ownerAccountId: 'acc-npc',
    ownerName: 'Странник',
    ownerFaction: 'engineers',
    ownerSide: 'silence',
    ...overrides,
  };
}

function mapViewFixture(overrides: Partial<MapView> = {}): MapView {
  return {
    world: { seed: WORLD_SEED, roundNumber: 3, act: 1, serverTime: 0 },
    settlements: [ownSettlementEntry(), foreignSettlementEntry()],
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

function parseBody(init: RequestInit | undefined): Record<string, unknown> {
  return init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
}

function movementFixture(overrides: Partial<MovementView> = {}): MovementView {
  return {
    id: 'move-1',
    type: 'raid',
    fromSettlementId: 'set-own',
    toSettlementId: 'set-npc',
    target: { x: 3, y: -2 },
    units: [{ unitType: 'brute', count: 1 }],
    survivors: [],
    departAt: 0,
    arriveAt: 60_000,
    returnAt: null,
    status: 'outbound',
    serverTime: 0,
    ...overrides,
  };
}

type RouteHandler = () => Response;

function stubMapFetch(
  mapView: MapView,
  routes: Record<string, RouteHandler> = {},
  getMovementsMine: () => MovementView[] = () => [],
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
      return Promise.resolve(jsonResponse(getMovementsMine()));
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

function renderMapScreen(
  mapView: MapView,
  settlement: SettlementStateView,
  routes: Record<string, RouteHandler> = {},
  getMovementsMine: () => MovementView[] = () => [],
) {
  const fetchMock = stubMapFetch(mapView, routes, getMovementsMine);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper(): ReactElement {
    return (
      <QueryClientProvider client={queryClient}>
        <MapScreen account={ACCOUNT} settlement={settlement} onNavigateTab={vi.fn()} />
      </QueryClientProvider>
    );
  }
  return { ...render(<Wrapper />), fetchMock };
}

function tileAt(container: HTMLElement, x: number, y: number): HTMLElement {
  const tile = container.querySelector(`.map-tile[data-x="${x}"][data-y="${y}"]`);
  if (!tile) {
    throw new Error(`No .map-tile at ${x}:${y}`);
  }
  return tile as HTMLElement;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Army picker (§1/§9 role rules)', () => {
  it('is bounded by settlement.troops and cannot select a scout for a raid or an assault, nor a siege unit for a raid', async () => {
    const settlement = settlementFixture({
      troops: [
        { unitType: 'brute', count: 10 },
        { unitType: 'lookout', count: 3 },
        { unitType: 'ramTruck', count: 2 },
      ],
    });
    const { container } = renderMapScreen(mapViewFixture(), settlement);
    await screen.findByText('Раунд 3, акт 1');

    fireEvent.click(tileAt(container, 3, -2));
    const dialog = await screen.findByRole('dialog');

    // Default movement type is 'raid' (allowedTypes[0] for a foreign settlement).
    const bruteInput = within(dialog).getByLabelText(unitsRu.brute.name) as HTMLInputElement;
    expect(bruteInput).toHaveAttribute('max', '10');
    expect(within(dialog).queryByLabelText(unitsRu.lookout.name)).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText(unitsRu.ramTruck.name)).not.toBeInTheDocument();

    // Switching to assault reveals the siege unit but still never the scout.
    fireEvent.click(within(dialog).getByLabelText(militaryRu.movementType.assault));
    expect(within(dialog).getByLabelText(unitsRu.ramTruck.name)).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(unitsRu.lookout.name)).not.toBeInTheDocument();

    // Switching to support reveals the scout (§8) but never the siege unit.
    fireEvent.click(within(dialog).getByLabelText(militaryRu.movementType.support));
    expect(within(dialog).getByLabelText(unitsRu.lookout.name)).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(unitsRu.ramTruck.name)).not.toBeInTheDocument();
  });
});

describe('Siege target picker (§7)', () => {
  it('appears only once a siege unit is selected, and blocks submission until one is chosen', async () => {
    const settlement = settlementFixture({
      troops: [
        { unitType: 'brute', count: 5 },
        { unitType: 'ramTruck', count: 2 },
      ],
    });
    const { container } = renderMapScreen(mapViewFixture(), settlement);
    await screen.findByText('Раунд 3, акт 1');

    fireEvent.click(tileAt(container, 3, -2));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByLabelText(militaryRu.movementType.assault));

    expect(within(dialog).queryByLabelText(mapRu.attack.siegeTargetLabel)).not.toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText(unitsRu.ramTruck.name), {
      target: { value: '1' },
    });

    expect(within(dialog).getByLabelText(mapRu.attack.siegeTargetLabel)).toBeInTheDocument();
    expect(within(dialog).getByText(errorsRu.movement.siegeTargetRequired)).toBeInTheDocument();
    const submitButton = within(dialog).getByText(mapRu.attack.submitLabel.assault);
    expect(submitButton).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText(mapRu.attack.siegeTargetLabel), {
      target: { value: 'wall' },
    });
    expect(
      within(dialog).queryByText(errorsRu.movement.siegeTargetRequired),
    ).not.toBeInTheDocument();
    expect(submitButton).not.toBeDisabled();
  });
});

describe('Travel-time preview', () => {
  it('matches travelTimeMs computed independently, and changes when a slower unit is added', async () => {
    const settlement = settlementFixture({
      troops: [
        { unitType: 'brute', count: 5 },
        { unitType: 'ramTruck', count: 2 },
      ],
    });
    const { container } = renderMapScreen(mapViewFixture(), settlement);
    await screen.findByText('Раунд 3, акт 1');

    fireEvent.click(tileAt(container, 3, -2));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByLabelText(militaryRu.movementType.assault));
    fireEvent.change(within(dialog).getByLabelText(unitsRu.brute.name), { target: { value: '3' } });

    const distance = chebyshevDistance({ x: 0, y: 0 }, { x: 3, y: -2 });
    const bruteOnlySpeed = slowestTroopSpeed(DEFAULT_CONFIG, [{ unitType: 'brute', count: 3 }]);
    const bruteOnlyMs = travelTimeMs(DEFAULT_CONFIG, distance, bruteOnlySpeed);
    expect(
      within(dialog).getByText(`Время в пути: ${formatDuration(bruteOnlyMs)}`),
    ).toBeInTheDocument();

    // ramTruck (speed 4) is slower than brute (speed 7) — adding it must slow the whole army.
    fireEvent.change(within(dialog).getByLabelText(unitsRu.ramTruck.name), {
      target: { value: '1' },
    });
    const withRamTruckSpeed = slowestTroopSpeed(DEFAULT_CONFIG, [
      { unitType: 'brute', count: 3 },
      { unitType: 'ramTruck', count: 1 },
    ]);
    const withRamTruckMs = travelTimeMs(DEFAULT_CONFIG, distance, withRamTruckSpeed);
    expect(withRamTruckMs).toBeGreaterThan(bruteOnlyMs);
    expect(
      within(dialog).getByText(`Время в пути: ${formatDuration(withRamTruckMs)}`),
    ).toBeInTheDocument();
  });
});

describe('Beginner protection badges (§11)', () => {
  it('a protected target renders the badge and disables scout/raid/assault/support with the shared reason', async () => {
    const mapView = mapViewFixture({
      settlements: [ownSettlementEntry(), foreignSettlementEntry({ protectedUntil: 999_999_999 })],
    });
    const settlement = settlementFixture({
      troops: [
        { unitType: 'brute', count: 5 },
        { unitType: 'lookout', count: 2 },
      ],
    });
    const { container } = renderMapScreen(mapView, settlement);
    await screen.findByText('Раунд 3, акт 1');

    const marker = container.querySelector('[data-settlement-id="set-npc"]');
    expect(marker).toHaveAttribute('data-protected', 'true');

    fireEvent.click(tileAt(container, 3, -2));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText(mapRu.sheet.protectedBadge)).toBeInTheDocument();
    expect(within(dialog).getByText(mapRu.scout.action)).toBeDisabled();
    expect(within(dialog).getByText(mapRu.attack.action)).toBeDisabled();
    expect(
      within(dialog).getAllByText(errorsRu.movement.targetProtected).length,
    ).toBeGreaterThanOrEqual(2);

    // No army/type picker at all while protected — the form never lets the player build an
    // army for a target the server will reject.
    expect(within(dialog).queryByLabelText(unitsRu.brute.name)).not.toBeInTheDocument();
  });

  it('an expired protectedUntil does not disable anything', async () => {
    const mapView = mapViewFixture({
      settlements: [ownSettlementEntry(), foreignSettlementEntry({ protectedUntil: -1_000_000 })],
    });
    const settlement = settlementFixture({ troops: [{ unitType: 'brute', count: 5 }] });
    const { container } = renderMapScreen(mapView, settlement);
    await screen.findByText('Раунд 3, акт 1');

    const marker = container.querySelector('[data-settlement-id="set-npc"]');
    expect(marker).toHaveAttribute('data-protected', 'false');

    fireEvent.click(tileAt(container, 3, -2));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).queryByText(mapRu.sheet.protectedBadge)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(errorsRu.movement.targetProtected)).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText(unitsRu.brute.name)).toBeInTheDocument();
  });
});

describe('Target-legality matrix (§9/§10/§8/M3c.6)', () => {
  it('an oasis never offers support', async () => {
    const settlement = settlementFixture({ troops: [{ unitType: 'brute', count: 3 }] });
    const { container } = renderMapScreen(mapViewFixture(), settlement);
    await screen.findByText('Раунд 3, акт 1');

    fireEvent.click(tileAt(container, -4, 5));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByLabelText(militaryRu.movementType.raid)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(militaryRu.movementType.assault)).toBeInTheDocument();
    expect(
      within(dialog).queryByLabelText(militaryRu.movementType.support),
    ).not.toBeInTheDocument();
  });

  it("another of the caller's own settlements offers support only", async () => {
    const mapView = mapViewFixture({
      settlements: [
        ownSettlementEntry(),
        {
          id: 'set-own-2',
          x: 5,
          y: 5,
          name: 'Вторая застава',
          ownerAccountId: ACCOUNT.id,
          ownerName: ACCOUNT.name,
          ownerFaction: 'raiders',
          ownerSide: 'beacon',
        },
      ],
    });
    const settlement = settlementFixture({
      troops: [
        { unitType: 'brute', count: 3 },
        { unitType: 'lookout', count: 2 },
      ],
    });
    const { container } = renderMapScreen(mapView, settlement);
    await screen.findByText('Раунд 3, акт 1');

    fireEvent.click(tileAt(container, 5, 5));
    const dialog = await screen.findByRole('dialog');

    // No scout action for your own settlement — `ScoutForm` is never rendered there.
    expect(within(dialog).queryByText(mapRu.scout.action)).not.toBeInTheDocument();
    // Only one legal type — the picker fieldset (which needs > 1 option) never renders.
    expect(within(dialog).queryByLabelText(militaryRu.movementType.raid)).not.toBeInTheDocument();
    // Support may carry scouts too (§8), so both rows are offered.
    expect(within(dialog).getByLabelText(unitsRu.brute.name)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(unitsRu.lookout.name)).toBeInTheDocument();
    expect(within(dialog).getByText(mapRu.attack.submitLabel.support)).toBeInTheDocument();
  });

  it('the origin settlement itself offers nothing at all', async () => {
    const settlement = settlementFixture({ troops: [{ unitType: 'brute', count: 3 }] });
    const { container } = renderMapScreen(mapViewFixture(), settlement);
    await screen.findByText('Раунд 3, акт 1');

    fireEvent.click(tileAt(container, 0, 0));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText(mapRu.sheet.ownSettlementNote)).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(unitsRu.brute.name)).not.toBeInTheDocument();
  });
});

describe('Sending a movement (§9/§18)', () => {
  it('submits exactly the expected body to POST /api/movements, with no siegeTarget when none applies', async () => {
    const settlement = settlementFixture({ troops: [{ unitType: 'brute', count: 5 }] });
    let movementsMine: MovementView[] = [];
    const created = movementFixture({ type: 'raid', units: [{ unitType: 'brute', count: 3 }] });

    const { container, fetchMock } = renderMapScreen(
      mapViewFixture(),
      settlement,
      {
        'POST /api/movements': () => {
          movementsMine = [created];
          return jsonResponse(created);
        },
      },
      () => movementsMine,
    );
    await screen.findByText('Раунд 3, акт 1');

    fireEvent.click(tileAt(container, 3, -2));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(unitsRu.brute.name), { target: { value: '3' } });
    fireEvent.click(within(dialog).getByText(mapRu.attack.submitLabel.raid));

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
    const body = parseBody(call?.[1] as RequestInit | undefined);
    expect(body).toEqual({
      type: 'raid',
      fromSettlementId: settlement.id,
      target: { x: 3, y: -2 },
      units: [{ unitType: 'brute', count: 3 }],
    });

    // The sheet closes on a successful send, and the 90s cancel affordance then appears —
    // the same generic overlay `ScoutForm`'s own send already exercises, unchanged here.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(mapRu.movements.cancel)).toBeInTheDocument());
  });

  it('includes siegeTarget only for an assault that actually carries a surviving siege selection', async () => {
    const settlement = settlementFixture({ troops: [{ unitType: 'ramTruck', count: 2 }] });
    const created = movementFixture({
      type: 'assault',
      units: [{ unitType: 'ramTruck', count: 1 }],
    });

    const { container, fetchMock } = renderMapScreen(mapViewFixture(), settlement, {
      'POST /api/movements': () => jsonResponse(created),
    });
    await screen.findByText('Раунд 3, акт 1');

    fireEvent.click(tileAt(container, 3, -2));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByLabelText(militaryRu.movementType.assault));
    fireEvent.change(within(dialog).getByLabelText(unitsRu.ramTruck.name), {
      target: { value: '1' },
    });
    fireEvent.change(within(dialog).getByLabelText(mapRu.attack.siegeTargetLabel), {
      target: { value: 'wall' },
    });
    fireEvent.click(within(dialog).getByText(mapRu.attack.submitLabel.assault));

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
    const body = parseBody(call?.[1] as RequestInit | undefined);
    expect(body).toEqual({
      type: 'assault',
      fromSettlementId: settlement.id,
      target: { x: 3, y: -2 },
      units: [{ unitType: 'ramTruck', count: 1 }],
      siegeTarget: 'wall',
    });
  });
});
