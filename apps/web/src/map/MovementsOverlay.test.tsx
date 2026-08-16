import type { ReactElement } from 'react';
import { DEFAULT_CONFIG, formatDuration } from '@last-signal/game-core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MovementView } from '../api/types';
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

function renderOverlay(movements: MovementView[], routes: Record<string, RouteHandler> = {}) {
  const fetchMock = stubFetch(movements, routes);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper(): ReactElement {
    return (
      <QueryClientProvider client={queryClient}>
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
