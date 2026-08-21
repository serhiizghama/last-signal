import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

import type { AccountView, SettlementStateView } from '../api/types';
import type { NavTab } from '../base/BottomNav';
import { BottomNav } from '../base/BottomNav';
import { useLiveResources } from '../base/useLiveResources';
import { ArmyOverview } from './ArmyOverview';
import { TrainingBuildingCard } from './TrainingBuildingCard';

interface UnitsScreenProps {
  settlement: SettlementStateView;
  account: AccountView;
  onNavigateTab: (tab: NavTab) => void;
}

/**
 * The Units tab (M3e.2, §17): "the faction roster with stats, training from the Barracks /
 * Machine Shop / Command Center cards, live queue countdowns reusing M1c's patterns, and an
 * army overview showing home / away / stationed with each group's Food cost — the visible
 * answer to §3." Every number here comes from `@last-signal/game-core` against this
 * settlement's own state — nothing is hardcoded, and nothing here duplicates a formula the
 * Base screen (`BaseScreen`/`BuildingList`/`TrainingSection`) already owns; this screen only
 * arranges the same building-level view (`useLiveResources`) into the three training-building
 * cards §17 calls for.
 */
export function UnitsScreen({
  settlement,
  account,
  onNavigateTab,
}: UnitsScreenProps): ReactElement {
  const { t } = useTranslation('military');
  const live = useLiveResources(settlement);

  return (
    <div className="units-screen">
      <header className="panel screen">
        <h2 className="screen__title">{t('screen.title')}</h2>
      </header>

      <ArmyOverview settlement={settlement} />

      <TrainingBuildingCard
        building="barracks"
        settlement={settlement}
        live={live}
        account={account}
      />
      <TrainingBuildingCard
        building="machineShop"
        settlement={settlement}
        live={live}
        account={account}
      />
      <TrainingBuildingCard
        building="commandCenter"
        settlement={settlement}
        live={live}
        account={account}
      />

      <BottomNav active="units" onNavigate={onNavigateTab} />
    </div>
  );
}
