import type { ReactElement } from 'react';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { ApiError } from '../api/client';
import { fetchMe, fetchMySettlements } from '../api/endpoints';
import type { AccountView } from '../api/types';
import { BaseScreen } from '../base/BaseScreen';
import type { NavTab } from '../base/BottomNav';
import { SETTLEMENTS_MINE_KEY } from '../base/settlementCache';
import { ErrorPanel, LoadingPanel } from '../components/StatusPanels';
import { MapScreen } from '../map/MapScreen';
import { useReportsRealtime } from '../realtime/useReportsRealtime';
import { ReportsScreen } from '../reports/ReportsScreen';
import { CreateSettlementScreen } from './CreateSettlementScreen';
import { RegisterScreen } from './RegisterScreen';
import { WelcomeScreen } from './WelcomeScreen';

const NOT_AUTHENTICATED_KEY = 'errors.auth.notAuthenticated';

/**
 * The onboarding state machine: guest login -> register with a faction -> create a
 * settlement -> placeholder base screen. Each step is driven by what the server actually
 * knows about the account (never local-only state), so a returning player lands on the
 * right screen even after a refresh.
 */
export function Onboarding(): ReactElement {
  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: ({ signal }) => fetchMe(signal),
  });

  if (meQuery.isPending) {
    return <LoadingPanel />;
  }

  if (meQuery.isError) {
    if (meQuery.error instanceof ApiError && meQuery.error.key === NOT_AUTHENTICATED_KEY) {
      return <WelcomeScreen />;
    }
    return <ErrorPanel error={meQuery.error} onRetry={() => void meQuery.refetch()} />;
  }

  if (!meQuery.data.faction) {
    return <RegisterScreen />;
  }

  return <SettlementGate account={meQuery.data} />;
}

interface SettlementGateProps {
  account: AccountView;
}

function SettlementGate({ account }: SettlementGateProps): ReactElement {
  const settlementsQuery = useQuery({
    queryKey: SETTLEMENTS_MINE_KEY,
    queryFn: ({ signal }) => fetchMySettlements(signal),
  });
  // Screen switching without a router (M2c.1): the app is a single mobile-first shell, so the
  // active bottom-nav tab is just local state lifted to the one place that hosts every screen
  // able to show it, not URL state.
  const [activeTab, setActiveTab] = useState<NavTab>('base');

  // Mounted once per authenticated session, unconditionally (before the early returns below,
  // per the Rules of Hooks) — `SettlementGate` itself never remounts when `activeTab` changes,
  // only its returned screen does, so the shared socket subscription persists across tab
  // switches instead of churning on every click (M2c.3, see that hook's own comment).
  useReportsRealtime();

  if (settlementsQuery.isPending) {
    return <LoadingPanel />;
  }

  if (settlementsQuery.isError) {
    return (
      <ErrorPanel error={settlementsQuery.error} onRetry={() => void settlementsQuery.refetch()} />
    );
  }

  const firstSettlement = settlementsQuery.data[0];
  if (!firstSettlement) {
    return <CreateSettlementScreen />;
  }

  if (activeTab === 'map') {
    return (
      <MapScreen account={account} settlement={firstSettlement} onNavigateTab={setActiveTab} />
    );
  }

  if (activeTab === 'reports') {
    return <ReportsScreen onNavigateTab={setActiveTab} />;
  }

  return <BaseScreen settlement={firstSettlement} account={account} onNavigateTab={setActiveTab} />;
}
