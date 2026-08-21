import type { ReactElement } from 'react';
import { useEffect, useRef } from 'react';
import { DEFAULT_CONFIG, isBeginnerProtected, terrainAt } from '@last-signal/game-core';
import { useTranslation } from 'react-i18next';

import type { AccountView, MapView, SettlementStateView } from '../api/types';
import { toTroopCounts } from '../base/settlementSelectors';
import { AttackForm } from './AttackForm';
import type { Tile } from './mapGeometry';
import { legalAttackTypesForTarget } from './movementLegality';
import { ScoutForm } from './ScoutForm';
import type { TileSelection } from './tileSelection';
import { classifyTile } from './tileSelection';

interface TileInfoSheetProps {
  mapView: MapView;
  account: AccountView;
  settlement: SettlementStateView;
  tile: Tile;
  /**
   * The server clock, ticking (`useServerClock(mapView.world.serverTime)` in `MapScreen`) —
   * threaded down rather than re-derived here so the sheet and `MapMarkers`' own protection
   * badge can never disagree about "now" (§11 requires beginner protection to be judged
   * against the server clock, never `Date.now()`).
   */
  serverNow: number;
  onClose: () => void;
}

/**
 * The tap-a-tile bottom info sheet (§11): a mobile-first, dismissible, keyboard-accessible
 * overlay. Closable via the explicit close button, the Escape key, or tapping the backdrop —
 * the first two work without a mouse, which is the harder of the two accessibility
 * requirements. Content branches on `classifyTile`'s four kinds, each offering exactly the
 * movement types §9's target matrix allows for that kind (`movementLegality.ts`) — an illegal
 * type is never offered at all, not merely disabled, the same convention M2c.2 already
 * established for the scout action on the caller's own settlement.
 */
export function TileInfoSheet({
  mapView,
  account,
  settlement,
  tile,
  serverNow,
  onClose,
}: TileInfoSheetProps): ReactElement {
  const { t } = useTranslation('map');
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Moves focus into the sheet on open so a keyboard/screen-reader user lands somewhere
  // meaningful, and so Escape/Tab work immediately without a prior manual focus step.
  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        onClose();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const selection = classifyTile(mapView, account.id, tile.x, tile.y);

  return (
    <div className="tile-sheet-backdrop" onClick={onClose}>
      <div
        className="tile-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t('sheet.title')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="tile-sheet__header">
          <span className="tile-sheet__coordinates">
            {t('sheet.coordinates', { x: tile.x, y: tile.y })}
          </span>
          <button
            type="button"
            ref={closeButtonRef}
            className="button tile-sheet__close"
            onClick={onClose}
            aria-label={t('sheet.close')}
          >
            {t('sheet.close')}
          </button>
        </div>

        <TileSheetBody
          selection={selection}
          seed={mapView.world.seed}
          account={account}
          settlement={settlement}
          serverNow={serverNow}
          onActionSent={onClose}
        />
      </div>
    </div>
  );
}

interface TileSheetBodyProps {
  selection: TileSelection;
  seed: string;
  account: AccountView;
  settlement: SettlementStateView;
  serverNow: number;
  onActionSent: () => void;
}

