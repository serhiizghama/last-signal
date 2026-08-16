import type { GameConfig, Resources } from '@last-signal/game-core';
import {
  calcInfluence,
  calcNetFoodPerHour,
  calcNetRates,
  calcStorageCaps,
} from '@last-signal/game-core';

import type { SettlementDocument } from '../schemas/settlement.schema';
import { toBuildingLevels } from './settlements.util';

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
  influence: number;
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
    ratesPerHour: calcNetRates(config, buildings),
    netFoodPerHour: calcNetFoodPerHour(config, buildings),
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
    // Single-settlement Influence: M1a has no multi-settlement accounts yet (M1b), so this
    // is `calcInfluence` applied to just this settlement rather than a real cross-account sum.
    influence: calcInfluence(config, [buildings]),
    serverTime: now,
  };
}
