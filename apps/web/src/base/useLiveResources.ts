import type { BuildingLevels, Resources, TroopCounts } from '@last-signal/game-core';
import { DEFAULT_CONFIG, settleResources } from '@last-signal/game-core';
import { useMemo } from 'react';

import type { SettlementStateView } from '../api/types';
import { useServerClock } from '../hooks/useServerClock';
import { toBuildingLevels, upkeepTroopsOf } from './settlementSelectors';

export interface LiveResources {
  /** Server-clock "now" (falls back to the settlement's own `serverTime` before the first tick). */
  now: number;
  buildings: BuildingLevels;
  /** Union of home/away/stationed troops, reshaped for `game-core` — see `upkeepTroopsOf`'s comment. */
  troops: TroopCounts;
  /** Live (unfloored) resource values, advanced from the server's last snapshot to `now`. */
  values: Resources;
}

/**
 * Ticks the settlement's resources forward in real time by re-running `settleResources`
 * (the exact same pure function the server uses to materialise lazy accrual) against the
 * server's last snapshot and the server-time clock, every second — never a client-side
 * approximation, and never a poll of the server. Passes the settlement's full upkeep troop
 * union through (`upkeepTroopsOf`, M3 §3 — was `toTroopCounts(settlement.troops)`, home only,
 * before M3a.4): a settlement with an army marching away or hosting a guest contingent must
 * tick Food at the same rate the server would compute, which is charged on `troops` +
 * `awayTroops` + `stationedTroops`, not `troops` alone. Passing only home troops here would
 * make the live resource bar visibly disagree with the server the moment any army left home.
 */
export function useLiveResources(settlement: SettlementStateView): LiveResources {
  const buildings = useMemo(() => toBuildingLevels(settlement.buildings), [settlement.buildings]);
  const troops = useMemo(
    () => upkeepTroopsOf(settlement),
    [settlement.troops, settlement.awayTroops, settlement.stationedTroops],
  );
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
