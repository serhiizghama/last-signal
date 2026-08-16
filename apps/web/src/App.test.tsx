import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import type { HealthResponse } from './useHealth';

const HEALTH_RESPONSE: HealthResponse = {
  status: 'ok',
  serverTime: 1_000_000,
  uptimeMs: 42,
  version: '0.0.0',
  gameCoreVersion: '1.2.3',
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

function notAuthenticatedResponse(): Response {
  return jsonResponse({ error: { key: 'errors.auth.notAuthenticated', params: {} } }, 401);
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

/** Routes the shared `fetch` mock by URL — `App` fires off `/api/health` and `/api/auth/me` at once. */
function stubFetchRoutes(routes: Record<string, () => Promise<Response>>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const route = routes[url];
      if (!route) {
        return Promise.reject(new Error(`Unhandled request: ${url}`));
      }
      return route();
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('App', () => {
  it('shows a loading status badge while the health check is in flight', () => {
    stubFetchRoutes({
      '/api/health': () => new Promise<Response>(() => {}),
      '/api/auth/me': () => Promise.resolve(notAuthenticatedResponse()),
    });

    render(<App />);

    expect(screen.getByText('Подключение…')).toBeInTheDocument();
  });

  it('shows the game-core version and a live-ticking countdown once connected', async () => {
    vi.useFakeTimers();
    stubFetchRoutes({
      '/api/health': () => Promise.resolve(jsonResponse(HEALTH_RESPONSE)),
      '/api/auth/me': () => Promise.resolve(notAuthenticatedResponse()),
    });

    render(<App />);

    await act(flushMicrotasks);

    expect(screen.getByText('Онлайн')).toBeInTheDocument();
    expect(screen.getByText(/1\.2\.3/)).toBeInTheDocument();
    expect(screen.getByText('01:00')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(screen.getByText('00:59')).toBeInTheDocument();
    expect(screen.queryByText('01:00')).not.toBeInTheDocument();
  });

  it('shows a translated connection error when the health check fails', async () => {
    stubFetchRoutes({
      '/api/health': () => Promise.resolve(jsonResponse({}, 503)),
      '/api/auth/me': () => Promise.resolve(notAuthenticatedResponse()),
    });

    render(<App />);

    expect(await screen.findByText(/Ошибка соединения/)).toBeInTheDocument();
  });

  it('renders the onboarding welcome screen below the header when there is no session', async () => {
    stubFetchRoutes({
      '/api/health': () => Promise.resolve(jsonResponse(HEALTH_RESPONSE)),
      '/api/auth/me': () => Promise.resolve(notAuthenticatedResponse()),
    });

    render(<App />);

    expect(await screen.findByText('Добро пожаловать в убежище')).toBeInTheDocument();
  });
});
