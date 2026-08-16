import type { BuildingLevels, Resources, TroopCounts } from '@last-signal/game-core';
import { DEFAULT_CONFIG, settleResources } from '@last-signal/game-core';
import { useMemo } from 'react';

import type { SettlementStateView } from '../api/types';
import { useServerClock } from '../hooks/useServerClock';
import { toBuildingLevels, toTroopCounts } from './settlementSelectors';

export interface LiveResources {
  /** Server-clock "now" (falls back to the settlement's own `serverTime` before the first tick). */
  now: number;
  buildings: BuildingLevels;
  /** Home troops, reshaped for `game-core` — see `toTroopCounts`'s comment. */
  troops: TroopCounts;
  /** Live (unfloored) resource values, advanced from the server's last snapshot to `now`. */
  values: Resources;
}

/**
 * Ticks the settlement's resources forward in real time by re-running `settleResources`
 * (the exact same pure function the server uses to materialise lazy accrual) against the
 * server's last snapshot and the server-time clock, every second — never a client-side
 * approximation, and never a poll of the server. Passes the settlement's real `troops`
 * through (M2b §7 correctness fix — see `settleResources`'s own comment on why omitting it
 * silently understates Food upkeep): a settlement with scouts at home must tick Food
 * downward at the same rate the server would compute, not a rate that ignores their upkeep.
 */
export function useLiveResources(settlement: SettlementStateView): LiveResources {
  const buildings = useMemo(() => toBuildingLevels(settlement.buildings), [settlement.buildings]);
  const troops = useMemo(() => toTroopCounts(settlement.troops), [settlement.troops]);
  const serverNow = useServerClock(settlement.serverTime);
  const now = serverNow ?? settlement.serverTime;

  const values = useMemo(
    () =>
      settleResources(
        DEFAULT_CONFIG,
        buildings,
        { values: settlement.resources.values, lastCalcAt: settlement.resources.lastCalcAt },
        now,
        troops,
      ).values,
    [buildings, troops, settlement.resources.values, settlement.resources.lastCalcAt, now],
  );

  return { now, buildings, troops, values };
}
