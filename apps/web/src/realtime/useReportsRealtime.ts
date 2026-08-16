import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { REPORTS_QUERY_KEY, REPORTS_UNREAD_QUERY_KEY } from '../reports/useReportsQuery';
import { getSocket } from './socketClient';

/**
 * The one live-update seam for reports (§8/§11, M2b.4's `reportArrived`): subscribes the
 * shared socket (`getSocket` — one connection for the whole app, see that module's own
 * comment) to `reportArrived` and invalidates the reports list/unread-badge queries so a fresh
 * scout report shows up without a reload — the milestone's headline acceptance criterion.
 * Mounted once, in `Onboarding`'s `SettlementGate` (persists across bottom-nav tab switches,
 * since that component itself never remounts when `activeTab` changes), not inside any
 * individual screen — so the subscription doesn't churn on every tab click.
 *
 * Never throws and never blocks the rest of the app on the socket actually connecting: the
 * server being unreachable just means `reportArrived` never fires, and reports still work via
 * the ordinary manual-refresh/tab-revisit refetch `useInfiniteQuery`/`useQuery` already fall
 * back to — a dead socket is not a broken app (§ M2c.3 brief). `connect_error` is listened for
 * only so a failed handshake is visibly, intentionally handled (a no-op) rather than left to
 * whatever socket.io's own default behaviour for an unhandled event would otherwise be.
 */
export function useReportsRealtime(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const socket = getSocket();

    function handleReportArrived(): void {
      void queryClient.invalidateQueries({ queryKey: REPORTS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: REPORTS_UNREAD_QUERY_KEY });
    }

    // Intentionally silent — see this function's own comment above.
    function handleConnectError(): void {}

    socket.on('reportArrived', handleReportArrived);
    socket.on('connect_error', handleConnectError);

    return () => {
      socket.off('reportArrived', handleReportArrived);
      socket.off('connect_error', handleConnectError);
    };
  }, [queryClient]);
}
