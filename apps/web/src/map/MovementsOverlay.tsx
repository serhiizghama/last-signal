import type { ReactElement } from 'react';
import { useEffect, useRef } from 'react';
import type { UnitType } from '@last-signal/game-core';
import { DEFAULT_CONFIG, formatDuration } from '@last-signal/game-core';
import type { QueryClient } from '@tanstack/react-query';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { cancelMovement } from '../api/endpoints';
import type { MovementUnitEntry, MovementView } from '../api/types';
import { SETTLEMENTS_MINE_KEY } from '../base/settlementCache';
import { ErrorPanel } from '../components/StatusPanels';
import { useCountdown } from '../hooks/useServerClock';
import { MOVEMENTS_QUERY_KEY, useMovementsQuery } from './useMovementsQuery';

// Mirrors `BuildQueueList`'s own `useRefetchOnExpiry` (see that file's comment for the full
// rationale): the server's own scheduler applies `movementArrive`/`movementReturn` up to ~1s
// after the due instant, so refetching right at the countdown's 0:00 can race it and come back
// showing the same stale status. A short grace period plus a couple of bounded retries rides
// that race out; retrying stops as soon as the movement's status has actually moved on from
// the one that was ticking down (`watchStatus`).
const REFETCH_GRACE_MS = 1500;
const REFETCH_RETRY_DELAY_MS = 1500;
const MAX_REFETCH_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function useRefetchOnExpiry(
  queryClient: QueryClient,
  expired: boolean,
  movementId: string,
  watchStatus: MovementView['status'],
  alsoInvalidateSettlements: boolean,
): void {
  const triggeredRef = useRef(false);

  useEffect(() => {
    triggeredRef.current = false;
  }, [movementId, watchStatus]);

  useEffect(() => {
    if (!expired || triggeredRef.current) {
      return undefined;
    }
    triggeredRef.current = true;
    let cancelled = false;

    async function refetchUntilResolved(): Promise<void> {
      for (let attempt = 1; attempt <= MAX_REFETCH_ATTEMPTS; attempt += 1) {
        await sleep(attempt === 1 ? REFETCH_GRACE_MS : REFETCH_RETRY_DELAY_MS);
        if (cancelled) {
          return;
        }
        await queryClient.invalidateQueries({ queryKey: MOVEMENTS_QUERY_KEY });
        // Troops are only credited back to `settlements.troops` on the returning -> done
        // transition (§6's `movementReturn`) — invalidating settlements on the outbound ->
        // returning transition would just be a wasted round trip.
        if (alsoInvalidateSettlements) {
          await queryClient.invalidateQueries({ queryKey: SETTLEMENTS_MINE_KEY });
        }
        if (cancelled) {
          return;
        }
        const movements = queryClient.getQueryData<MovementView[]>(MOVEMENTS_QUERY_KEY);
        const current = movements?.find((m) => m.id === movementId);
        if (!current || current.status !== watchStatus) {
          return;
        }
      }
    }

    void refetchUntilResolved();
    return () => {
      cancelled = true;
    };
  }, [expired, queryClient, movementId, watchStatus, alsoInvalidateSettlements]);
}

interface UnitListProps {
  units: readonly MovementUnitEntry[];
}

/** `unitType` is cast to `UnitType`, same convention as `settlementSelectors.ts`'s `toTroopCounts`: it only ever comes from the server, which only ever writes real unit types. */
function UnitList({ units }: UnitListProps): ReactElement {
  const { t: tUnits } = useTranslation('units');
  const label = units
    .map((u) => `${tUnits(`${u.unitType as UnitType}.name`)} ×${u.count}`)
    .join(', ');
  return <span className="movement-row__units">{label}</span>;
}

interface MovementRowProps {
  movement: MovementView;
  serverTime: number | undefined;
  onCancel: (movementId: string) => void;
  isCancelling: boolean;
}

