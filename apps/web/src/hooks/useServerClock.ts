import { msUntil } from '@last-signal/game-core';
import { useEffect, useState } from 'react';

const DEFAULT_TICK_INTERVAL_MS = 1000;

/**
 * Anchors on `performance.now()` and derives "server now" as `serverTime + elapsed
 * monotonic client time` — the same technique the server uses for its own `uptimeMs`. Every
 * countdown in the app is built on this, never on the browser's wall clock (`Date.now()`),
 * which can drift or jump (system clock changes, laptop sleep, timezone edits).
 *
 * Re-anchors whenever `serverTime` changes (e.g. a fresh `/api/health` or API response).
 * Returns `undefined` until a `serverTime` is available.
 */
export function useServerClock(
  serverTime: number | undefined,
  tickIntervalMs: number = DEFAULT_TICK_INTERVAL_MS,
): number | undefined {
  const [serverNow, setServerNow] = useState<number | undefined>(serverTime);

  useEffect(() => {
    if (serverTime === undefined) {
      setServerNow(undefined);
      return;
    }

    const anchoredAtClientMs = performance.now();
    const tick = (): void => {
      setServerNow(serverTime + (performance.now() - anchoredAtClientMs));
    };

    tick();
    const intervalId = setInterval(tick, tickIntervalMs);

    return () => {
      clearInterval(intervalId);
    };
  }, [serverTime, tickIntervalMs]);

  return serverNow;
}

/** Milliseconds remaining until `dueAt`, ticking every second on the server clock derived from `serverTime`. */
export function useCountdown(
  serverTime: number | undefined,
  dueAt: number | undefined,
): number | undefined {
  const serverNow = useServerClock(serverTime);
  if (serverNow === undefined || dueAt === undefined) {
    return undefined;
  }
  return msUntil(serverNow, dueAt);
}

/** Convenience over `useCountdown` for the common "windowMs from serverTime" case. */
export function useCountdownWindow(
  serverTime: number | undefined,
  windowMs: number,
): number | undefined {
  const dueAt = serverTime === undefined ? undefined : serverTime + windowMs;
  return useCountdown(serverTime, dueAt);
}
