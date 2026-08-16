import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

import { useMapQuery } from '../map/useMapQuery';
import { formatReportTime } from './formatReportTime';
import type { ScoutDetectedPayload } from './reportPayload';

interface ScoutDetectedReportBodyProps {
  payload: ScoutDetectedPayload;
}

/**
 * "Who scouted you and when" (§8) — nothing more, no intel about what they learned. The
 * payload only carries `attackerSettlementId`/`attackerAccountId` (structured ids, M1 §15);
 * resolving them into a name here specifically is deliberate, not a privacy leak: §8 calls the
 * attacking settlement and its owner "public info anyway" — exactly the `name`/`ownerName`
 * fields `GET /api/map` already exposes for every settlement in the world, unfiltered
 * (`MapService.getMapView`). Reusing the Map tab's own query rather than inventing a second
 * lookup endpoint for the same public data; falls back to a generic placeholder if that
 * settlement isn't (yet) in the cached map view rather than showing a raw id.
 */
export function ScoutDetectedReportBody({ payload }: ScoutDetectedReportBodyProps): ReactElement {
  const { t } = useTranslation('reports');
  const mapQuery = useMapQuery();

  const attacker = mapQuery.data?.settlements.find((s) => s.id === payload.attackerSettlementId);
  const unknown = t('detail.scoutDetected.unknownSettlement');

  return (
    <div className="report-detail__body">
      <h3 className="screen__subtitle">{t('detail.scoutDetected.title')}</h3>
      <p className="tile-sheet__row">
        {t('detail.scoutDetected.body', {
          settlement: attacker?.name ?? unknown,
          owner: attacker?.ownerName ?? unknown,
          time: formatReportTime(payload.at),
        })}
      </p>
    </div>
  );
}
