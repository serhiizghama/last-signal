import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

import type { ReportView } from '../api/types';
import type { ScoutCombatPayload, ScoutDetectedPayload, ScoutFailedPayload } from './reportPayload';
import { ScoutDetectedReportBody } from './ScoutDetectedReportBody';
import { ScoutFailedReportBody } from './ScoutFailedReportBody';
import { ScoutReportBody } from './ScoutReportBody';

interface ReportDetailProps {
  report: ReportView;
  onClose: () => void;
}

/**
 * One report, rendered per `type` (§8/M1 §15: the server ships keys/ids in `payload`, this is
 * where the client turns them into Russian prose). Purely presentational — the report itself
 * always comes from the already-loaded list (every list row is already a full `ReportView`,
 * `payload` included, same shape `GET /api/reports/:id` returns — see
 * `ReportsService.listMine`/`toReportView`), and read-on-open is a side effect
 * `ReportsScreen` fires once, on the click that opens this view, not something this component
 * re-triggers on every render/remount.
 */
export function ReportDetail({ report, onClose }: ReportDetailProps): ReactElement {
  const { t } = useTranslation('reports');

  return (
    <section className="panel report-detail">
      <button type="button" className="button report-detail__back" onClick={onClose}>
        {t('backToList')}
      </button>

      {report.type === 'scout' && (
        <ScoutReportBody payload={report.payload as unknown as ScoutCombatPayload} />
      )}
      {report.type === 'scoutFailed' && (
        <ScoutFailedReportBody payload={report.payload as unknown as ScoutFailedPayload} />
      )}
      {report.type === 'scoutDetected' && (
        <ScoutDetectedReportBody payload={report.payload as unknown as ScoutDetectedPayload} />
      )}
    </section>
  );
}
