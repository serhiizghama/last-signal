import type { ChangeEvent, FormEvent, ReactElement } from 'react';
import { useState } from 'react';
import type { Faction, TroopCounts } from '@last-signal/game-core';
import {
  DEFAULT_CONFIG,
  chebyshevDistance,
  formatDuration,
  slowestTroopSpeed,
  travelTimeMs,
} from '@last-signal/game-core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { sendScouts } from '../api/endpoints';
import type { Tile as ApiTile } from './mapGeometry';
import { SETTLEMENTS_MINE_KEY } from '../base/settlementCache';
import { ErrorPanel } from '../components/StatusPanels';
import { computeScoutEligibility } from './scoutEligibility';
import { MOVEMENTS_QUERY_KEY } from './useMovementsQuery';

interface ScoutFormProps {
  fromSettlementId: string;
  origin: ApiTile;
  target: ApiTile;
  faction: Faction;
  troops: TroopCounts;
  /**
   * §11: while the target is still beginner-protected, scouting it is rejected the same as
   * raid/assault/support — computed by the caller (`isBeginnerProtected` against the server
   * clock, never `Date.now()`) since a plain settlement/oasis target has no notion of "am I
   * protected" on its own.
   */
  isProtected: boolean;
  /** Called once the movement is created — the sheet closes on a successful send. */
  onSent: () => void;
}

/**
 * The send-scout form (§11): a unit count picker bounded by the scouts actually at home, and a
 * live travel-time preview computed client-side with the exact same `game-core` formula the
 * server uses (`chebyshevDistance` + `slowestTroopSpeed` + `travelTimeMs`, M1c's countdown
 * convention). Only ever rendered by `TileInfoSheet` for a tile that already resolved to
 * "another player's settlement" or an oasis (§10 lifted the old M2 "oases aren't scoutable"
 * rule) — `classifyTile` handles the own-settlement exclusion, so what's left to gate here is
 * beginner protection and scouts-at-home (`computeScoutEligibility`).
 */
export function ScoutForm({
  fromSettlementId,
  origin,
  target,
  faction,
  troops,
  isProtected,
  onSent,
}: ScoutFormProps): ReactElement {
  const { t } = useTranslation('map');
  const { t: tCommon } = useTranslation();
  const { t: tUnits } = useTranslation('units');
  const { t: tErrors } = useTranslation('errors');
  const queryClient = useQueryClient();

  const eligibility = computeScoutEligibility(DEFAULT_CONFIG, faction, troops, isProtected);
  const [rawCount, setRawCount] = useState(1);
  const count = Math.min(Math.max(1, rawCount), Math.max(1, eligibility.availableCount));

  const distance = chebyshevDistance(origin, target);
  // Computed from the actual selection, not assumed — it won't change with `count` in M2
  // (a faction has one scout type, so speed is fixed), but the next unit added to a faction's
  // roster must not silently become a stale preview.
  const speed = slowestTroopSpeed(DEFAULT_CONFIG, [{ unitType: eligibility.scoutUnitType, count }]);
  const travelMs = travelTimeMs(DEFAULT_CONFIG, distance, speed);

  const sendMutation = useMutation({
    mutationFn: () =>
      sendScouts({
        type: 'scout',
        fromSettlementId,
        target,
        units: [{ unitType: eligibility.scoutUnitType, count }],
      }),
    onSuccess: () => {
      // The movements list gains a new entry and the origin settlement's troops just shrank —
      // both are invalidated rather than patched by hand, since this response is a
      // `MovementView`, not a `SettlementStateView` (nothing here carries the settlement's new
      // troop list to patch the cache with directly).
      void queryClient.invalidateQueries({ queryKey: MOVEMENTS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: SETTLEMENTS_MINE_KEY });
      onSent();
    },
  });

  function handleCountChange(event: ChangeEvent<HTMLInputElement>): void {
    setRawCount(Number(event.target.value));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!eligibility.canScout) {
      return;
    }
    sendMutation.mutate();
  }

  if (!eligibility.canScout) {
    return (
      <div className="tile-sheet__scout">
        <button type="button" className="button button--primary" disabled>
          {t('scout.action')}
        </button>
        <p className="tile-sheet__reason">
          {/* §11: the protected case reuses the server's own `errors.movement.targetProtected`
              key verbatim — the wording players see here must never drift from what a rejected
              send would show. */}
          {eligibility.block?.kind === 'protected'
            ? tErrors('movement.targetProtected')
            : t('scout.noScoutsAtHome')}
        </p>
      </div>
    );
  }

  return (
    <form className="tile-sheet__scout" onSubmit={handleSubmit}>
      <label className="field">
        <span className="field__label">
          {t('scout.unitCountLabel', { name: tUnits(`${eligibility.scoutUnitType}.name`) })}
        </span>
        <input
          className="field__input"
          type="number"
          inputMode="numeric"
          min={1}
          max={eligibility.availableCount}
          value={count}
          onChange={handleCountChange}
        />
      </label>

      <p className="tile-sheet__available">
        {t('scout.available', { count: eligibility.availableCount })}
      </p>
      <p className="tile-sheet__travel-time">
        {t('scout.travelTime', { duration: formatDuration(travelMs) })}
      </p>

      {sendMutation.isError && <ErrorPanel error={sendMutation.error} />}

      <button type="submit" className="button button--primary" disabled={sendMutation.isPending}>
        {sendMutation.isPending ? tCommon('actions.submitting') : t('scout.submit')}
      </button>
    </form>
  );
}
