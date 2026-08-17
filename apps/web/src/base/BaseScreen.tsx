import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

import type { AccountView, SettlementStateView } from '../api/types';
import type { NavTab } from './BottomNav';
import { BottomNav } from './BottomNav';
import { BuildQueueList } from './BuildQueueList';
import { BuildingList } from './BuildingList';
import { InfluencePanel } from './InfluencePanel';
import { ResourceBar } from './ResourceBar';
import { useLiveResources } from './useLiveResources';

interface BaseScreenProps {
  settlement: SettlementStateView;
  account: AccountView;
  onNavigateTab: (tab: NavTab) => void;
}

/**
 * The real base screen (replaces the M1c.1 placeholder): live resources, the building list
 * with build actions, the build queue with countdowns, and the bottom nav shell. A player
 * can grow their settlement end to end from here.
 */
export function BaseScreen({ settlement, account, onNavigateTab }: BaseScreenProps): ReactElement {
  const { t } = useTranslation();
  const live = useLiveResources(settlement);

  return (
    <div className="base-screen">
      <header className="panel screen">
        <h2 className="screen__title">{settlement.name}</h2>
        <p className="screen__description">
          {t('base.coordinates', { x: settlement.x, y: settlement.y })}
          {account.faction && <> · {t(`factions.${account.faction}.name`)}</>}
        </p>
      </header>

      <ResourceBar settlement={settlement} live={live} />

      <InfluencePanel influence={settlement.influence} />

      <BuildQueueList settlement={settlement} />

      <BuildingList settlement={settlement} live={live} account={account} />

      <BottomNav active="base" onNavigate={onNavigateTab} />
    </div>
  );
}
