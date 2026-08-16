import type { QueryClient } from '@tanstack/react-query';

import type { SettlementStateView } from '../api/types';

/** The query key `Onboarding`'s `SettlementGate` reads its settlement list from. */
export const SETTLEMENTS_MINE_KEY = ['settlements', 'mine'] as const;

/**
 * Replaces the matching settlement inside the cached `mine` list with a fresh server
 * response — every build/cancel command returns the full updated state, so the UI can apply
 * it straight to the cache instead of waiting on a refetch round trip.
 */
export function updateSettlementCache(
  queryClient: QueryClient,
  updated: SettlementStateView,
): void {
  queryClient.setQueryData<SettlementStateView[]>(SETTLEMENTS_MINE_KEY, (old) =>
    old ? old.map((s) => (s.id === updated.id ? updated : s)) : [updated],
  );
}
