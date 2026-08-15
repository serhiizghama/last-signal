import { useEffect, useState } from 'react';

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
  | { state: 'error'; message: string };

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
            message: `Сервер ответил статусом ${String(response.status)}`,
          });
          return;
        }

        const data = (await response.json()) as HealthResponse;
        setHealth({ state: 'ok', data });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        setHealth({
          state: 'error',
          message: error instanceof Error ? error.message : 'Неизвестная ошибка сети',
        });
      }
    }

    void fetchHealth();

    return () => {
      controller.abort();
    };
  }, []);

  return health;
}