function MovementRow({
  movement,
  serverTime,
  onCancel,
  isCancelling,
}: MovementRowProps): ReactElement {
  const { t } = useTranslation('map');
  const { t: tCommon } = useTranslation();
  const queryClient = useQueryClient();

  const isReturning = movement.status === 'returning';
  const dueAt = isReturning ? (movement.returnAt ?? undefined) : movement.arriveAt;
  const remainingMs = useCountdown(serverTime, dueAt);

  useRefetchOnExpiry(queryClient, remainingMs === 0, movement.id, movement.status, isReturning);

  // The 90s recall window (§6, `config.movement.cancelWindowMs`) is a client-side
  // plausibility check only — the server is the authority and rejects a late cancel with its
  // own i18n key (`errors.movement.cancelWindowExpired`) if this clock has drifted.
  const cancelWindowRemainingMs = useCountdown(
    serverTime,
    movement.status === 'outbound'
      ? movement.departAt + DEFAULT_CONFIG.movement.cancelWindowMs
      : undefined,
  );
  const canCancel =
    movement.status === 'outbound' &&
    cancelWindowRemainingMs !== undefined &&
    cancelWindowRemainingMs > 0;

  const unitsToShow = isReturning ? movement.survivors : movement.units;

  return (
    <li className="movement-row" data-status={movement.status}>
      <div className="movement-row__main">
        <span className="movement-row__status">
          {isReturning ? t('movements.returningStatus') : t('movements.outboundStatus')}
        </span>
        <span className="movement-row__target">
          {t('movements.target', { x: movement.target.x, y: movement.target.y })}
        </span>
        <span className="movement-row__countdown">
          {isReturning
            ? t('movements.homeIn', { duration: formatDuration(remainingMs ?? 0) })
            : t('movements.arrivesIn', { duration: formatDuration(remainingMs ?? 0) })}
        </span>
        <UnitList units={unitsToShow} />
      </div>

      {canCancel && (
        <button
          type="button"
          className="button"
          disabled={isCancelling}
          onClick={() => onCancel(movement.id)}
        >
          {isCancelling ? tCommon('actions.submitting') : t('movements.cancel')}
        </button>
      )}
    </li>
  );
}

/**
 * The Map tab's own-movements overlay (§5/§6/§11): outbound and returning movements with live
 * countdowns anchored to the server clock, units aboard, and a cancel action while a movement
 * is still inside its recall window. `done` movements are filtered out — they have nothing
 * left to show or act on (arrival and return both already resolved) — so the overlay never
 * grows into a completed-movement history; that's the Reports tab's job (M2c.3), not this
 * screen's. Renders nothing (not even an empty panel) once the caller has no open movements,
 * so the Map tab stays uncluttered for the common case.
 */
export function MovementsOverlay(): ReactElement | null {
  const { t } = useTranslation('map');
  const query = useMovementsQuery();
  const queryClient = useQueryClient();

  const cancelMutation = useMutation({
    mutationFn: (movementId: string) => cancelMovement(movementId),
    onSuccess: (updated) => {
      queryClient.setQueryData<MovementView[]>(MOVEMENTS_QUERY_KEY, (old) =>
        old ? old.map((m) => (m.id === updated.id ? updated : m)) : [updated],
      );
    },
  });

  if (!query.data) {
    return null;
  }

  const movements = query.data.filter((m) => m.status !== 'done');
  if (movements.length === 0) {
    return null;
  }

  const serverTime = movements[0]?.serverTime;

  return (
    <section className="panel movements-overlay">
      <h3 className="screen__subtitle">{t('movements.title')}</h3>

      {cancelMutation.isError && <ErrorPanel error={cancelMutation.error} />}

      <ul className="movements-overlay__list">
        {movements.map((movement) => (
          <MovementRow
            key={movement.id}
            movement={movement}
            serverTime={serverTime}
            onCancel={(movementId) => cancelMutation.mutate(movementId)}
            isCancelling={cancelMutation.isPending && cancelMutation.variables === movement.id}
          />
        ))}
      </ul>
    </section>
  );
}
