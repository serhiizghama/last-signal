import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HealthResponse } from './useHealth';
import { useHealth } from './useHealth';

const HEALTH_RESPONSE: HealthResponse = {
  status: 'ok',
  serverTime: 1_000_000,
  uptimeMs: 42,
  version: '0.0.0',
  gameCoreVersion: '0.0.0',
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useHealth', () => {
  it('starts in the loading state', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );

    const { result } = renderHook(() => useHealth());

    expect(result.current).toEqual({ state: 'loading' });
  });

  it('reports the ok state with the fetched data on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse(HEALTH_RESPONSE))),
    );

    const { result } = renderHook(() => useHealth());

    await waitFor(() => {
      expect(result.current).toEqual({ state: 'ok', data: HEALTH_RESPONSE });
    });
  });

  it('reports the error state on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({}, 500))),
    );

    const { result } = renderHook(() => useHealth());

    await waitFor(() => {
      expect(result.current.state).toBe('error');
    });
    expect(result.current).toMatchObject({ message: expect.stringContaining('500') });
  });

  it('reports the error state on a network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('Failed to fetch'))),
    );

    const { result } = renderHook(() => useHealth());

    await waitFor(() => {
      expect(result.current).toEqual({ state: 'error', message: 'Failed to fetch' });
    });
  });
});
