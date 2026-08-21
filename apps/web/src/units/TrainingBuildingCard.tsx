import type { ChangeEvent, ReactElement } from 'react';
import type { BuildingType, UnitType } from '@last-signal/game-core';
import { DEFAULT_CONFIG, formatDuration, unitsTrainableAt } from '@last-signal/game-core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { trainUnits } from '../api/endpoints';
import type { AccountView, SettlementStateView } from '../api/types';
import { CostList } from '../base/CostList';
import { updateSettlementCache } from '../base/settlementCache';
import type { TrainEligibility } from '../base/trainEligibility';
import { computeUnitTrainEligibility } from '../base/trainEligibility';
import { TrainingQueueRow } from '../base/TrainingQueueRow';
import type { LiveResources } from '../base/useLiveResources';
import { useTrainBlockReasonText } from '../base/useTrainBlockReasonText';
import { ErrorPanel } from '../components/StatusPanels';

interface UnitRowProps {
  unitType: UnitType;
  settlement: SettlementStateView;
  live: LiveResources;
  account: AccountView;
  isSubmitting: boolean;
  onSubmit: (unitType: UnitType, count: number) => void;
}

/**
 * One roster row: the unit's full catalogue stats (§17 — attack/defInfantry/defCavalry/speed/
 * carry/Food upkeep, train time at *this settlement's current building level*, never
 * hardcoded), its own count picker, and a Train button disabled with the same
 * `errors.training.*` reason the server itself would reject with — reusing
 * `computeUnitTrainEligibility` and `useTrainBlockReasonText`, both shared with the Barracks
 * card (`TrainingSection`) so the two surfaces never disagree.
 *
 * Unavailable units are shown, not hidden (§17): a unit blocked by `buildingMissing`,
 * `queueBusy`, `wouldStarve` or `insufficientResources` still renders with its full stat
 * block and cost, just disabled with the reason underneath — the player can see what they're
 * working toward before they can afford it.
 */
function UnitRow({
  unitType,
  settlement,
  live,
  account,
  isSubmitting,
  onSubmit,
}: UnitRowProps): ReactElement {
  const { t } = useTranslation();
  const { t: tUnits } = useTranslation('units');
  const { t: tMilitary } = useTranslation('military');
  const [count, setCount] = useState(1);

  const def = DEFAULT_CONFIG.units[unitType];
  const eligibility: TrainEligibility = computeUnitTrainEligibility(
    DEFAULT_CONFIG,
    unitType,
    live.buildings,
    settlement.trainingQueue,
    live.troops,
    live.values,
    account.faction,
    count,
  );
  const reasonText = useTrainBlockReasonText(eligibility.block);
  const disabled = !eligibility.canStart || isSubmitting;

  function handleCountChange(event: ChangeEvent<HTMLInputElement>): void {
    const parsed = Number.parseInt(event.target.value, 10);
    setCount(Number.isFinite(parsed) && parsed >= 1 ? parsed : 1);
  }

  return (
    <li className="building-card">
      <div className="building-card__header">
        <span className="building-card__name">{tUnits(`${unitType}.name`)}</span>
      </div>

      <ul className="unit-stats">
        <li>
          {tMilitary('stats.attack')}: {def.attack}
        </li>
        <li>
          {tMilitary('stats.defInfantry')}: {def.defInfantry}
        </li>
        <li>
          {tMilitary('stats.defCavalry')}: {def.defCavalry}
        </li>
        <li>
          {tMilitary('stats.speed')}: {def.speed}
        </li>
        <li>
          {tMilitary('stats.carry')}: {def.carry}
        </li>
        <li>
          {tMilitary('stats.foodUpkeep')}: {def.foodUpkeepPerHour}
        </li>
      </ul>

      <CostList cost={eligibility.cost} />

      <span className="training-section__time">
        {t('base.trainUnitTime', { duration: formatDuration(eligibility.unitTimeMs) })}
      </span>
      <span className="training-section__time">
        {t('base.trainBatchTime', { duration: formatDuration(eligibility.batchTimeMs) })}
      </span>

      <label className="training-section__count">
        {t('base.trainCount')}
        <input type="number" min={1} value={count} onChange={handleCountChange} />
      </label>

      <button
        type="button"
        className="button button--primary"
        disabled={disabled}
        onClick={() => onSubmit(unitType, count)}
      >
        {isSubmitting ? t('actions.submitting') : t('base.trainSubmit')}
      </button>

      {reasonText && <p className="building-card__reason">{reasonText}</p>}
    </li>
  );
}

interface TrainingBuildingCardProps {
  building: BuildingType;
  settlement: SettlementStateView;
  live: LiveResources;
  account: AccountView;
}

/**
 * One of the Units tab's three roster cards (§17: Barracks / Machine Shop / Command Center).
 * Lists everything `building` trains for the caller's own faction plus the faction-neutral
 * Settler (`unitsTrainableAt` — this is exactly the filter that keeps other factions' units
 * and both wildlife types off the roster, §17's own wording), and the building's single active
 * order with its live countdown, reusing `TrainingQueueRow` byte-for-byte with the Barracks
 * card on the Base screen.
 *
 * One `useMutation` per card rather than per unit row: the server enforces one active order
 * *per building* (M3 §2), so every unit row in this card is racing for the same slot anyway —
 * a single mutation naturally serializes them and lets `isSubmitting` grey out only the row
 * that was actually submitted (`trainMutation.variables`).
 */
export function TrainingBuildingCard({
  building,
  settlement,
  live,
  account,
}: TrainingBuildingCardProps): ReactElement {
  const { t: tBuildings } = useTranslation('buildings');
  const { t: tMilitary } = useTranslation('military');
  const queryClient = useQueryClient();

  const trainMutation = useMutation({
    mutationFn: (input: { unitType: UnitType; count: number }) =>
      trainUnits(settlement.id, input.unitType, input.count),
    onSuccess: (updated) => updateSettlementCache(queryClient, updated),
  });

  const unitDefs = account.faction
    ? unitsTrainableAt(DEFAULT_CONFIG, building, account.faction)
    : [];

  // At most one, per building (§2) — derived from each queue item's own `unitType`, exactly
  // like the eligibility check's own `ordersAtThisBuilding`, not stored on the item itself.
  const activeOrder = settlement.trainingQueue.find(
    (item) => DEFAULT_CONFIG.units[item.unitType as UnitType].trainedIn === building,
  );

  return (
    <section className="panel building-list-section" data-building={building}>
      <h3 className="screen__subtitle">{tBuildings(`${building}.name`)}</h3>

      {trainMutation.isError && <ErrorPanel error={trainMutation.error} />}

      {activeOrder && <TrainingQueueRow item={activeOrder} serverTime={settlement.serverTime} />}

      {account.faction ? (
        <ul className="building-list">
          {unitDefs.map((def) => (
            <UnitRow
              key={def.type}
              unitType={def.type}
              settlement={settlement}
              live={live}
              account={account}
              isSubmitting={
                trainMutation.isPending && trainMutation.variables?.unitType === def.type
              }
              onSubmit={(unitType, count) => trainMutation.mutate({ unitType, count })}
            />
          ))}
        </ul>
      ) : (
        <p className="screen__description">{tMilitary('roster.noFactionUnits')}</p>
      )}
    </section>
  );
}
