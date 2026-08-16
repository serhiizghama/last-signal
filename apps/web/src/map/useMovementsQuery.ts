import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { fetchMyMovements } from '../api/endpoints';
import type { MovementView } from '../api/types';

export const MOVEMENTS_QUERY_KEY = ['movements', 'mine'] as const;

/**
 * Own in-flight movements (§5/§6): "nobody can query anyone else's movements in M2" — this
 * endpoint never returns anyone else's, so nothing here needs an ownership filter client-side.
 * A modest `staleTime` keeps the overlay reasonably fresh across tab switches without polling
 * on its own: the live countdowns (`useCountdown` in `MovementsOverlay`) tick every second
 * independent of refetching, and `MovementsOverlay` explicitly invalidates this key once a
 * countdown reaches zero (arrival/return) or a send/cancel mutation succeeds.
 */
const MOVEMENTS_STALE_TIME_MS = 30_000;

export function useMovementsQuery(): UseQueryResult<MovementView[]> {
  return useQuery({
    queryKey: MOVEMENTS_QUERY_KEY,
    queryFn: ({ signal }) => fetchMyMovements(signal),
    staleTime: MOVEMENTS_STALE_TIME_MS,
  });
}
