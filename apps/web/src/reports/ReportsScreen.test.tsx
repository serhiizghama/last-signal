import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { io } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MapView, ReportsPageView, ReportView } from '../api/types';
import reportsRu from '../i18n/locales/ru/reports.json';
import { resetSocketForTests } from '../realtime/socketClient';
import { useReportsRealtime } from '../realtime/useReportsRealtime';
import type {
  ScoutCombatPayload,
  ScoutDetectedPayload,
  ScoutTargetNotFoundPayload,
} from './reportPayload';
import { ReportsScreen } from './ReportsScreen';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

function emptyPage(overrides: Partial<ReportsPageView> = {}): ReportsPageView {
  return { reports: [], nextCursor: null, unreadCount: 0, serverTime: 0, ...overrides };
}

function scoutCombatPayload(overrides: Partial<ScoutCombatPayload> = {}): ScoutCombatPayload {
  return {
    movementId: 'move-1',
    fromSettlementId: 'set-own',
    toSettlementId: 'set-npc',
    target: { x: 3, y: -2 },
    atkPts: 10,
    defPts: 4,
    lossFraction: 0.2,
    losses: [{ unitType: 'lookout', count: 1 }],
    survivors: [{ unitType: 'lookout', count: 4 }],
    intel: {
      tier: 'base',
      resources: { scrap: 123, fuel: 45, electronics: 6, food: 789 },
      storageCaps: { scrap: 1000, fuel: 1000, electronics: 1000, food: 1000 },
      troops: [{ unitType: 'lookout', count: 2 }],
    },
    ...overrides,
  };
}

function scoutDetectedPayload(overrides: Partial<ScoutDetectedPayload> = {}): ScoutDetectedPayload {
  return {
    movementId: 'move-2',
    attackerSettlementId: 'set-npc',
    attackerAccountId: 'acc-npc',
    at: 5_000,
    ...overrides,
  };
}

function targetNotFoundPayload(
  overrides: Partial<ScoutTargetNotFoundPayload> = {},
): ScoutTargetNotFoundPayload {
  return {
    movementId: 'move-3',
    fromSettlementId: 'set-own',
    target: { x: 9, y: 9 },
    reason: 'targetNotFound',
    ...overrides,
  };
}

function reportFixture(overrides: Partial<ReportView> = {}): ReportView {
  return {
    id: 'rep-1',
    type: 'scout',
    read: false,
    createdAt: 1_000,
    payload: scoutCombatPayload() as unknown as Record<string, unknown>,
    serverTime: 2_000,
    ...overrides,
  };
}

const MAP_VIEW: MapView = {
  world: { seed: 'reports-test-seed', roundNumber: 1, act: 1, serverTime: 0 },
  settlements: [
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
  oases: [],
};

type RouteHandler = () => Response;
type PageSource = () => ReportsPageView;

function stubReportsFetch(
  routes: Record<string, RouteHandler>,
  listPage: PageSource,
  unreadPage: PageSource,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const key = `${method} ${url}`;
    const route = routes[key];
    if (route) {
      return Promise.resolve(route());
    }
    if (method === 'GET' && url === '/api/reports') {
      return Promise.resolve(jsonResponse(listPage()));
    }
    if (method === 'GET' && url === '/api/reports?limit=1') {
      return Promise.resolve(jsonResponse(unreadPage()));
    }
    if (method === 'GET' && url === '/api/map') {
      return Promise.resolve(jsonResponse(MAP_VIEW));
    }
    return Promise.reject(new Error(`Unhandled request: ${key}`));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderReportsScreen(
  routes: Record<string, RouteHandler> = {},
  listPage: PageSource = emptyPage,
  unreadPage: PageSource = listPage,
): { fetchMock: ReturnType<typeof vi.fn>; queryClient: QueryClient } & ReturnType<typeof render> {
  const fetchMock = stubReportsFetch(routes, listPage, unreadPage);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper(): ReactElement {
    return (
      <QueryClientProvider client={queryClient}>
        <ReportsScreen onNavigateTab={vi.fn()} />
      </QueryClientProvider>
    );
  }
  return { ...render(<Wrapper />), fetchMock, queryClient };
}

/** Only the live-update test needs the realtime subscription — mirrors production's `SettlementGate`, which mounts `useReportsRealtime` alongside whichever screen is active. */
function renderReportsScreenWithRealtime(
  routes: Record<string, RouteHandler>,
  listPage: PageSource,
  unreadPage: PageSource,
): { fetchMock: ReturnType<typeof vi.fn>; queryClient: QueryClient } & ReturnType<typeof render> {
  const fetchMock = stubReportsFetch(routes, listPage, unreadPage);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness(): ReactElement {
    useReportsRealtime();
    return <ReportsScreen onNavigateTab={vi.fn()} />;
  }
  function Wrapper(): ReactElement {
    return (
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>
    );
  }
  return { ...render(<Wrapper />), fetchMock, queryClient };
}

function reportsNavButton(): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(reportsRu.title) });
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetSocketForTests();
});

