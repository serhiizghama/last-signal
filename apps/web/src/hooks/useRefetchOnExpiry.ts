import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

// The server's own scheduler (`EventSchedulerService`) polls for due events roughly once a
// second, so a completion can land up to ~1s after its countdown's target — refetching at the
// exact instant the client's countdown hits zero can race it and come back not-yet-resolved.
// A short, bounded retry (not an unbounded poll — the resource bar is deliberately
// client-computed via `settleResources` precisely so the app never needs to poll) rides out
// that race: wait a grace period past zero, refetch, and if `isUnresolved` still says so, try
// a couple more times before giving up.
const REFETCH_GRACE_MS = 1500;
const REFETCH_RETRY_DELAY_MS = 1500;
const MAX_REFETCH_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Refetches whatever's cached under `queryKey` once a countdown has expired, retrying
 * (bounded) until `isUnresolved` reports false against the freshly-cached array — i.e. until
 * the server has actually applied whatever `expired` was waiting on (a build completing, a
 * trained unit being credited, a movement's arrival/return), not just until the client's clock
 * says it should have.
 *
 * Generic over the cached array's element type and its query key so every countdown-driven
 * refetch in the app shares this one implementation instead of each reinventing the same
 * grace-period-plus-bounded-retry dance. History: originally lived only in `base/` for
 * `BuildQueueList` (one build item, identified by its own `id`); `TrainingSection` needed the
 * exact same fix for a defect where its countdown had no refetch at all; moved here (out of
 * `base/`) when `map/`'s `MovementsOverlay` turned out to need it too, rather than forking a
 * second copy of the retry logic under a movements-specific name.
 *
 * `watchKey` re-arms the "already triggered" guard whenever it changes. For something whose
 * identity is stable across multiple expiries — a training order spanning several units under
 * the same id (§7), or a movement that expires once on arrival and again on return (§6) —
 * `watchKey` must include whatever changes between those expiries (`nextCompletesAt` for
 * training, the movement's own `status` for a scout run). The id alone would only ever arm
 * once and never notice the next expiry.
 */
export function useRefetchOnExpiry<T>(
  queryClient: QueryClient,
  expired: boolean,
  watchKey: string,
  queryKey: QueryKey,
  isUnresolved: (item: T) => boolean,
): void {
  const triggeredRef = useRef(false);
  // Read through a ref rather than depending on `isUnresolved` directly: callers pass a fresh
  // closure every render, and depending on it would re-run the reset effect (and could
  // re-trigger the retry loop) on every render instead of only when `watchKey` actually
  // changes. The ref always calls the latest version once the retry loop actually runs.
  const isUnresolvedRef = useRef(isUnresolved);
  isUnresolvedRef.current = isUnresolved;

  useEffect(() => {
    triggeredRef.current = false;
  }, [watchKey]);

  useEffect(() => {
    if (!expired || triggeredRef.current) {
      return undefined;
    }
    triggeredRef.current = true;
    let cancelled = false;

    async function refetchUntilResolved(): Promise<void> {
      for (let attempt = 1; attempt <= MAX_REFETCH_ATTEMPTS; attempt += 1) {
        await sleep(attempt === 1 ? REFETCH_GRACE_MS : REFETCH_RETRY_DELAY_MS);
        if (cancelled) {
          return;
        }
        await queryClient.invalidateQueries({ queryKey });
        if (cancelled) {
          return;
        }
        const data = queryClient.getQueryData<T[]>(queryKey);
        const unresolved = data?.some((item) => isUnresolvedRef.current(item));
        if (!unresolved) {
          return;
        }
      }
    }

    void refetchUntilResolved();
    return () => {
      cancelled = true;
    };
    // `queryKey` is always a stable module-level constant at every call site (`SETTLEMENTS_MINE_KEY`,
    // `MOVEMENTS_QUERY_KEY`) — safe to depend on by reference without memoizing it per render.
  }, [expired, queryClient, watchKey, queryKey]);
}
