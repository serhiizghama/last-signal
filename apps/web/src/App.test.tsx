import { RESOURCE_KINDS } from '@last-signal/game-core';
import { act, render, screen, within } from '@testing-library/react';
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

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('App', () => {
  it('shows a loading indicator while the health check is in flight', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );

    render(<App />);

    expect(screen.getByText(/Устанавливаем связь/)).toBeInTheDocument();
  });

  it('shows the game-core version and a live-ticking countdown once connected', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse(HEALTH_RESPONSE))),
    );

    render(<App />);

    await act(flushMicrotasks);

    expect(screen.getByText(HEALTH_RESPONSE.gameCoreVersion)).toBeInTheDocument();
    expect(screen.getByText('01:00')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(screen.getByText('00:59')).toBeInTheDocument();
    expect(screen.queryByText('01:00')).not.toBeInTheDocument();
  });

  it('shows an error message when the health check fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({}, 503))),
    );

    render(<App />);

    expect(await screen.findByText(/Ошибка соединения/)).toBeInTheDocument();
  });

  it('shows an error message on a network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('network down'))),
    );

    render(<App />);

    expect(await screen.findByText(/network down/)).toBeInTheDocument();
  });

  it('renders one labeled entry per resource kind from RESOURCE_KINDS', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );

    render(<App />);

    expect(RESOURCE_KINDS).toHaveLength(4);

    const resourceBar = screen.getByRole('list', { name: 'Ресурсы' });
    const items = within(resourceBar).getAllByRole('listitem');

    expect(items).toHaveLength(RESOURCE_KINDS.length);
    for (const item of items) {
      expect((item.textContent ?? '').trim().length).toBeGreaterThan(0);
    }
  });
});
