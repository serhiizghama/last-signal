import type { ReactElement } from 'react';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { fetchReport } from '../api/endpoints';
import type { NavTab } from '../base/BottomNav';
import { BottomNav } from '../base/BottomNav';
import { ErrorPanel, LoadingPanel } from '../components/StatusPanels';
import { ReportDetail } from './ReportDetail';
import { ReportsList } from './ReportsList';
import { REPORTS_QUERY_KEY, REPORTS_UNREAD_QUERY_KEY, useReportsQuery } from './useReportsQuery';

interface ReportsScreenProps {
  onNavigateTab: (tab: NavTab) => void;
}

/**
 * The Reports tab (M2c.3, `docs/M2_DESIGN_DECISIONS.md` §8/§11): the scout report inbox —
 * newest-first list with unread state and cursor pagination (`ReportsList`), and a detail view
 * per report (`ReportDetail`) that opens on tap. Which report (if any) is open is local state,
 * the same "screen switching without a router" convention `Onboarding`'s `SettlementGate`
 * already uses for the bottom-nav tab itself.
 */
export function ReportsScreen({ onNavigateTab }: ReportsScreenProps): ReactElement {
  const { t } = useTranslation('reports');
  const query = useReportsQuery();
  const queryClient = useQueryClient();
  const [openReportId, setOpenReportId] = useState<string | null>(null);

  // Read-on-open (§8): `GET /api/reports/:id` is what marks a report read server-side — fired
  // here, on the click that opens it, rather than inside `ReportDetail` itself (which stays
  // purely presentational — see that component's own comment). Only actually called for a
  // report this client still thinks is unread, so re-opening an already-read one costs
  // nothing.
  const markReadMutation = useMutation({
    mutationFn: (id: string) => fetchReport(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: REPORTS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: REPORTS_UNREAD_QUERY_KEY });
    },
  });

  const reports = query.data?.pages.flatMap((page) => page.reports) ?? [];
  const openReport = reports.find((report) => report.id === openReportId);

  function handleOpenReport(id: string): void {
    setOpenReportId(id);
    const report = reports.find((r) => r.id === id);
    if (report && !report.read) {
      markReadMutation.mutate(id);
    }
  }

  return (
    <div className="reports-screen">
      <header className="panel screen">
        <h2 className="screen__title">{t('title')}</h2>
      </header>

      {query.isPending && <LoadingPanel />}
      {query.isError && <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />}

      {query.data && !openReport && (
        <ReportsList
          reports={reports}
          hasNextPage={query.hasNextPage}
          isFetchingNextPage={query.isFetchingNextPage}
          onLoadMore={() => void query.fetchNextPage()}
          onOpenReport={handleOpenReport}
        />
      )}

      {openReport && <ReportDetail report={openReport} onClose={() => setOpenReportId(null)} />}

      <BottomNav active="reports" onNavigate={onNavigateTab} />
    </div>
  );
}
