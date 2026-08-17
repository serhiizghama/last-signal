import type { ReactElement } from 'react';
import { DEFAULT_CONFIG, settlementsAllowed } from '@last-signal/game-core';
import { useTranslation } from 'react-i18next';

interface InfluencePanelProps {
  /** `SettlementStateView.influence` — already `calcInfluence`'d server-side (M1). */
  influence: number;
}

/**
 * Display-only (§9): current Influence and progress toward the next settlement threshold,
 * phrased as the record puts it — "X of Y — founding unlocks at Y". The gate itself stays
 * enforced server-side; there is deliberately no founding affordance here (the settler convoy
 * action is M3, §6/§14). `settlementsAllowed`/`config.influence.settlementThresholds` are the
 * same `game-core` functions the server uses to enforce the real gate.
 */
export function InfluencePanel({ influence }: InfluencePanelProps): ReactElement {
  const { t } = useTranslation();
  const allowed = settlementsAllowed(DEFAULT_CONFIG, influence);
  const atCap = allowed >= DEFAULT_CONFIG.influence.maxSettlements;
  const nextThreshold = DEFAULT_CONFIG.influence.settlementThresholds.find(
    (threshold) => influence < threshold,
  );

  return (
    <section className="panel influence-panel" aria-label={t('base.influenceTitle')}>
      <h3 className="screen__subtitle">{t('base.influenceTitle')}</h3>
      {atCap || nextThreshold === undefined ? (
        <p className="influence-panel__progress">
          {t('base.influenceCapped', { value: influence })}
        </p>
      ) : (
        <p className="influence-panel__progress">
          {t('base.influenceProgress', { current: influence, threshold: nextThreshold })}
        </p>
      )}
    </section>
  );
}