describe('ReportsScreen — list', () => {
  it('renders reports newest-first with unread state visually distinct, and load more requests the next page with the returned cursor', async () => {
    const page1: ReportsPageView = {
      reports: [
        reportFixture({
          id: 'rep-new',
          type: 'scoutDetected',
          read: false,
          createdAt: 2_000,
          payload: scoutDetectedPayload() as unknown as Record<string, unknown>,
        }),
        reportFixture({ id: 'rep-old', type: 'scout', read: true, createdAt: 1_000 }),
      ],
      nextCursor: 'cursor-abc',
      unreadCount: 1,
      serverTime: 0,
    };
    const page2: ReportsPageView = {
      reports: [
        reportFixture({
          id: 'rep-oldest',
          type: 'scoutFailed',
          read: true,
          createdAt: 500,
          payload: targetNotFoundPayload() as unknown as Record<string, unknown>,
        }),
      ],
      nextCursor: null,
      unreadCount: 1,
      serverTime: 0,
    };

    const { container, fetchMock } = renderReportsScreen(
      { 'GET /api/reports?cursor=cursor-abc': () => jsonResponse(page2) },
      () => page1,
    );

    await screen.findByText(reportsRu.list.scoutDetected);
    const rows = () => Array.from(container.querySelectorAll('.report-row'));
    // Newest first: the detected report (createdAt 2000) before the older scout report (1000).
    expect(rows()[0]).toHaveTextContent(reportsRu.list.scoutDetected);
    expect(rows()[1]).toHaveTextContent(reportsRu.list.scout);
    expect(rows()[0]).toHaveClass('report-row--unread');
    expect(rows()[1]).not.toHaveClass('report-row--unread');

    expect(screen.queryByText(reportsRu.list.scoutFailed)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText(reportsRu.loadMore));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) => url === '/api/reports?cursor=cursor-abc'),
      ).toBe(true);
    });

    expect(await screen.findByText(reportsRu.list.scoutFailed)).toBeInTheDocument();
    // No further cursor: the affordance disappears once the last page is loaded.
    expect(screen.queryByText(reportsRu.loadMore)).not.toBeInTheDocument();
  });

  it('shows the empty state when the account has no reports', async () => {
    renderReportsScreen();
    expect(await screen.findByText(reportsRu.empty)).toBeInTheDocument();
  });
});

describe('ReportsScreen — read-on-open and the unread badge', () => {
  it('opening an unread report calls GET /api/reports/:id and the unread badge drops accordingly', async () => {
    let read = false;
    const currentReport = (): ReportView =>
      reportFixture({ id: 'rep-1', type: 'scout', read, createdAt: 1_000 });
    const page = (): ReportsPageView => ({
      reports: [currentReport()],
      nextCursor: null,
      unreadCount: read ? 0 : 1,
      serverTime: 0,
    });

    const { fetchMock } = renderReportsScreen(
      {
        'GET /api/reports/rep-1': () => {
          read = true;
          return jsonResponse({ ...currentReport(), read: true });
        },
      },
      page,
    );

    await screen.findByText(reportsRu.list.scout);
    expect(within(reportsNavButton()).getByText('1')).toBeInTheDocument();

    const row = screen.getByText(reportsRu.list.scout).closest('button');
    expect(row).toHaveClass('report-row--unread');
    fireEvent.click(row as HTMLElement);

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => url === '/api/reports/rep-1')).toBe(true);
    });

    expect(await screen.findByText(reportsRu.detail.scout.title)).toBeInTheDocument();
    await waitFor(() => {
      expect(within(reportsNavButton()).queryByText('1')).not.toBeInTheDocument();
    });
  });

  it('does not re-request an already-read report on open', async () => {
    const page = (): ReportsPageView =>
      emptyPage({
        reports: [reportFixture({ id: 'rep-1', type: 'scout', read: true })],
        unreadCount: 0,
      });
    const { fetchMock } = renderReportsScreen({}, page);

    fireEvent.click(await screen.findByText(reportsRu.list.scout));
    expect(await screen.findByText(reportsRu.detail.scout.title)).toBeInTheDocument();

    expect(fetchMock.mock.calls.some(([url]) => url === '/api/reports/rep-1')).toBe(false);
  });
});

