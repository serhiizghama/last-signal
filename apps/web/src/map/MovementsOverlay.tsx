import type { ReactElement } from 'react';
import type { UnitType } from '@last-signal/game-core';
import { DEFAULT_CONFIG, formatDuration } from '@last-signal/game-core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { cancelMovement } from '../api/endpoints';
import type { MovementUnitEntry, MovementView, SettlementStateView } from '../api/types';
import { SETTLEMENTS_MINE_KEY } from '../base/settlementCache';
import { ErrorPanel } from '../components/StatusPanels';
import { useRefetchOnExpiry } from '../hooks/useRefetchOnExpiry';
import { useCountdown } from '../hooks/useServerClock';
import { MOVEMENTS_QUERY_KEY, useMovementsQuery } from './useMovementsQuery';

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
  const boundaryReached = remainingMs === 0;

  // The boundary fix (found in review, same class as the training-UI defect): the countdown
  // clamping at zero is not the same event as the server actually having applied
  // `movementArrive`/`movementReturn` — without this the row froze showing a stale phase
  // forever. `watchKey` folds in `movement.status` because the *same* movement id expires
  // twice (outbound's arrival, then returning's own return) — status is exactly what changes
  // between those two expiries, so it re-arms the guard for the second one.
  const watchKey = `${movement.id}:${movement.status}`;
  useRefetchOnExpiry<MovementView>(
    queryClient,
    boundaryReached,
    watchKey,
    MOVEMENTS_QUERY_KEY,
    (m) => m.id === movement.id && m.status === movement.status,
  );

  // Troops are only credited back to `settlements.troops` on the returning -> done transition
  // (§6's `movementReturn`) — refresh the settlement then too, so the player sees their
  // returned scouts without a reload, but never on the outbound -> returning transition (a
  // wasted round trip, since nothing about `troops` changes at arrival). There's no
  // settlement-shaped signal here to tell "troops credited yet" apart from "not yet" the way
  // a queue-item id can, so `isUnresolved` always reports resolved after the one grace-period
  // refetch `useRefetchOnExpiry` already does — reusing its timing rather than forking a
  // second retry loop just for a single best-effort refresh.
  useRefetchOnExpiry<SettlementStateView>(
    queryClient,
    isReturning && boundaryReached,
    watchKey,
    SETTLEMENTS_MINE_KEY,
    () => false,
  );

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
