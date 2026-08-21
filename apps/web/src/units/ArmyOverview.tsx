import type { ReactElement } from 'react';
import type { UnitType } from '@last-signal/game-core';
import { DEFAULT_CONFIG, calcTroopFoodUpkeepPerHour } from '@last-signal/game-core';
import { useTranslation } from 'react-i18next';

import type {
  SettlementStateView,
  SettlementStationedContingentView,
  SettlementTroopView,
} from '../api/types';
import { toTroopCounts } from '../base/settlementSelectors';

interface TroopGroupListProps {
  troops: readonly SettlementTroopView[];
}

/** A group's unit breakdown — same `.troop-list` markup `HomeTroopsList` (`TrainingSection`) already renders, so home/away/stationed read as one visual family with the rest of the app. */
function TroopGroupList({ troops }: TroopGroupListProps): ReactElement {
  const { t } = useTranslation('military');
  const { t: tUnits } = useTranslation('units');

  if (troops.length === 0) {
    return <p className="screen__description">{t('overview.empty')}</p>;
  }

  return (
    <ul className="troop-list">
      {troops.map((troop) => (
        <li key={troop.unitType} className="troop-list__item">
          <span className="troop-list__name">{tUnits(`${troop.unitType as UnitType}.name`)}</span>
          <span className="troop-list__count">{troop.count.toLocaleString('ru-RU')}</span>
        </li>
      ))}
    </ul>
  );
}

interface ContingentRowProps {
  contingent: SettlementStationedContingentView;
}

/** One foreign contingent, tagged with its owner and origin (§3/§8) — each pays its own Food line so the host can see exactly what a given guest costs before deciding whether to evict it (§3's mitigation). */
function ContingentRow({ contingent }: ContingentRowProps): ReactElement {
  const { t } = useTranslation('military');
  const foodPerHour = calcTroopFoodUpkeepPerHour(DEFAULT_CONFIG, toTroopCounts(contingent.troops));

  return (
    <li className="army-overview__contingent">
      <p className="screen__description">
        {t('overview.contingentOwner', { ownerId: contingent.ownerAccountId })}
      </p>
      <p className="screen__description">
        {t('overview.contingentFrom', { settlementId: contingent.fromSettlementId })}
      </p>
      <TroopGroupList troops={contingent.troops} />
      <span className="army-overview__food">
        {t('overview.foodCost', { amount: foodPerHour.toLocaleString('ru-RU') })}
      </span>
    </li>
  );
}

interface ArmyOverviewProps {
  settlement: SettlementStateView;
}

/**
 * The visible answer to §3 (M3 design record): three troop lists — `troops` (home),
 * `awayTroops` (marching, any leg), `stationedTroops` (foreign contingents this settlement
 * hosts) — each with its own Food cost, plus the settlement's `netFoodPerHour`. Every Food
 * number comes from `game-core`'s `calcTroopFoodUpkeepPerHour` against the catalogue, never
 * computed by hand, so a rebalance of any unit's upkeep changes this display for free.
 *
 * The explanatory line exists because §3's rule reads as a bug otherwise: a marching army
 * still costs this settlement Food (§3's M2 exploit fix — sending troops away must not zero
 * out upkeep), and a hosted ally's contingent is fed by the *host*, not by whoever sent it.
 * Both facts are surprising the first time a player hits them, so they are spelled out here
 * rather than left for the player to reverse-engineer from a falling Food rate.
 */
export function ArmyOverview({ settlement }: ArmyOverviewProps): ReactElement {
  const { t } = useTranslation('military');

  const homeTroops = toTroopCounts(settlement.troops);
  const awayTroops = toTroopCounts(settlement.awayTroops);
  const stationedTroopsFlat = settlement.stationedTroops.flatMap((c) => c.troops);
  const stationedTroops = toTroopCounts(stationedTroopsFlat);

  const homeFoodPerHour = calcTroopFoodUpkeepPerHour(DEFAULT_CONFIG, homeTroops);
  const awayFoodPerHour = calcTroopFoodUpkeepPerHour(DEFAULT_CONFIG, awayTroops);
  const stationedFoodPerHour = calcTroopFoodUpkeepPerHour(DEFAULT_CONFIG, stationedTroops);

  return (
    <section className="panel army-overview">
      <h3 className="screen__subtitle">{t('overview.title')}</h3>
      <p className="screen__description">{t('overview.explanation')}</p>

      <div className="army-overview__group" data-group="home">
        <h4>{t('overview.home')}</h4>
        <TroopGroupList troops={settlement.troops} />
        <span className="army-overview__food army-overview__food--total">
          {t('overview.foodCost', { amount: homeFoodPerHour.toLocaleString('ru-RU') })}
        </span>
      </div>

      <div className="army-overview__group" data-group="away">
        <h4>{t('overview.away')}</h4>
        <TroopGroupList troops={settlement.awayTroops} />
        <span className="army-overview__food army-overview__food--total">
          {t('overview.foodCost', { amount: awayFoodPerHour.toLocaleString('ru-RU') })}
        </span>
      </div>

      <div className="army-overview__group" data-group="stationed">
        <h4>{t('overview.stationed')}</h4>
        {settlement.stationedTroops.length === 0 ? (
          <p className="screen__description">{t('overview.empty')}</p>
        ) : (
          <ul className="army-overview__contingents">
            {settlement.stationedTroops.map((contingent) => (
              <ContingentRow
                key={`${contingent.ownerAccountId}:${contingent.fromSettlementId}`}
                contingent={contingent}
              />
            ))}
          </ul>
        )}
        <span className="army-overview__food army-overview__food--total">
          {t('overview.foodCost', { amount: stationedFoodPerHour.toLocaleString('ru-RU') })}
        </span>
      </div>

      <p className="army-overview__net">
        {t('overview.netFood', { amount: settlement.netFoodPerHour.toLocaleString('ru-RU') })}
      </p>
    </section>
  );
}
