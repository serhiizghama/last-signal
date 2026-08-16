import type { InfiniteData, UseInfiniteQueryResult, UseQueryResult } from '@tanstack/react-query';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { fetchReports } from '../api/endpoints';
import type { ReportsPageView } from '../api/types';

/** The inbox list — every `GET /api/reports` page, newest-first (§8/M2b.4). */
export const REPORTS_QUERY_KEY = ['reports', 'mine'] as const;

/**
 * A separate, minimal (`limit=1`) query just for the nav badge (`BottomNav`): `unreadCount`
 * comes back identical regardless of `limit` (it's a `countDocuments` over the whole inbox,
 * not page-scoped — see `ReportsService.listMine`), so the badge never needs the full list
 * loaded just to show a number. Kept as its own query key rather than reusing
 * `REPORTS_QUERY_KEY`: that one backs an infinite query, and TanStack Query doesn't support a
 * plain `useQuery` and a `useInfiniteQuery` sharing one key — they cache differently-shaped
 * data (`ReportsPageView` vs `InfiniteData<ReportsPageView>`).
 */
export const REPORTS_UNREAD_QUERY_KEY = ['reports', 'unread'] as const;

// The report list only ever changes via a WS `reportArrived` push (which explicitly
// invalidates both keys above) or this client's own read-on-open mutation — never on its own,
// unlike a resource tick — so a moderate `staleTime` avoids re-polling on every tab switch,
// mirroring `useMovementsQuery`'s own reasoning.
const REPORTS_STALE_TIME_MS = 30_000;

/**
 * The Reports tab's own list (§11): cursor-paginated, newest first — `getNextPageParam` reads
 * straight off the server's own `nextCursor` (opaque to this client, per
 * `reports-cursor.util.ts`'s comment), so "load more" is just `fetchNextPage()`.
 */
export function useReportsQuery(): UseInfiniteQueryResult<InfiniteData<ReportsPageView>> {
  return useInfiniteQuery({
    queryKey: REPORTS_QUERY_KEY,
    queryFn: ({ pageParam, signal }) => fetchReports({ cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: REPORTS_STALE_TIME_MS,
  });
}

/** Drives the unread badge on the nav's `Отчёты` tab (`BottomNav`) — see this module's own comment on why it's a separate query. */
export function useUnreadReportsCount(): UseQueryResult<number> {
  return useQuery({
    queryKey: REPORTS_UNREAD_QUERY_KEY,
    queryFn: async ({ signal }) => (await fetchReports({ limit: 1 }, signal)).unreadCount,
    staleTime: REPORTS_STALE_TIME_MS,
  });
}
