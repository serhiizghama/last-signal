import type { GameConfig, Resources } from '@last-signal/game-core';
import {
  calcInfluence,
  calcNetFoodPerHour,
  calcNetRates,
  calcStorageCaps,
  merchantsFromMarketLevel,
} from '@last-signal/game-core';

import type { SettlementDocument } from '../schemas/settlement.schema';
import { currentLevelOf, toBuildingLevels, upkeepTroopsOf } from './settlements.util';

// Mongoose (sub)documents are not plain objects — spreading one (`{ ...doc.resources.values }`)
// pulls in Mongoose's own internal bookkeeping properties (which circularly reference the
// connection) alongside the schema fields, and `res.json()` then throws trying to serialize
// it. Reading each named field individually (a getter access, which Mongoose documents
// support fine) and building a genuine object literal avoids that entirely.
function toPlainResources(values: Resources): Resources {
  return {
    scrap: values.scrap,
    fuel: values.fuel,
    electronics: values.electronics,
    food: values.food,
  };
}

export interface SettlementBuildingView {
  id: string;
  type: string;
  level: number;
  slot: number;
}

export interface SettlementBuildQueueItemView {
  id: string;
  type: string;
  targetLevel: number;
  cost: Resources;
  enqueuedAt: number;
  startedAt: number | null;
  completesAt: number | null;
}

export interface SettlementTroopView {
  unitType: string;
  count: number;
}

// A foreign contingent stationed here as support (M3 §3/§8) — wire shape for
// `Settlement.stationedTroops`. `ownerAccountId`/`fromSettlementId` ride as strings, same
// convention as every other id on the wire (see `accountId: String(doc.accountId)` elsewhere
// in this file's sibling views). Always `[]` today: nothing writes `stationedTroops` until
// the `support` movement ships in M3c (see that field's schema comment).
export interface SettlementStationedContingentView {
  ownerAccountId: string;
  fromSettlementId: string;
  troops: SettlementTroopView[];
}

// Wire shape for a `trainUnits` order — everything the client needs to render "next unit
// in MM:SS, N of M remaining" against `serverTime` (`totalCount - remainingCount` already
// delivered, `nextCompletesAt` the next unit's countdown target). `eventId` is deliberately
// not exposed, same as `SettlementBuildQueueItemView` omits it — it's the scheduler's own
// bookkeeping, not client-facing state.
export interface SettlementTrainingQueueItemView {
  id: string;
  unitType: string;
  totalCount: number;
  remainingCount: number;
  unitTrainTimeMs: number;
  startedAt: number;
  nextCompletesAt: number;
  cost: Resources;
}

// The client's countdowns are driven from `serverTime` + `completesAt`, run locally, and
// never trust the client's own clock — that's why `serverTime` rides along on every
// response instead of the client computing "now" itself.
export interface SettlementStateView {
  id: string;
  name: string;
  x: number;
  y: number;
  buildings: SettlementBuildingView[];
  resources: { values: Resources; lastCalcAt: number };
  // Gross hourly rates for scrap/fuel/electronics, net (production minus upkeep) for food —
  // exactly what `calcNetRates` returns; matches what `settleResources` actually applies.
  ratesPerHour: Resources;
  // Same number as `ratesPerHour.food`, surfaced explicitly since the Food gate (§4) is a
  // first-class concept the client always needs to show, not an incidental field to dig out.
  netFoodPerHour: number;
  storageCaps: Resources;
  buildQueue: SettlementBuildQueueItemView[];
  // Home troops (M2b §6/§7) — `[]` until the first `trainUnits` order completes. Only what
  // is physically at home right now — what a send command can draw from, what a scout-vs-scout
  // defence roll uses. Folded, together with `awayTroops`/`stationedTroops` below, into
  // `ratesPerHour.food`/`netFoodPerHour` via `upkeepTroopsOf`; surfaced separately too since
  // the client needs the raw counts for its own UI (unit list, scout-count for the send-scout
  // flow).
  troops: SettlementTroopView[];
  // Own units currently in transit — any movement, any leg (M3 §3). This settlement still
  // pays their Food (`upkeepTroopsOf`), which is the whole reason this list exists: see
  // `Settlement.awayTroops`'s schema comment for the exploit it closes.
  awayTroops: SettlementTroopView[];
  // Foreign contingents stationed here as support (M3 §3/§8) — this settlement (the host)
  // pays their Food too. `[]` for every settlement today; see `Settlement.stationedTroops`'s
  // schema comment.
  stationedTroops: SettlementStationedContingentView[];
  trainingQueue: SettlementTrainingQueueItemView[];
  influence: number;
  // The Market's own merchant accounting (§14, M3d.4 — the M3e Market tab's own need):
  // `merchantsTotal` is `merchantsFromMarketLevel(config, marketLevel)`, 0 with no Market
  // built (`merchantsFromMarketLevel`'s own level-0 case). `merchantsBusy` is the raw
  // `Settlement.busyMerchants` counter — see that field's schema comment for what occupies
  // it (an accepted trade leg, M3d.3, or a world-exchange trip, M3d.4). Free merchants
  // (`merchantsTotal - merchantsBusy`) is not precomputed into a third field: unlike
  // `ratesPerHour`/`netFoodPerHour` above, it is not itself a `game-core` formula, just a
  // subtraction of the two already-derived numbers below, which the client (or a future
  // command) can do itself from these two.
  merchantsTotal: number;
  merchantsBusy: number;
  serverTime: number;
}