describe('ReportsScreen — report detail per type', () => {
  it('renders a scout report at base tier: sent/survivors/losses, resources/storage/troops always, and the explicit tier-unavailable message with no building list', async () => {
    const payload = scoutCombatPayload();
    const page = (): ReportsPageView =>
      emptyPage({
        reports: [
          reportFixture({
            id: 'rep-1',
            type: 'scout',
            read: false,
            payload: payload as unknown as Record<string, unknown>,
          }),
        ],
        unreadCount: 1,
      });

    const { container } = renderReportsScreen(
      { 'GET /api/reports/rep-1': () => jsonResponse({ ...reportFixture(), read: true }) },
      page,
    );

    fireEvent.click(await screen.findByText(reportsRu.list.scout));
    await screen.findByText(reportsRu.detail.scout.title);

    const detail = container.querySelector('.report-detail') as HTMLElement;
    expect(detail.textContent).toContain('Дозорный ×4'); // survivors (4)
    expect(detail.textContent).toContain('Дозорный ×1'); // losses (1)
    expect(detail.textContent).toContain('Дозорный ×5'); // sent = losses(1) + survivors(4)

    const resources = container.querySelector('.report-detail__resources');
    expect(resources?.textContent).toContain('Металлолом');
    expect(resources?.textContent).toContain((123).toLocaleString('ru-RU'));
    expect(resources?.textContent).toContain((1000).toLocaleString('ru-RU'));

    expect(within(detail).getByText(reportsRu.detail.scout.buildingsUnavailable)).toBeInTheDocument();
    expect(container.querySelector('.report-detail__buildings')).not.toBeInTheDocument();
  });

  it('renders a scout report at buildings tier with the full building list', async () => {
    const payload = scoutCombatPayload({
      intel: {
        tier: 'buildings',
        resources: { scrap: 10, fuel: 10, electronics: 10, food: 10 },
        storageCaps: { scrap: 500, fuel: 500, electronics: 500, food: 500 },
        troops: [],
        buildings: [
          { type: 'commandCenter', level: 3 },
          { type: 'warehouse', level: 2 },
        ],
      },
    });
    const page = (): ReportsPageView =>
      emptyPage({
        reports: [
          reportFixture({
            id: 'rep-1',
            type: 'scout',
            read: false,
            payload: payload as unknown as Record<string, unknown>,
          }),
        ],
        unreadCount: 1,
      });

    const { container } = renderReportsScreen(
      { 'GET /api/reports/rep-1': () => jsonResponse({ ...reportFixture(), read: true }) },
      page,
    );

    fireEvent.click(await screen.findByText(reportsRu.list.scout));
    await screen.findByText(reportsRu.detail.scout.title);

    const detail = container.querySelector('.report-detail') as HTMLElement;
    expect(within(detail).queryByText(reportsRu.detail.scout.buildingsUnavailable)).not.toBeInTheDocument();
    const buildings = container.querySelector('.report-detail__buildings');
    expect(buildings?.textContent).toContain('Штаб');
    expect(buildings?.textContent).toContain('Ур. 3');
    expect(buildings?.textContent).toContain('Склад');
    expect(buildings?.textContent).toContain('Ур. 2');
    expect(within(detail).getByText(reportsRu.detail.scout.noTroops)).toBeInTheDocument();
  });

  it('renders a scoutFailed report, distinguishing all-scouts-dead from target-not-found', async () => {
    const deadPayload = scoutCombatPayload({
      survivors: [],
      losses: [{ unitType: 'lookout', count: 3 }],
      intel: { tier: 'none' },
      reason: 'allScoutsDead',
    });
    const page = (): ReportsPageView =>
      emptyPage({
        reports: [
          reportFixture({
            id: 'rep-dead',
            type: 'scoutFailed',
            read: false,
            createdAt: 1_000,
            payload: deadPayload as unknown as Record<string, unknown>,
          }),
        ],
        unreadCount: 1,
      });

    const { container } = renderReportsScreen(
      { 'GET /api/reports/rep-dead': () => jsonResponse({ ...reportFixture(), read: true }) },
      page,
    );

    fireEvent.click(await screen.findByText(reportsRu.list.scoutFailed));
    expect(await screen.findByText(reportsRu.detail.scoutFailed.allScoutsDead)).toBeInTheDocument();
    expect(screen.queryByText(reportsRu.detail.scoutFailed.targetNotFound)).not.toBeInTheDocument();
    expect(container.querySelector('.report-detail')?.textContent).toContain('Дозорный ×3');
  });

  it('renders a scoutFailed report for the target-not-found case with no combat detail', async () => {
    const page = (): ReportsPageView =>
      emptyPage({
        reports: [
          reportFixture({
            id: 'rep-gone',
            type: 'scoutFailed',
            read: false,
            createdAt: 1_000,
            payload: targetNotFoundPayload() as unknown as Record<string, unknown>,
          }),
        ],
        unreadCount: 1,
      });

    renderReportsScreen(
      { 'GET /api/reports/rep-gone': () => jsonResponse({ ...reportFixture(), read: true }) },
      page,
    );

    fireEvent.click(await screen.findByText(reportsRu.list.scoutFailed));
    expect(await screen.findByText(reportsRu.detail.scoutFailed.targetNotFound)).toBeInTheDocument();
    expect(screen.queryByText(reportsRu.detail.scoutFailed.allScoutsDead)).not.toBeInTheDocument();
    expect(screen.getByText('Цель: 9:9')).toBeInTheDocument();
  });

  it('renders a scoutDetected report naming the attacking settlement and owner via the public map data', async () => {
    const page = (): ReportsPageView =>
      emptyPage({
        reports: [
          reportFixture({
            id: 'rep-detected',
            type: 'scoutDetected',
            read: false,
            createdAt: 1_000,
            payload: scoutDetectedPayload() as unknown as Record<string, unknown>,
          }),
        ],
        unreadCount: 1,
      });

    renderReportsScreen(
      { 'GET /api/reports/rep-detected': () => jsonResponse({ ...reportFixture(), read: true }) },
      page,
    );

    fireEvent.click(await screen.findByText(reportsRu.list.scoutDetected));
    await screen.findByText(reportsRu.detail.scoutDetected.title);

    expect(screen.getByText(/Форпост/)).toBeInTheDocument();
    expect(screen.getByText(/Странник/)).toBeInTheDocument();
  });
});

