import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AccountView, SettlementStateView } from '../api/types';
import { Onboarding } from './Onboarding';

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

function guestAccount(): AccountView {
  return { id: 'acc-1', name: 'guest-1', isGuest: true, contribution: 0, medals: [], createdAt: 0 };
}

function settlementFor(account: AccountView): SettlementStateView {
  return {
    id: 'set-1',
    name: account.name,
    x: 12,
    y: 34,
    buildings: [{ id: 'b-1', type: 'commandCenter', level: 1, slot: 0 }],
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
  };
}

function renderOnboarding(): ReturnType<typeof render> {
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Onboarding', () => {
  it('shows the welcome screen when there is no session (401)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(errorResponse('errors.auth.notAuthenticated', {}, 401))),
    );

    renderOnboarding();

    expect(await screen.findByText('Добро пожаловать в убежище')).toBeInTheDocument();
  });

  it('walks guest login -> registration -> create settlement -> base placeholder', async () => {
    let account: AccountView | null = null;
    let settlements: SettlementStateView[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';

        if (url === '/api/auth/me') {
          return Promise.resolve(
            account
              ? jsonResponse(account)
              : errorResponse('errors.auth.notAuthenticated', {}, 401),
          );
        }
        if (url === '/api/auth/guest' && method === 'POST') {
          account = guestAccount();
          return Promise.resolve(jsonResponse(account));
        }
        if (url === '/api/accounts/register' && method === 'POST') {
          const body = parseBody(init);
          account = {
            ...(account ?? guestAccount()),
            name: body.name as string,
            faction: body.faction as AccountView['faction'],
            isGuest: false,
          };
          return Promise.resolve(jsonResponse(account));
        }
        if (url === '/api/settlements/mine') {
          return Promise.resolve(jsonResponse(settlements));
        }
        if (url === '/api/settlements' && method === 'POST') {
          const settlement = settlementFor(account ?? guestAccount());
          settlements = [settlement];
          return Promise.resolve(jsonResponse(settlement));
        }
        // `BottomNav`'s Reports unread badge (M2c.3), reached once the flow lands on the base
        // screen — irrelevant to this walkthrough, kept stable/empty.
        if (url.startsWith('/api/reports')) {
          return Promise.resolve(
            jsonResponse({ reports: [], nextCursor: null, unreadCount: 0, serverTime: 0 }),
          );
        }
        return Promise.reject(new Error(`Unhandled request: ${method} ${url}`));
      }),
    );

    renderOnboarding();

    // 401 -> welcome screen
    const guestButton = await screen.findByText('Играть как гость');

    // guest login -> registration screen
    fireEvent.click(guestButton);
    await screen.findByText('Кто вы в этом мире?');

    fireEvent.change(screen.getByPlaceholderText('Введите позывной'), {
      target: { value: 'Скиталец' },
    });
    fireEvent.click(screen.getByRole('radio', { name: /Рейдеры/ }));
    fireEvent.click(screen.getByText('Подтвердить'));

    // register -> create-settlement screen
    await screen.findByText('Пора заложить поселение');
    fireEvent.click(screen.getByText('Основать поселение'));

    // settlement exists -> base screen, showing name, coordinates, faction and buildings
    expect(await screen.findByText('Скиталец')).toBeInTheDocument();
    expect(screen.getByText('Координаты: 12:34 · Рейдеры')).toBeInTheDocument();
    expect(screen.getAllByText('Штаб').length).toBeGreaterThan(0);
    expect(screen.getByText('Ур. 1')).toBeInTheDocument();
  });

  it('renders a translated Russian message for a server error (nameTaken)', async () => {
    const account = { ...guestAccount(), faction: undefined };

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (url === '/api/auth/me') {
          return Promise.resolve(jsonResponse(account));
        }
        if (url === '/api/accounts/register' && method === 'POST') {
          const body = parseBody(init);
          return Promise.resolve(
            errorResponse('errors.account.nameTaken', { name: body.name }, 409),
          );
        }
        return Promise.reject(new Error(`Unhandled request: ${method} ${url}`));
      }),
    );

    renderOnboarding();

    await screen.findByText('Кто вы в этом мире?');
    fireEvent.change(screen.getByPlaceholderText('Введите позывной'), {
      target: { value: 'Скиталец' },
    });
    fireEvent.click(screen.getByRole('radio', { name: /Инженеры/ }));
    fireEvent.click(screen.getByText('Подтвердить'));

    expect(await screen.findByText('Позывной «Скиталец» уже занят.')).toBeInTheDocument();
  });
});