// Pure reshape of a persisted (already-settled) settlement document into the wire view
// model. Every derived number goes through the matching game-core formula — nothing here
// is computed by hand.
export function buildSettlementStateView(
  config: GameConfig,
  doc: SettlementDocument,
  now: number,
): SettlementStateView {
  const buildings = toBuildingLevels(doc.buildings);
  // Real troops, not the `[]` default `calcNetRates`/`calcNetFoodPerHour` fall back to —
  // see those functions' own comments (`packages/game-core/src/economy/resources.ts`,
  // `formulas/buildings.ts`) on why omitting this silently understates Food upkeep. Union of
  // all three troop lists (M3a.4, §3), not `troops` alone — see `upkeepTroopsOf`'s comment.
  const troops = upkeepTroopsOf(doc);

  return {
    id: String(doc._id),
    name: doc.name,
    x: doc.x,
    y: doc.y,
    buildings: doc.buildings.map((b) => ({ id: b.id, type: b.type, level: b.level, slot: b.slot })),
    resources: {
      values: toPlainResources(doc.resources.values),
      lastCalcAt: doc.resources.lastCalcAt,
    },
    ratesPerHour: calcNetRates(config, buildings, troops),
    netFoodPerHour: calcNetFoodPerHour(config, buildings, troops),
    storageCaps: calcStorageCaps(config, buildings),
    buildQueue: doc.buildQueue.map((item) => ({
      id: item.id,
      type: item.type,
      targetLevel: item.targetLevel,
      cost: toPlainResources(item.cost),
      enqueuedAt: item.enqueuedAt,
      startedAt: item.startedAt,
      completesAt: item.completesAt,
    })),
    troops: doc.troops.map((t) => ({ unitType: t.unitType, count: t.count })),
    awayTroops: doc.awayTroops.map((t) => ({ unitType: t.unitType, count: t.count })),
    stationedTroops: doc.stationedTroops.map((contingent) => ({
      ownerAccountId: String(contingent.ownerAccountId),
      fromSettlementId: String(contingent.fromSettlementId),
      troops: contingent.troops.map((t) => ({ unitType: t.unitType, count: t.count })),
    })),
    trainingQueue: doc.trainingQueue.map((item) => ({
      id: item.id,
      unitType: item.unitType,
      totalCount: item.totalCount,
      remainingCount: item.remainingCount,
      unitTrainTimeMs: item.unitTrainTimeMs,
      startedAt: item.startedAt,
      nextCompletesAt: item.nextCompletesAt,
      cost: toPlainResources(item.cost),
    })),
    // Single-settlement Influence: M1a has no multi-settlement accounts yet (M1b), so this
    // is `calcInfluence` applied to just this settlement rather than a real cross-account sum.
    influence: calcInfluence(config, [buildings]),
    // Every derived number here goes through the matching `game-core` formula — nothing is
    // computed by hand (this view's own established convention, see this function's header
    // comment): `merchantsTotal` from `merchantsFromMarketLevel`, `merchantsBusy` straight off
    // the document (it is already a raw counter, not a derived one — see its schema comment).
    merchantsTotal: merchantsFromMarketLevel(config, currentLevelOf(buildings, 'market')),
    merchantsBusy: doc.busyMerchants,
    serverTime: now,
  };
}
