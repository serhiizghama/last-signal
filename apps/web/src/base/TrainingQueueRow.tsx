import type { ReactElement } from 'react';
import type { UnitType } from '@last-signal/game-core';
import { formatDuration } from '@last-signal/game-core';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import type { SettlementStateView, SettlementTrainingQueueItemView } from '../api/types';
import { useRefetchOnExpiry } from '../hooks/useRefetchOnExpiry';
import { useCountdown } from '../hooks/useServerClock';
import { SETTLEMENTS_MINE_KEY } from './settlementCache';

interface TrainingQueueRowProps {
  item: SettlementTrainingQueueItemView;
  serverTime: number;
}

/**
 * The active order: unit name, "N of M" remaining, and a live countdown to the next unit — no
 * cancel affordance (§7: training orders can't be cancelled, unlike builds). Shared by the
 * Barracks card (`TrainingSection`) and every building card on the Units tab (M3e.2,
 * `TrainingBuildingCard`) — extracted out of `TrainingSection` when the Units tab needed the
 * exact same countdown row for the Machine Shop and Command Center too, rather than forking a
 * second copy of the refetch-on-expiry dance.
 */
export function TrainingQueueRow({ item, serverTime }: TrainingQueueRowProps): ReactElement {
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
