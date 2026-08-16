import type { ReactElement } from 'react';
import type { UnitType } from '@last-signal/game-core';
import { RESOURCE_KINDS, floorForDisplay } from '@last-signal/game-core';
import { useTranslation } from 'react-i18next';

import type { MovementUnitEntry } from '../api/types';
import type { ScoutCombatPayload } from './reportPayload';
import { mergeUnitEntries } from './reportPayload';

interface ScoutReportBodyProps {
  payload: ScoutCombatPayload;
}

const RU_LOCALE = 'ru-RU';

function UnitEntryList({
  entries,
  labelKey,
}: {
  entries: readonly MovementUnitEntry[];
  labelKey: 'detail.scout.sentLabel' | 'detail.scout.survivorsLabel' | 'detail.scout.lossesLabel';
}): ReactElement {
  const { t } = useTranslation('reports');
  const { t: tUnits } = useTranslation('units');
  return (
    <ul className="report-detail__units">
      {entries.map((entry) => (
        <li key={entry.unitType}>
          {t(labelKey, { name: tUnits(`${entry.unitType as UnitType}.name`), count: entry.count })}
        </li>
      ))}
    </ul>
  );
}

/** Plain `{{name}} ×{{count}}` entries, no verb prefix — for lists whose own heading (e.g. "Войска в поселении:") already gives the context a `sentLabel`/`survivorsLabel`/`lossesLabel` prefix would otherwise redundantly repeat. */
function PlainUnitEntryList({ entries }: { entries: readonly MovementUnitEntry[] }): ReactElement {
  const { t } = useTranslation('reports');
  const { t: tUnits } = useTranslation('units');
  return (
    <ul className="report-detail__units">
      {entries.map((entry) => (
        <li key={entry.unitType}>
          {t('detail.scout.troopsEntry', {
            name: tUnits(`${entry.unitType as UnitType}.name`),
            count: entry.count,
          })}
        </li>
      ))}
    </ul>
  );
}

/**
 * A successful scouting report (§8): what was sent, what came back (survivors/losses by unit
 * type), and the intel — resources/storage caps/troops always, the full building list only
 * when the tier includes it (`intel.tier === 'buildings'`). `intel.tier === 'none'` never
 * reaches this component (that's exactly what makes the server write `scoutFailed` instead —
 * see `reportPayload.ts`'s own comment), so the intel section always renders here.
 */
export function ScoutReportBody({ payload }: ScoutReportBodyProps): ReactElement {
  const { t } = useTranslation('reports');
  const { t: tCommon } = useTranslation();
  const { t: tResources } = useTranslation('resources');
  const { t: tBuildings } = useTranslation('buildings');

  const { intel } = payload;
  const sent = mergeUnitEntries(payload.losses, payload.survivors);

  return (
    <div className="report-detail__body">
      <h3 className="screen__subtitle">{t('detail.scout.title')}</h3>
      <p className="tile-sheet__row">{t('target', payload.target)}</p>

      <UnitEntryList entries={sent} labelKey="detail.scout.sentLabel" />
      <UnitEntryList entries={payload.survivors} labelKey="detail.scout.survivorsLabel" />
      {payload.losses.length > 0 ? (
        <UnitEntryList entries={payload.losses} labelKey="detail.scout.lossesLabel" />
      ) : (
        <p className="tile-sheet__note">{t('detail.scout.noLosses')}</p>
      )}

      {intel.tier !== 'none' && (
        <div className="report-detail__intel">
          <h4 className="screen__subtitle">{t('detail.scout.intelTitle')}</h4>

          <p className="tile-sheet__row">{t('detail.scout.resourcesLabel')}</p>
          <ul className="report-detail__resources">
            {RESOURCE_KINDS.map((kind) => (
              <li key={kind}>
                {tResources(kind)}: {floorForDisplay(intel.resources[kind]).toLocaleString(RU_LOCALE)} /{' '}
                {intel.storageCaps[kind].toLocaleString(RU_LOCALE)}
              </li>
            ))}
          </ul>

          <p className="tile-sheet__row">{t('detail.scout.troopsLabel')}</p>
          {intel.troops.length > 0 ? (
            <PlainUnitEntryList entries={intel.troops} />
          ) : (
            <p className="tile-sheet__note">{t('detail.scout.noTroops')}</p>
          )}

          {intel.tier === 'buildings' ? (
            <>
              <p className="tile-sheet__row">{t('detail.scout.buildingsTitle')}</p>
              <ul className="report-detail__buildings">
                {intel.buildings.map((building) => (
                  <li key={building.type}>
                    {tBuildings(`${building.type}.name`)} ·{' '}
                    {tCommon('base.level', { level: building.level })}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="tile-sheet__note">{t('detail.scout.buildingsUnavailable')}</p>
          )}
        </div>
      )}
    </div>
  );
}
