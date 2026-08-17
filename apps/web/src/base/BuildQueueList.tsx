import type { ReactElement } from 'react';
import { formatDuration } from '@last-signal/game-core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { cancelBuild } from '../api/endpoints';
import type { SettlementBuildQueueItemView, SettlementStateView } from '../api/types';
import { ErrorPanel } from '../components/StatusPanels';
import { useRefetchOnExpiry } from '../hooks/useRefetchOnExpiry';
import { useCountdown } from '../hooks/useServerClock';
import { BUILD_QUEUE_CAPACITY } from './constants';
import { SETTLEMENTS_MINE_KEY, updateSettlementCache } from './settlementCache';

interface BuildQueueListProps {
  settlement: SettlementStateView;
}

interface QueueItemRowProps {
  item: SettlementBuildQueueItemView;
  position: number;
  serverTime: number;
  onCancel: (queueItemId: string) => void;
  isCancelling: boolean;
}

function QueueItemRow({
  item,
  position,
  serverTime,
  onCancel,
  isCancelling,
}: QueueItemRowProps): ReactElement {
  const { t } = useTranslation();
  const { t: tBuildings } = useTranslation('buildings');
  const queryClient = useQueryClient();

  const isActive = item.startedAt !== null && item.completesAt !== null;
  const remainingMs = useCountdown(serverTime, item.completesAt ?? undefined);

  // Once the countdown for the active item hits zero, the server has (or is about to have)
  // completed the build via its own scheduled event — refetch (with a bounded retry to ride
  // out the server's own polling latency; see `useRefetchOnExpiry`) rather than leaving the
  // queue stuck showing "00:00" until the player happens to reload. A completed build item
  // never reappears under the same `id`, so the id alone is enough to identify "this one".
  useRefetchOnExpiry<SettlementStateView>(
    queryClient,
    isActive && remainingMs === 0,
    item.id,
    SETTLEMENTS_MINE_KEY,
    (s) => s.buildQueue.some((q) => q.id === item.id),
  );

  const totalMs =
    isActive && item.startedAt !== null && item.completesAt !== null
      ? item.completesAt - item.startedAt
      : 0;
  const progress =
    isActive && totalMs > 0 ? Math.min(1, Math.max(0, 1 - (remainingMs ?? totalMs) / totalMs)) : 0;

  return (
    <li className="queue-item">
      <div className="queue-item__main">
        <span className="queue-item__name">
          {tBuildings(`${item.type}.name`)} · {t('base.level', { level: item.targetLevel })}
        </span>
        {isActive ? (
          <>
            <span className="queue-item__status">{t('base.queueActive')}</span>
            <span className="queue-item__countdown">
              {t('base.queueRemaining', { duration: formatDuration(remainingMs ?? 0) })}
            </span>
            <div className="queue-item__progress">
              <div
                className="queue-item__progress-fill"
                style={{ width: `${(progress * 100).toFixed(2)}%` }}
              />
            </div>
          </>
        ) : (
          <span className="queue-item__status">{t('base.queuePosition', { position })}</span>
        )}
      </div>
      <button
        type="button"
        className="button"
        disabled={isCancelling}
        onClick={() => onCancel(item.id)}
      >
        {isCancelling ? t('actions.submitting') : t('base.queueCancel')}
      </button>
    </li>
  );
}

/** Up to `BUILD_QUEUE_CAPACITY` items: the active build(s) with a live countdown, the rest waiting their turn. */
export function BuildQueueList({ settlement }: BuildQueueListProps): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const cancelMutation = useMutation({
    mutationFn: (queueItemId: string) => cancelBuild(settlement.id, queueItemId),
    onSuccess: (updated) => updateSettlementCache(queryClient, updated),
  });

  return (
    <section className="panel build-queue">
      <h3 className="screen__subtitle">
        {t('base.queueTitle')} ·{' '}
        {t('base.queueCapacity', {
          current: settlement.buildQueue.length,
          capacity: BUILD_QUEUE_CAPACITY,
        })}
      </h3>

      {cancelMutation.isError && <ErrorPanel error={cancelMutation.error} />}

      {settlement.buildQueue.length === 0 ? (
        <p className="screen__description">{t('base.queueEmpty')}</p>
      ) : (
        <ul className="build-queue__list">
          {settlement.buildQueue.map((item, index) => (
            <QueueItemRow
              key={item.id}
              item={item}
              position={index + 1}
              serverTime={settlement.serverTime}
              onCancel={(id) => cancelMutation.mutate(id)}
              isCancelling={cancelMutation.isPending && cancelMutation.variables === item.id}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