describe('ReportsScreen — live updates', () => {
  it('a reportArrived push refreshes the list and the unread badge without a reload', async () => {
    let currentPage: ReportsPageView = emptyPage();

    const { fetchMock } = renderReportsScreenWithRealtime(
      {},
      () => currentPage,
      () => currentPage,
    );

    await screen.findByText(reportsRu.empty);
    expect(within(reportsNavButton()).queryByText('1')).not.toBeInTheDocument();

    // Simulates the server side effect: a new report has actually been written, so the next
    // fetch of either endpoint reflects it — exactly what `reportArrived` is a hint to go get.
    currentPage = emptyPage({
      reports: [reportFixture({ id: 'rep-fresh', type: 'scout', read: false, createdAt: 9_000 })],
      unreadCount: 1,
    });

    const socket = vi.mocked(io).mock.results.at(-1)?.value as {
      __emitServerEvent: (event: string, payload?: unknown) => void;
    };
    socket.__emitServerEvent('reportArrived', { id: 'rep-fresh', type: 'scout', createdAt: 9_000 });

    expect(await screen.findByText(reportsRu.list.scout)).toBeInTheDocument();
    await waitFor(() => {
      expect(within(reportsNavButton()).getByText('1')).toBeInTheDocument();
    });

    // Proves this happened via a fresh fetch (the invalidation), not a page reload — the
    // component tree stays mounted throughout and the browser's `fetch` was actually called
    // again.
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/reports').length).toBeGreaterThan(1);
  });
});