function TileSheetBody({
  selection,
  seed,
  account,
  settlement,
  serverNow,
  onActionSent,
}: TileSheetBodyProps): ReactElement {
  const { t } = useTranslation('map');
  const { t: tCommon } = useTranslation();

  if (selection.kind === 'empty') {
    const terrain = terrainAt(DEFAULT_CONFIG, seed, selection.x, selection.y);
    return (
      <div className="tile-sheet__body">
        <h3 className="screen__subtitle">{t('sheet.emptyTitle')}</h3>
        <p className="tile-sheet__row">
          {t('sheet.terrainLabel', { terrain: t(`terrain.${terrain}`) })}
        </p>
      </div>
    );
  }

  if (selection.kind === 'oasis') {
    // §10: an oasis has no owning account, so it has no notion of beginner protection at all
    // — every form below is passed `isProtected={false}` unconditionally, never derived.
    const allowedTypes = legalAttackTypesForTarget(selection, settlement.id);
    const origin = { x: settlement.x, y: settlement.y };
    const oasisTarget = { x: selection.x, y: selection.y };
    return (
      <div className="tile-sheet__body">
        <h3 className="screen__subtitle">{t('sheet.oasisTitle')}</h3>
        <p className="tile-sheet__row">{t(`sheet.oasisType.${selection.oasis.type}`)}</p>
        {account.faction && (
          <>
            {/* §10 lifts M2 §8's "oases aren't scoutable" deferral — a report now shows the
                defender composition and Food pool. */}
            <ScoutForm
              fromSettlementId={settlement.id}
              origin={origin}
              target={oasisTarget}
              faction={account.faction}
              troops={toTroopCounts(settlement.troops)}
              isProtected={false}
              onSent={onActionSent}
            />
            <AttackForm
              fromSettlementId={settlement.id}
              origin={origin}
              target={oasisTarget}
              troops={toTroopCounts(settlement.troops)}
              allowedTypes={allowedTypes}
              isProtected={false}
              onSent={onActionSent}
            />
          </>
        )}
      </div>
    );
  }

  const { settlement: mapSettlement, isOwn } = selection;
  // §11: beginner protection never gates a movement at your own settlement (the server skips
  // the check entirely whenever the target is the caller's own — see
  // `MovementsService.sendMovement`'s own comment on why) — so this is deliberately computed
  // as `false` for `isOwn`, not derived from `mapSettlement.protectedUntil`, which could
  // still be present on your own freshly-founded settlement.
  const isProtected = !isOwn && isBeginnerProtected(mapSettlement.protectedUntil, serverNow);
  const allowedTypes = legalAttackTypesForTarget(selection, settlement.id);
  const origin = { x: settlement.x, y: settlement.y };
  const settlementTarget = { x: selection.x, y: selection.y };

  return (
    <div className="tile-sheet__body">
      <h3 className="screen__subtitle">{mapSettlement.name}</h3>
      <p className="tile-sheet__row">
        {t('sheet.settlementOwner', { owner: mapSettlement.ownerName })}
      </p>
      {mapSettlement.ownerFaction && (
        <p className="tile-sheet__row">{tCommon(`factions.${mapSettlement.ownerFaction}.name`)}</p>
      )}
      {mapSettlement.ownerSide && (
        <p className="tile-sheet__row">{tCommon(`sides.${mapSettlement.ownerSide}`)}</p>
      )}

      {isProtected && (
        <p className="tile-sheet__row tile-sheet__badge--protected">{t('sheet.protectedBadge')}</p>
      )}

      {isOwn ? (
        allowedTypes.length > 0 ? (
          // §8: another of your own settlements — support only, never raid/assault/scout.
          account.faction && (
            <AttackForm
              fromSettlementId={settlement.id}
              origin={origin}
              target={settlementTarget}
              troops={toTroopCounts(settlement.troops)}
              allowedTypes={allowedTypes}
              isProtected={false}
              onSent={onActionSent}
            />
          )
        ) : (
          // The literal settlement the army would depart from (M3c.6) — nothing to send here.
          <p className="tile-sheet__note">{t('sheet.ownSettlementNote')}</p>
        )
      ) : (
        account.faction && (
          <>
            <ScoutForm
              fromSettlementId={settlement.id}
              origin={origin}
              target={settlementTarget}
              faction={account.faction}
              troops={toTroopCounts(settlement.troops)}
              isProtected={isProtected}
              onSent={onActionSent}
            />
            <AttackForm
              fromSettlementId={settlement.id}
              origin={origin}
              target={settlementTarget}
              troops={toTroopCounts(settlement.troops)}
              allowedTypes={allowedTypes}
              isProtected={isProtected}
              onSent={onActionSent}
            />
          </>
        )
      )}
    </div>
  );
}
