import type { ReactElement } from 'react';
import { useEffect, useRef } from 'react';
import { DEFAULT_CONFIG, terrainAt } from '@last-signal/game-core';
import { useTranslation } from 'react-i18next';

import type { AccountView, MapView, SettlementStateView } from '../api/types';
import { toTroopCounts } from '../base/settlementSelectors';
import type { Tile } from './mapGeometry';
import { ScoutForm } from './ScoutForm';
import type { TileSelection } from './tileSelection';
import { classifyTile } from './tileSelection';

interface TileInfoSheetProps {
  mapView: MapView;
  account: AccountView;
  settlement: SettlementStateView;
  tile: Tile;
  onClose: () => void;
}

/**
 * The tap-a-tile bottom info sheet (§11): a mobile-first, dismissible, keyboard-accessible
 * overlay. Closable via the explicit close button, the Escape key, or tapping the backdrop —
 * the first two work without a mouse, which is the harder of the two accessibility
 * requirements. Content branches on `classifyTile`'s four kinds; only "another player's
 * settlement" ever renders the scout action (`ScoutForm`) — oases and the caller's own
 * settlement never offer it at all, per the design record, not merely disable it.
 */
export function TileInfoSheet({
  mapView,
  account,
  settlement,
  tile,
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
          onScoutSent={onClose}
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
  onScoutSent: () => void;
}

function TileSheetBody({
  selection,
  seed,
  account,
  settlement,
  onScoutSent,
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
    return (
      <div className="tile-sheet__body">
        <h3 className="screen__subtitle">{t('sheet.oasisTitle')}</h3>
        <p className="tile-sheet__row">{t(`sheet.oasisType.${selection.oasis.type}`)}</p>
        <p className="tile-sheet__note">{t('sheet.oasisNoScout')}</p>
      </div>
    );
  }

  const { settlement: mapSettlement, isOwn } = selection;

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

      {isOwn ? (
        <p className="tile-sheet__note">{t('sheet.ownSettlementNote')}</p>
      ) : (
        account.faction && (
          <ScoutForm
            fromSettlementId={settlement.id}
            origin={{ x: settlement.x, y: settlement.y }}
            target={{ x: selection.x, y: selection.y }}
            faction={account.faction}
            troops={toTroopCounts(settlement.troops)}
            onSent={onScoutSent}
          />
        )
      )}
    </div>
  );
}
