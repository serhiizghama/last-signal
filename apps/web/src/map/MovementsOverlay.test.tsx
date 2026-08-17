import type { ReactElement } from 'react';
import { DEFAULT_CONFIG, formatDuration } from '@last-signal/game-core';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchMySettlements } from '../api/endpoints';
import type { MovementView } from '../api/types';
import { SETTLEMENTS_MINE_KEY } from '../base/settlementCache';
import mapRu from '../i18n/locales/ru/map.json';
import { MovementsOverlay } from './MovementsOverlay';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

function movementFixture(overrides: Partial<MovementView> = {}): MovementView {
  return {
    id: 'move-1',
    type: 'scout',
    fromSettlementId: 'set-own',
    toSettlementId: 'set-npc',
    target: { x: 5, y: -5 },
    units: [{ unitType: 'lookout', count: 2 }],
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

function stubFetch(
  movements: MovementView[],
  routes: Record<string, RouteHandler> = {},
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const key = `${method} ${url}`;
    const route = routes[key];
    if (route) {
      return Promise.resolve(route());
    }
    if (method === 'GET' && url === '/api/movements/mine') {
      return Promise.resolve(jsonResponse(movements));
    }
    return Promise.reject(new Error(`Unhandled request: ${key}`));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/**
 * `queryClient.invalidateQueries` only ever triggers a network refetch for an *active*
 * (currently-observed) query — mounting this alongside `MovementsOverlay` is what makes the
 * settlements-refresh side effect (the returning -> done boundary) observable at all, the same
 * way `SettlementGate` keeps `SETTLEMENTS_MINE_KEY` active for real whenever the Map tab is
 * showing.
 */
function SettlementsObserver(): null {
  useQuery({
    queryKey: SETTLEMENTS_MINE_KEY,
    queryFn: ({ signal }) => fetchMySettlements(signal),
  });
  return null;
}

function renderOverlay(
  movements: MovementView[],
  routes: Record<string, RouteHandler> = {},
  { withSettlementsObserver = false }: { withSettlementsObserver?: boolean } = {},
) {
  const fetchMock = stubFetch(movements, routes);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper(): ReactElement {
    return (
      <QueryClientProvider client={queryClient}>
        {withSettlementsObserver && <SettlementsObserver />}
        <MovementsOverlay />
      </QueryClientProvider>
    );
  }
  return { ...render(<Wrapper />), fetchMock };
}

/** Flushes the initial `movements/mine` query under fake timers (a microtask round trip, not a real timer) — mirrors `BaseScreen.test.tsx`'s own `flushLoad`. */
async function flushLoad(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('MovementsOverlay', () => {
  it('renders nothing when the caller has no open movements', async () => {
    const { container, fetchMock } = renderOverlay([]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.querySelector('.movements-overlay')).toBeNull();
  });

  it('lists an outbound movement with a countdown that actually advances with fake timers', async () => {
    vi.useFakeTimers();
    const movement = movementFixture({ departAt: 0, arriveAt: 60_000, serverTime: 0 });
    renderOverlay([movement]);
    await flushLoad();

    expect(screen.getByText(mapRu.movements.outboundStatus)).toBeInTheDocument();
    expect(screen.getByText('Прибытие через 01:00')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(screen.getByText('Прибытие через 00:50')).toBeInTheDocument();
  });

  it('shows the cancel button inside the 90s recall window and hides it once the window has passed', async () => {
    vi.useFakeTimers();
    // `arriveAt` set far past the cancel window so the arrival countdown never hits zero
    // during this test — only the separate cancel-window countdown is under test here.
    const movement = movementFixture({ departAt: 0, arriveAt: 200_000, serverTime: 0 });
    renderOverlay([movement]);
    await flushLoad();

    expect(screen.getByText(mapRu.movements.cancel)).toBeInTheDocument();

    const cancelWindowMs = DEFAULT_CONFIG.movement.cancelWindowMs;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(cancelWindowMs + 1_000);
    });

    expect(screen.queryByText(mapRu.movements.cancel)).not.toBeInTheDocument();
  });

  it('calls the cancel endpoint when the cancel button is clicked', async () => {
    const movement = movementFixture({ departAt: 0, arriveAt: 200_000, serverTime: 0 });
    const cancelled = movementFixture({
      departAt: 0,
      arriveAt: 200_000,
      status: 'returning',
      returnAt: 20_000,
      survivors: [{ unitType: 'lookout', count: 2 }],
    });
    const { fetchMock } = renderOverlay([movement], {
      'POST /api/movements/move-1/cancel': () => jsonResponse(cancelled),
    });
    await waitFor(() => expect(screen.getByText(mapRu.movements.cancel)).toBeInTheDocument());

    fireEvent.click(screen.getByText(mapRu.movements.cancel));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            url === '/api/movements/move-1/cancel' &&
            (init as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true);
    });
  });

  // Boundary regression (found in review): the countdown reaching zero is not the same event
  // as the server actually having applied `movementArrive` — without a refetch the row froze
  // showing "Прибытие через 00:00" (or a stale non-zero value) forever. Advances fake time
  // *past* the boundary (not just toward it) and asserts the refetch actually happened and the
  // row actually transitioned, mirroring `BaseScreen.test.tsx`'s own training-order boundary
  // test (same staged-response shape: stale-then-resolved across the grace period).
  it("refetches once the outbound countdown crosses its arrival boundary, and the row flips to 'returning' with its own countdown", async () => {
    vi.useFakeTimers();
    let mineCallCount = 0;
    const outbound = movementFixture({ departAt: 0, arriveAt: 60_000, serverTime: 0 });
    const returning = movementFixture({
      status: 'returning',
      departAt: 0,
      arriveAt: 60_000,
      returnAt: 150_000,
      survivors: [{ unitType: 'lookout', count: 2 }],
      serverTime: 60_000,
    });

    renderOverlay([], {
      'GET /api/movements/mine': () => {
        mineCallCount += 1;
        return jsonResponse(mineCallCount === 1 ? [outbound] : [returning]);
      },
    });
    await flushLoad();

    expect(mineCallCount).toBe(1);
    expect(screen.getByText(mapRu.movements.outboundStatus)).toBeInTheDocument();

    // Exactly at the boundary: the countdown clamps to 00:00, but the grace period (1.5s)
    // hasn't elapsed yet, so no refetch has fired — the row must still read "outbound", not
    // silently flip or vanish.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await flushLoad();
    expect(mineCallCount).toBe(1);
    expect(screen.getByText(mapRu.movements.outboundStatus)).toBeInTheDocument();

    // Past the grace period: the boundary refetch fires and the row flips.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await flushLoad();

    expect(mineCallCount).toBe(2);
    expect(screen.queryByText(mapRu.movements.outboundStatus)).not.toBeInTheDocument();
    expect(screen.getByText(mapRu.movements.returningStatus)).toBeInTheDocument();
    expect(
      screen.getByText(
        `Возвращение через ${formatDuration((returning.returnAt ?? 0) - returning.serverTime)}`,
      ),
    ).toBeInTheDocument();
  });

  it("refetches once the returning countdown crosses its return boundary, drops the movement from the overlay, and refreshes the settlement's troops", async () => {
    vi.useFakeTimers();
    let mineCallCount = 0;
    let settlementsCallCount = 0;
    const returning = movementFixture({
      status: 'returning',
      departAt: 0,
      arriveAt: 30_000,
      returnAt: 60_000,
      survivors: [{ unitType: 'lookout', count: 2 }],
      serverTime: 0,
    });
    const done = movementFixture({
      status: 'done',
      departAt: 0,
      arriveAt: 30_000,
      returnAt: 60_000,
      survivors: [{ unitType: 'lookout', count: 2 }],
      serverTime: 60_000,
    });

    renderOverlay(
      [],
      {
        'GET /api/movements/mine': () => {
          mineCallCount += 1;
          return jsonResponse(mineCallCount === 1 ? [returning] : [done]);
        },
        'GET /api/settlements/mine': () => {
          settlementsCallCount += 1;
          return jsonResponse([]);
        },
      },
      { withSettlementsObserver: true },
    );
    await flushLoad();

    expect(mineCallCount).toBe(1);
    expect(settlementsCallCount).toBe(1);
    expect(screen.getByText(mapRu.movements.returningStatus)).toBeInTheDocument();

    // Exactly at the return boundary: grace period hasn't elapsed, nothing has refetched yet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await flushLoad();
    expect(mineCallCount).toBe(1);
    expect(screen.getByText(mapRu.movements.returningStatus)).toBeInTheDocument();

    // Past the grace period: both the movement and the settlement refetch, the row disappears
    // (the movement is now `done`, filtered out client-side), and the whole overlay renders
    // nothing since it was the only open movement.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await flushLoad();

    expect(mineCallCount).toBe(2);
    expect(settlementsCallCount).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(mapRu.movements.returningStatus)).not.toBeInTheDocument();
    expect(document.querySelector('.movements-overlay')).toBeNull();
  });

  it('shows a returning movement distinctly from an outbound one, with its surviving units and no cancel action', async () => {
    const movement = movementFixture({
      status: 'returning',
      departAt: 0,
      arriveAt: 30_000,
      returnAt: 45_000,
      serverTime: 0,
      units: [{ unitType: 'lookout', count: 2 }],
      survivors: [{ unitType: 'lookout', count: 1 }],
    });
    renderOverlay([movement]);
    await waitFor(() =>
      expect(screen.getByText(mapRu.movements.returningStatus)).toBeInTheDocument(),
    );

    expect(screen.queryByText(mapRu.movements.outboundStatus)).not.toBeInTheDocument();
    expect(screen.getByText(`Возвращение через ${formatDuration(45_000)}`)).toBeInTheDocument();
    // Survivors (1), not the original marching count (2) — the returning list must read from
    // `survivors`, not `units`.
    expect(screen.getByText(/Дозорный ×1/)).toBeInTheDocument();
    expect(screen.queryByText(mapRu.movements.cancel)).not.toBeInTheDocument();
  });
});
