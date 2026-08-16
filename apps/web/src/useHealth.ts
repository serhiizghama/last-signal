import { useEffect, useState } from 'react';

import { ApiError } from './api/client';

/**
 * Mirrors the server's `HealthStatus` shape (see apps/server/src/health/health.service.ts).
 * Defined locally rather than imported: the web app must not depend on server code.
 */
export interface HealthResponse {
  status: 'ok';
  serverTime: number;
  uptimeMs: number;
  version: string;
  gameCoreVersion: string;
}

export type HealthState =
  | { state: 'loading' }
  | { state: 'ok'; data: HealthResponse }
  | { state: 'error'; error: ApiError };

/** Fetches `/api/health` on mount and reports connection status. */
export function useHealth(): HealthState {
  const [health, setHealth] = useState<HealthState>({ state: 'loading' });

  useEffect(() => {
    const controller = new AbortController();

    async function fetchHealth(): Promise<void> {
      try {
        const response = await fetch('/api/health', { signal: controller.signal });

        if (!response.ok) {
          setHealth({
            state: 'error',
            error: new ApiError(
              'errors.network.httpStatus',
              { status: response.status },
              response.status,
            ),
          });
          return;
        }

        const data = (await response.json()) as HealthResponse;
        setHealth({ state: 'ok', data });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        // Never render the raw exception message: it's whatever the browser produced, in
        // whatever language the browser chose, and isn't a key the RU bundle understands —
        // same `{ key, params }` shape the API client uses, so the UI translates it the same way.
        setHealth({ state: 'error', error: new ApiError('errors.network.unknown', {}, 0) });
      }
    }

    void fetchHealth();

    return () => {
      controller.abort();
    };
  }, []);

  return health;
}
