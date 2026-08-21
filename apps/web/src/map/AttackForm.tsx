import type { ChangeEvent, FormEvent, ReactElement } from 'react';
import { useState } from 'react';
import type { TroopCounts, UnitType } from '@last-signal/game-core';
import {
  BUILDING_TYPES,
  DEFAULT_CONFIG,
  chebyshevDistance,
  formatDuration,
  slowestTroopSpeed,
  travelTimeMs,
} from '@last-signal/game-core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { sendMovement } from '../api/endpoints';
import type { Tile as ApiTile } from './mapGeometry';
import { SETTLEMENTS_MINE_KEY } from '../base/settlementCache';
import { ErrorPanel } from '../components/StatusPanels';
import { armyUnitOptions, computeAttackBlockReason } from './armyEligibility';
import type { AttackableMovementType } from './movementLegality';
import { MOVEMENTS_QUERY_KEY } from './useMovementsQuery';

interface AttackFormProps {
  fromSettlementId: string;
  origin: ApiTile;
  target: ApiTile;
  /** What is actually at home right now (`settlement.troops`) — never the full roster (§17). */
  troops: TroopCounts;
  /** Which of raid/assault/support this target's *kind* legally accepts (`movementLegality.ts`); never empty when `TileInfoSheet` renders this component at all. */
  allowedTypes: readonly AttackableMovementType[];
  /** §11: while the target is still beginner-protected, every one of these three types is rejected — this form renders disabled with the reason rather than letting the player build an army for nothing. */
  isProtected: boolean;
  /** Called once the movement is created — the sheet closes on a successful send, same convention as `ScoutForm`. */
  onSent: () => void;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

/**
 * The raid/assault/support form (§17, M3e.3): a movement-type picker bounded by what this
 * target's *kind* legally accepts (`allowedTypes`, from `movementLegality.ts`), an army
 * picker bounded by what is actually at home and filtered per §1/§9's role rules for the
 * selected type (`armyEligibility.ts`), a siege-target picker that appears only once a siege
 * unit is actually selected, and a live travel-time preview from the same
 * `chebyshevDistance` + `slowestTroopSpeed` + `travelTimeMs` triple `ScoutForm` already uses
 * — see that component's own comment for why the speed must be derived from the live
 * selection rather than assumed; with many unit types in play here, the slowest unit
 * genuinely can change as the selection changes, which never happened for a scout-only army.
 *
 * Only ever rendered by `TileInfoSheet` for a target `movementLegality.ts` already resolved
 * as legal for at least one of these three types; what's left to gate here is army
 * composition (`armyEligibility.ts`) and beginner protection (`isProtected`).
 */
export function AttackForm({
  fromSettlementId,
  origin,
  target,
  troops,
  allowedTypes,
  isProtected,
  onSent,
}: AttackFormProps): ReactElement {
  const { t } = useTranslation('map');
  const { t: tCommon } = useTranslation();
  const { t: tMilitary } = useTranslation('military');
  const { t: tErrors } = useTranslation('errors');
  const { t: tUnits } = useTranslation('units');
  const { t: tBuildings } = useTranslation('buildings');
  const queryClient = useQueryClient();

  // `allowedTypes` is never empty (`TileInfoSheet` never renders this component otherwise) —
  // the `?? 'raid'` only satisfies `noUncheckedIndexedAccess`, it can never actually fire.
  const [movementType, setMovementType] = useState<AttackableMovementType>(
    allowedTypes[0] ?? 'raid',
  );
  const [counts, setCounts] = useState<Partial<Record<UnitType, number>>>({});
  const [siegeTarget, setSiegeTarget] = useState<string | undefined>(undefined);

  const unitOptions = armyUnitOptions(DEFAULT_CONFIG, movementType, troops);
  // Clamped against each option's own `availableCount` here (not just at input time) so a
  // count picked while a *different, larger* unit's max was in play (impossible today since
  // each unitType has one fixed home count, but kept as a structural guarantee rather than an
  // assumption) can never silently exceed what's actually at home.
  const selectedUnits = unitOptions
    .map(({ unitType, availableCount }) => ({
      unitType,
      count: clamp(counts[unitType] ?? 0, 0, availableCount),
    }))
    .filter((u) => u.count > 0);
  const hasSiegeUnit = selectedUnits.some((u) => DEFAULT_CONFIG.units[u.unitType].role === 'siege');

  const distance = chebyshevDistance(origin, target);
  const speed =
    selectedUnits.length > 0 ? slowestTroopSpeed(DEFAULT_CONFIG, selectedUnits) : undefined;
  const travelMs = speed !== undefined ? travelTimeMs(DEFAULT_CONFIG, distance, speed) : undefined;

  const blockReason = computeAttackBlockReason(
    DEFAULT_CONFIG,
    movementType,
    selectedUnits,
    hasSiegeUnit,
    siegeTarget,
  );

  const sendMutation = useMutation({
    mutationFn: () =>
      sendMovement({
        type: movementType,
        fromSettlementId,
        target,
        units: selectedUnits,
        // Only ever included once there's an actual siege pass to aim it at (§7/§9) — mirrors
        // `MovementsService.sendMovement`'s own step 6, which discards a stray `siegeTarget`
        // the same way when no siege unit made the trip.
        ...(hasSiegeUnit && siegeTarget !== undefined ? { siegeTarget } : {}),
      }),
    onSuccess: () => {
      // Same rationale as `ScoutForm`'s own `onSuccess`: the response is a `MovementView`,
      // not a settlement snapshot, so both caches are invalidated rather than patched by hand.
      void queryClient.invalidateQueries({ queryKey: MOVEMENTS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: SETTLEMENTS_MINE_KEY });
      onSent();
    },
  });

  function handleCountChange(
    unitType: UnitType,
    availableCount: number,
    event: ChangeEvent<HTMLInputElement>,
  ): void {
    setCounts((prev) => ({
      ...prev,
      [unitType]: clamp(Number(event.target.value), 0, availableCount),
    }));
  }

  function handleSiegeTargetChange(event: ChangeEvent<HTMLSelectElement>): void {
    setSiegeTarget(event.target.value === '' ? undefined : event.target.value);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (blockReason || isProtected) {
      return;
    }
    sendMutation.mutate();
  }

  if (isProtected) {
    return (
      <div className="tile-sheet__attack">
        <button type="button" className="button button--primary" disabled>
          {t('attack.action')}
        </button>
        {/* §11: reuses the server's own `errors.movement.targetProtected` key verbatim —
            never a parallel wording the client invented, so this can never drift from what a
            rejected send would show. */}
        <p className="tile-sheet__reason">{tErrors('movement.targetProtected')}</p>
      </div>
    );
  }

  return (
    <form className="tile-sheet__attack" onSubmit={handleSubmit}>
      {allowedTypes.length > 1 && (
        <fieldset className="attack-form__type">
          <legend className="field__label">{t('attack.typeLabel')}</legend>
          {allowedTypes.map((type) => (
            <label key={type} className="attack-form__type-option">
              <input
                type="radio"
                name={`movement-type-${fromSettlementId}-${target.x}-${target.y}`}
                value={type}
                checked={movementType === type}
                onChange={() => setMovementType(type)}
              />
              {tMilitary(`movementType.${type}`)}
            </label>
          ))}
        </fieldset>
      )}

      {/* §6: an assault is the heavier commitment (100% loser losses vs. a raid's partial
          engagement) and the only type that can carry siege — spelled out once, not per
          selection, and only when both are actually on offer (never for the own-settlement
          support-only case). */}
      {allowedTypes.includes('raid') && allowedTypes.includes('assault') && (
        <p className="tile-sheet__note">{t('attack.typeExplanation')}</p>
      )}

      {unitOptions.length === 0 ? (
        <p className="tile-sheet__note">{t('attack.noEligibleUnits')}</p>
      ) : (
        <ul className="attack-form__unit-list">
          {unitOptions.map(({ unitType, availableCount }) => (
            <li key={unitType} className="attack-form__unit-row">
              <label className="field">
                <span className="field__label">{tUnits(`${unitType}.name`)}</span>
                <input
                  className="field__input"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={availableCount}
                  value={counts[unitType] ?? 0}
                  onChange={(event) => handleCountChange(unitType, availableCount, event)}
                />
              </label>
              <span className="tile-sheet__available">
                {t('attack.available', { count: availableCount })}
              </span>
            </li>
          ))}
        </ul>
      )}

      {hasSiegeUnit && (
        <label className="field">
          <span className="field__label">{t('attack.siegeTargetLabel')}</span>
          <select
            className="field__input"
            value={siegeTarget ?? ''}
            onChange={handleSiegeTargetChange}
          >
            <option value="">{t('attack.siegeTargetPlaceholder')}</option>
            {BUILDING_TYPES.map((type) => (
              <option key={type} value={type}>
                {tBuildings(`${type}.name`)}
              </option>
            ))}
          </select>
        </label>
      )}

      {travelMs !== undefined && (
        <p className="tile-sheet__travel-time">
          {t('attack.travelTime', { duration: formatDuration(travelMs) })}
        </p>
      )}

      {blockReason && (
        <p className="tile-sheet__reason">{tErrors(`movement.${blockReason.kind}`)}</p>
      )}

      {sendMutation.isError && <ErrorPanel error={sendMutation.error} />}

      <button
        type="submit"
        className="button button--primary"
        disabled={blockReason !== undefined || sendMutation.isPending}
      >
        {sendMutation.isPending
          ? tCommon('actions.submitting')
          : t(`attack.submitLabel.${movementType}`)}
      </button>
    </form>
  );
}
