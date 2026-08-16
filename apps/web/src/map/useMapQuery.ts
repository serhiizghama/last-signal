import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { fetchMap } from '../api/endpoints';
import type { MapView } from '../api/types';

export const MAP_QUERY_KEY = ['map'] as const;

/**
 * A settlement appearing on the map is rare (a handful of registrations/foundings per hour in
 * a ~150-account world, per §5) and nothing else in the payload changes without one — terrain
 * is derived client-side and static, oases are inert, ownership fields only change alongside a
 * settlement's own document. 60s keeps the map reasonably fresh across tab switches and
 * re-renders without hammering the endpoint on every pan/zoom, until the WS invalidation event
 * (§5: "invalidated by a WS event when a settlement appears") lands in a later step.
 */
const MAP_STALE_TIME_MS = 60_000;

export function useMapQuery(): UseQueryResult<MapView> {
  return useQuery({
    queryKey: MAP_QUERY_KEY,
    queryFn: ({ signal }) => fetchMap(signal),
    staleTime: MAP_STALE_TIME_MS,
  });
}
