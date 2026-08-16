import type { ReactElement } from 'react';
import type { BuildingType } from '@last-signal/game-core';
import { BUILDING_TYPES, DEFAULT_CONFIG, formatDuration } from '@last-signal/game-core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { startBuild } from '../api/endpoints';
import type { SettlementStateView } from '../api/types';
import { ErrorPanel } from '../components/StatusPanels';
import type { BuildBlockReason, BuildEligibility } from './buildEligibility';
import { computeBuildEligibility } from './buildEligibility';
import { updateSettlementCache } from './settlementCache';
import type { LiveResources } from './useLiveResources';

interface BuildingListProps {
  settlement: SettlementStateView;
  live: LiveResources;
}

function useBlockReasonText(block: BuildBlockReason | undefined): string | undefined {
  const { t: tErrors } = useTranslation('errors');
  const { t } = useTranslation();
  if (!block) {
    return undefined;
  }
  switch (block.kind) {
    case 'maxLevel':
      return tErrors('build.maxLevelReached');
    case 'queueFull':
      return tErrors('build.queueFull');
    case 'wouldStarve':
      return tErrors('build.wouldStarve');
    case 'exceedsStorage':
      return tErrors('build.exceedsStorage');
    case 'neverAffordable':
      return tErrors('build.insufficientResources');
    case 'prerequisites':
      return tErrors('build.prerequisitesNotMet');
    case 'waiting':
      return t('base.availableIn', { duration: formatDuration(block.waitMs) });
  }
}

interface CostListProps {
  cost: BuildEligibility['cost'];
}

function CostList({ cost }: CostListProps): ReactElement {
  const { t: tResources } = useTranslation('resources');
  const entries = Object.entries(cost).filter(([, amount]) => amount > 0);
  return (
    <ul className="building-card__cost">
      {entries.map(([kind, amount]) => (
        <li key={kind}>
          {tResources(kind as keyof typeof cost)} {amount.toLocaleString('ru-RU')}
        </li>
      ))}
    </ul>
  );
}

interface BuildingCardProps {
  type: BuildingType;
  eligibility: BuildEligibility;
  onBuild: (type: BuildingType) => void;
  isSubmitting: boolean;
}

function BuildingCard({
  type,
  eligibility,
  onBuild,
  isSubmitting,
}: BuildingCardProps): ReactElement {
  const { t } = useTranslation();
  const { t: tBuildings } = useTranslation('buildings');
  const block = eligibility.block;
  const reasonText = useBlockReasonText(block);
  const disabled = !eligibility.canStart || isSubmitting;

  return (
    <li className="building-card">
      <div className="building-card__header">
        <span className="building-card__name">{tBuildings(`${type}.name`)}</span>
        <span className="building-card__level">
          {eligibility.currentLevel > 0
            ? t('base.level', { level: eligibility.currentLevel })
            : t('base.notBuilt')}
        </span>
      </div>

      {!eligibility.atMaxLevel && (
        <div className="building-card__next">
          <span>{t('base.nextLevel', { level: eligibility.targetLevel })}</span>
          <CostList cost={eligibility.cost} />
          {eligibility.canStart && (
            <span className="building-card__time">
              {t('base.buildTime', { duration: formatDuration(eligibility.buildTimeMs) })}
            </span>
          )}
        </div>
      )}

      <button
        type="button"
        className="button button--primary"
        disabled={disabled}
        onClick={() => onBuild(type)}
      >
        {isSubmitting
          ? t('actions.submitting')
          : eligibility.currentLevel > 0
            ? t('base.upgrade')
            : t('base.build')}
      </button>

      {block?.kind === 'prerequisites' && (
        <ul className="building-card__missing">
          {block.missing.map((req) => (
            <li key={req.type}>
              {t('base.missingPrerequisiteItem', {
                name: tBuildings(`${req.type}.name`),
                level: req.level,
              })}
            </li>
          ))}
        </ul>
      )}

      {reasonText && <p className="building-card__reason">{reasonText}</p>}
    </li>
  );
}

/**
 * All 13 building types, each showing its current level, next-level cost/time (both from
 * `game-core`), and a build action disabled with a translated reason wherever
 * `computeBuildEligibility` finds one.
 */
export function BuildingList({ settlement, live }: BuildingListProps): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const startMutation = useMutation({
    mutationFn: (type: BuildingType) => startBuild(settlement.id, type),
    onSuccess: (updated) => updateSettlementCache(queryClient, updated),
  });

  return (
    <section className="panel building-list-section">
      <h3 className="screen__subtitle">
        {t('base.buildingsTitle')} ·{' '}
        {t('base.buildingsCount', { count: settlement.buildings.length })}
      </h3>

      {startMutation.isError && <ErrorPanel error={startMutation.error} />}

      <ul className="building-list">
        {BUILDING_TYPES.map((type) => {
          const eligibility = computeBuildEligibility(
            DEFAULT_CONFIG,
            live.buildings,
            settlement.buildQueue,
            live.values,
            live.now,
            type,
            live.troops,
          );
          return (
            <BuildingCard
              key={type}
              type={type}
              eligibility={eligibility}
              onBuild={(t2) => startMutation.mutate(t2)}
              isSubmitting={startMutation.isPending && startMutation.variables === type}
            />
          );
        })}
      </ul>
    </section>
  );
}
