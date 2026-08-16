import type { BuildingType, Resources } from '@last-signal/game-core';

/**
 * Mirrors the server's `Faction`/`Side` literal unions (see
 * `apps/server/src/schemas/account.schema.ts`). Defined locally rather than imported: the
 * web app must not depend on server code (same rationale as `HealthResponse` in
 * `useHealth.ts`).
 */
export type Faction = 'raiders' | 'engineers' | 'nomads';
export type Side = 'beacon' | 'silence';

export const FACTIONS: readonly Faction[] = ['raiders', 'engineers', 'nomads'];

/** Wire shape returned by `POST /api/auth/guest`, `GET /api/auth/me`, `POST /api/accounts/register`. */
export interface AccountView {
  id: string;
  name: string;
  isGuest: boolean;
  faction?: Faction;
  side?: Side;
  contribution: number;
  medals: string[];
  createdAt: number;
}

export interface RegisterInput {
  name: string;
  faction: Faction;
  side?: Side;
}

export interface SettlementBuildingView {
  id: string;
  type: BuildingType;
  level: number;
  slot: number;
}

export interface SettlementBuildQueueItemView {
  id: string;
  type: BuildingType;
  targetLevel: number;
  cost: Resources;
  enqueuedAt: number;
  startedAt: number | null;
  completesAt: number | null;
}

/**
 * Mirrors `SettlementStateView` in `apps/server/src/settlements/settlements.view.ts`.
 * `serverTime` rides along on every response so client countdowns anchor on the server's
 * clock (see `useServerClock`), never the browser's wall clock.
 */
export interface SettlementStateView {
  id: string;
  name: string;
  x: number;
  y: number;
  buildings: SettlementBuildingView[];
  resources: { values: Resources; lastCalcAt: number };
  ratesPerHour: Resources;
  netFoodPerHour: number;
  storageCaps: Resources;
  buildQueue: SettlementBuildQueueItemView[];
  influence: number;
  serverTime: number;
}
