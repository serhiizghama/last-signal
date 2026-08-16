import type { ReactElement } from 'react';
import type { ResourceKind } from '@last-signal/game-core';
import {
  DEFAULT_CONFIG,
  RESOURCE_KINDS,
  floorForDisplay,
  formatDuration,
  msUntilFull,
} from '@last-signal/game-core';
import { useTranslation } from 'react-i18next';

import type { SettlementStateView } from '../api/types';
import type { LiveResources } from './useLiveResources';

interface ResourceBarProps {
  settlement: SettlementStateView;
  live: LiveResources;
}

const RU_LOCALE = 'ru-RU';

function formatAmount(value: number): string {
  return value.toLocaleString(RU_LOCALE);
}

function formatRate(rate: number): string {
  const rounded = Math.round(rate);
  return rounded >= 0 ? `+${formatAmount(rounded)}` : formatAmount(rounded);
}

interface ResourceTileProps {
  kind: ResourceKind;
  settlement: SettlementStateView;
  live: LiveResources;
}

function ResourceTile({ kind, settlement, live }: ResourceTileProps): ReactElement {
  const { t } = useTranslation();
  const { t: tResources } = useTranslation('resources');

  const rawValue = live.values[kind];
  const cap = settlement.storageCaps[kind];
  const rate = settlement.ratesPerHour[kind];
  const isFull = rawValue >= cap;
  const isFoodDeficit = kind === 'food' && settlement.netFoodPerHour < 0;
  const fullInMs = isFull
    ? null
    : msUntilFull(
        DEFAULT_CONFIG,
        live.buildings,
        { values: live.values, lastCalcAt: live.now },
        kind,
      );

  const modifiers = [isFull && 'resource-tile--full', isFoodDeficit && 'resource-tile--warning']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={`resource-tile${modifiers ? ` ${modifiers}` : ''}`}>
      <div className="resource-tile__row">
        <span className="resource-tile__icon" data-resource={kind} aria-hidden="true" />
        <span className="resource-tile__name">{tResources(kind)}</span>
      </div>
      <div className="resource-tile__row">
        <span className="resource-tile__value">{formatAmount(floorForDisplay(rawValue))}</span>
        <span className="resource-tile__cap">/ {formatAmount(cap)}</span>
      </div>
      <span className="resource-tile__rate">{t('base.perHour', { rate: formatRate(rate) })}</span>
      {isFull && <span className="resource-tile__badge">{t('base.full')}</span>}
      {!isFull && fullInMs !== null && (
        <span className="resource-tile__hint">
          {t('base.fullIn', { duration: formatDuration(fullInMs) })}
        </span>
      )}
      {isFoodDeficit && (
        <span className="resource-tile__badge resource-tile__badge--danger">
          {t('base.foodDeficit')}
        </span>
      )}
    </div>
  );
}

/**
 * The four resources, ticking upward in real time (see `useLiveResources`). Storage caps and
 * per-hour rates come straight from the server's view (`calcStorageCaps` / `calcNetRates`
 * results) — only the live value itself is re-derived client-side.
 */
export function ResourceBar({ settlement, live }: ResourceBarProps): ReactElement {
  const { t } = useTranslation();

  return (
    <section className="resource-bar panel" aria-label={t('base.resourcesTitle')}>
      {RESOURCE_KINDS.map((kind) => (
        <ResourceTile key={kind} kind={kind} settlement={settlement} live={live} />
      ))}
    </section>
  );
}
