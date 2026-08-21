import type { ChangeEvent, ReactElement } from 'react';
import type { UnitType } from '@last-signal/game-core';
import { DEFAULT_CONFIG, formatDuration } from '@last-signal/game-core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { trainUnits } from '../api/endpoints';
import type { AccountView, SettlementStateView, SettlementTroopView } from '../api/types';
import { ErrorPanel } from '../components/StatusPanels';
import { CostList } from './CostList';
import { updateSettlementCache } from './settlementCache';
import { computeTrainEligibility } from './trainEligibility';
import { TrainingQueueRow } from './TrainingQueueRow';
import { useTrainBlockReasonText } from './useTrainBlockReasonText';
import type { LiveResources } from './useLiveResources';

interface TrainingSectionProps {
  settlement: SettlementStateView;
  live: LiveResources;
  account: AccountView;
}

interface HomeTroopsListProps {
  troops: readonly SettlementTroopView[];
}

/** What the settlement has at home right now — the scouts the player has already paid for (§11 item 3). */
function HomeTroopsList({ troops }: HomeTroopsListProps): ReactElement {
  const { t } = useTranslation();
  const { t: tUnits } = useTranslation('units');

  if (troops.length === 0) {
    return <p className="screen__description">{t('base.troopsEmpty')}</p>;
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

/**
 * The Barracks card's training UI (§11: "count picker + queue countdown, reusing M1c
 * patterns"): home troops, the active order's live countdown, and the count-picker form that
 * starts a new order — disabled with an explicit reason exactly like `BuildingList`'s own build
 * button (`buildEligibility.ts`/`trainEligibility.ts`). The reasons are computed client-side
 * from `game-core` so the player sees them before submitting; a server rejection still renders
 * through the same `errors.training.*` i18n path via `ErrorPanel`.
 *
 * Deliberately kept scout-only and left right here on the Base screen (M3e.2 decision, not an
 * oversight): the Units tab (`units/UnitsScreen.tsx`) is now where §17 puts the full roster —
 * Barracks/Machine Shop/Command Center cards for every trainable unit, reusing this same
 * countdown row (`TrainingQueueRow`) and eligibility function
 * (`computeUnitTrainEligibility`, the general form `computeTrainEligibility` below now
 * delegates to). This card stays as the Base screen's own quick "train a scout without
 * switching tabs" convenience — the M2c onboarding loop is literally "build a Barracks, train
 * a scout, scout somebody" (M3 §11), and moving that action behind a tab switch would be a
 * regression for the exact flow that loop teaches. Training a scout here and training one from
 * the Units tab hit the identical endpoint and the identical per-building queue, so there is
 * no double-booking between the two surfaces.
 */
export function TrainingSection({ settlement, live, account }: TrainingSectionProps): ReactElement {
  const { t } = useTranslation();
  const { t: tUnits } = useTranslation('units');
  const queryClient = useQueryClient();
  const [count, setCount] = useState(1);

  const eligibility = computeTrainEligibility(
    DEFAULT_CONFIG,
    live.buildings,
    settlement.trainingQueue,
    live.troops,
    live.values,
    account.faction,
    count,
  );
  const reasonText = useTrainBlockReasonText(eligibility.block);

  const trainMutation = useMutation({
    mutationFn: (input: { unitType: UnitType; count: number }) =>
      trainUnits(settlement.id, input.unitType, input.count),
    onSuccess: (updated) => updateSettlementCache(queryClient, updated),
  });

  const disabled = !eligibility.canStart || trainMutation.isPending;

  function handleCountChange(event: ChangeEvent<HTMLInputElement>): void {
    const parsed = Number.parseInt(event.target.value, 10);
    setCount(Number.isFinite(parsed) && parsed >= 1 ? parsed : 1);
  }

  return (
    <div className="training-section">
      <h4 className="training-section__title">{t('base.trainingTitle')}</h4>

      <HomeTroopsList troops={settlement.troops} />

      {settlement.trainingQueue.map((item) => (
        <TrainingQueueRow key={item.id} item={item} serverTime={settlement.serverTime} />
      ))}

      {trainMutation.isError && <ErrorPanel error={trainMutation.error} />}

      <div className="training-section__form">
        {eligibility.unitType && (
          <span className="training-section__unit">{tUnits(`${eligibility.unitType}.name`)}</span>
        )}

        <label className="training-section__count">
          {t('base.trainCount')}
          <input type="number" min={1} value={count} onChange={handleCountChange} />
        </label>

        <CostList cost={eligibility.cost} />

        <span className="training-section__time">
          {t('base.trainUnitTime', { duration: formatDuration(eligibility.unitTimeMs) })}
        </span>
        <span className="training-section__time">
          {t('base.trainBatchTime', { duration: formatDuration(eligibility.batchTimeMs) })}
        </span>

        <button
          type="button"
          className="button button--primary"
          disabled={disabled}
          onClick={() => {
            if (eligibility.unitType) {
              trainMutation.mutate({ unitType: eligibility.unitType, count });
            }
          }}
        >
          {trainMutation.isPending ? t('actions.submitting') : t('base.trainSubmit')}
        </button>

        {reasonText && <p className="building-card__reason">{reasonText}</p>}
      </div>
    </div>
  );
}
