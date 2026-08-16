import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

import type { ReportView } from '../api/types';
import { formatReportTime } from './formatReportTime';
import { reportTargetFromPayload } from './reportPayload';

interface ReportsListProps {
  reports: readonly ReportView[];
  hasNextPage: boolean | undefined;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  onOpenReport: (id: string) => void;
}

const REPORT_TYPE_LABEL_KEY: Record<ReportView['type'], 'list.scout' | 'list.scoutFailed' | 'list.scoutDetected'> = {
  scout: 'list.scout',
  scoutFailed: 'list.scoutFailed',
  scoutDetected: 'list.scoutDetected',
};

/**
 * The inbox list (§8/§11): newest-first (the server's own sort order — never re-sorted
 * client-side), unread reports visually distinct via both a CSS modifier and an explicit
 * badge (never colour alone), and a "load more" affordance that only appears while the server
 * says there's a next cursor.
 */
export function ReportsList({
  reports,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  onOpenReport,
}: ReportsListProps): ReactElement {
  const { t } = useTranslation('reports');
  const { t: tCommon } = useTranslation();

  if (reports.length === 0) {
    return <p className="screen__description">{t('empty')}</p>;
  }

  return (
    <section className="panel reports-list-section">
      <ul className="reports-list">
        {reports.map((report) => {
          const target = reportTargetFromPayload(report.payload);
          return (
            <li key={report.id}>
              <button
                type="button"
                className={`report-row${report.read ? '' : ' report-row--unread'}`}
                onClick={() => onOpenReport(report.id)}
              >
                <span className="report-row__main">
                  <span className="report-row__type">{t(REPORT_TYPE_LABEL_KEY[report.type])}</span>
                  {target && <span className="report-row__target">{t('target', target)}</span>}
                  <span className="report-row__time">{formatReportTime(report.createdAt)}</span>
                </span>
                {!report.read && <span className="report-row__badge">{t('unreadLabel')}</span>}
              </button>
            </li>
          );
        })}
      </ul>

      {hasNextPage && (
        <button
          type="button"
          className="button"
          disabled={isFetchingNextPage}
          onClick={onLoadMore}
        >
          {isFetchingNextPage ? tCommon('actions.loading') : t('loadMore')}
        </button>
      )}
    </section>
  );
}
