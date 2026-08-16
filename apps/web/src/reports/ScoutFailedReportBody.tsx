import type { ReactElement } from 'react';
import type { UnitType } from '@last-signal/game-core';
import { useTranslation } from 'react-i18next';

import type { ScoutFailedPayload } from './reportPayload';
import { isTargetNotFoundPayload } from './reportPayload';

interface ScoutFailedReportBodyProps {
  payload: ScoutFailedPayload;
}

/**
 * A failed scouting mission (§8): distinguishes "no survivors" (`reason: 'allScoutsDead'` —
 * the whole force died in combat, losses shown) from "target not found" (`reason:
 * 'targetNotFound'` — the M2-defensive case where the target settlement was gone by arrival,
 * nothing to show beyond where the scouts were headed) via the payload's `reason`, never by
 * guessing from which fields happen to be present.
 */
export function ScoutFailedReportBody({ payload }: ScoutFailedReportBodyProps): ReactElement {
  const { t } = useTranslation('reports');
  const { t: tUnits } = useTranslation('units');

  const targetNotFound = isTargetNotFoundPayload(payload);

  return (
    <div className="report-detail__body">
      <h3 className="screen__subtitle">{t('detail.scoutFailed.title')}</h3>
      <p className="tile-sheet__row">{t('target', payload.target)}</p>

      <p className="tile-sheet__note">
        {targetNotFound
          ? t('detail.scoutFailed.targetNotFound')
          : t('detail.scoutFailed.allScoutsDead')}
      </p>

      {!targetNotFound && payload.losses.length > 0 && (
        <ul className="report-detail__units">
          {payload.losses.map((entry) => (
            <li key={entry.unitType}>
              {t('detail.scout.lossesLabel', {
                name: tUnits(`${entry.unitType as UnitType}.name`),
                count: entry.count,
              })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
