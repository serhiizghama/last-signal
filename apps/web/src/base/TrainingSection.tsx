import type { ChangeEvent, ReactElement } from 'react';
import type { UnitType } from '@last-signal/game-core';
import { DEFAULT_CONFIG, formatDuration } from '@last-signal/game-core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { trainScouts } from '../api/endpoints';
import type {
  AccountView,
  SettlementStateView,
  SettlementTrainingQueueItemView,
  SettlementTroopView,
} from '../api/types';
import { ErrorPanel } from '../components/StatusPanels';
import { useRefetchOnExpiry } from '../hooks/useRefetchOnExpiry';
import { useCountdown } from '../hooks/useServerClock';
import { CostList } from './CostList';
import { SETTLEMENTS_MINE_KEY, updateSettlementCache } from './settlementCache';
import type { TrainBlockReason } from './trainEligibility';
import { computeTrainEligibility } from './trainEligibility';
import type { LiveResources } from './useLiveResources';

interface TrainingSectionProps {
  settlement: SettlementStateView;
  live: LiveResources;
  account: AccountView;
}

/** Translates a `TrainBlockReason` through the same `errors.training.*` keys the server itself rejects with (§7/§11) — client and server never disagree on the wording. */
function useTrainBlockReasonText(block: TrainBlockReason | undefined): string | undefined {
  const { t: tErrors } = useTranslation('errors');
  if (!block) {
    return undefined;
  }
  switch (block.kind) {
    case 'noFaction':
      return tErrors('training.noFaction');
    case 'noBarracks':
      return tErrors('training.noBarracks');
    case 'queueBusy':
      return tErrors('training.queueBusy');
    case 'wouldStarve':
      return tErrors('training.wouldStarve');
    case 'insufficientResources':
      return tErrors('training.insufficientResources');
  }
}

interface TrainingQueueRowProps {
  item: SettlementTrainingQueueItemView;
  serverTime: number;
}

/** The active order: unit name, "N of M" remaining, and a live countdown to the next unit — no cancel affordance (§7: training orders can't be cancelled, unlike builds). */
function TrainingQueueRow({ item, serverTime }: TrainingQueueRowProps): ReactElement {
  const { t } = useTranslation();
  const { t: tUnits } = useTranslation('units');
  const queryClient = useQueryClient();
  const remainingMs = useCountdown(serverTime, item.nextCompletesAt);

  // Once the countdown to the next unit hits zero, the server has (or is about to have)
  // credited it via its own chained `trainingComplete` event (§7) — refetch (bounded retry,
  // see `useRefetchOnExpiry`) rather than leaving the queue stuck at "00:00"/the stale
  // remaining count forever (the defect the orchestrator found in review). The order keeps
  // the same `id` across its whole batch, unlike a build queue item, so the watch key folds
  // in `nextCompletesAt` too — a fresh value means the server has moved on to the next unit
  // and this specific completion needs its own watch cycle.
  useRefetchOnExpiry<SettlementStateView>(
    queryClient,
    remainingMs === 0,
    `${item.id}:${item.nextCompletesAt}`,
    SETTLEMENTS_MINE_KEY,
    (s) =>
      s.trainingQueue.some((q) => q.id === item.id && q.nextCompletesAt === item.nextCompletesAt),
  );

  return (
    <div className="training-queue-item">
      <span className="training-queue-item__name">
        {tUnits(`${item.unitType as UnitType}.name`)}
      </span>
      <span className="training-queue-item__progress">
        {t('base.trainingProgress', { remaining: item.remainingCount, total: item.totalCount })}
      </span>
      <span className="training-queue-item__countdown">
        {t('base.trainingNextIn', { duration: formatDuration(remainingMs ?? 0) })}
      </span>
    </div>
  );
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
 */
export function TrainingSection({ settlement, live, account }: TrainingSectionProps): ReactElement {
  const { t } = useTranslation();
  const { t: tUnits } = useTranslation('units');
  const queryClient = useQueryClient();
  const [count, setCount] = useState(1);

  const eligibility = computeTrainEligibility(
    DEFAULT_CONFIG,
    live.buildings,
    settlement.trainingQueue.length,
    live.troops,
    live.values,
    account.faction,
    count,
  );
  const reasonText = useTrainBlockReasonText(eligibility.block);

  const trainMutation = useMutation({
    mutationFn: (input: { unitType: UnitType; count: number }) =>
      trainScouts(settlement.id, input.unitType, input.count),
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
