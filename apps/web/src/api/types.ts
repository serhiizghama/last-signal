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

export interface SettlementTroopView {
  unitType: string;
  count: number;
}

/** Mirrors `SettlementStationedContingentView` in `apps/server/src/settlements/settlements.view.ts`. */
export interface SettlementStationedContingentView {
  ownerAccountId: string;
  fromSettlementId: string;
  troops: SettlementTroopView[];
}

/** Mirrors `SettlementTrainingQueueItemView` in `apps/server/src/settlements/settlements.view.ts`. */
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
  /** Home troops only — what's physically at this settlement right now. */
  troops: SettlementTroopView[];
  /** Own units currently in transit (any movement, any leg) — still eats this settlement's Food. */
  awayTroops: SettlementTroopView[];
  /** Foreign contingents stationed here as support — this settlement (the host) pays their Food too. */
  stationedTroops: SettlementStationedContingentView[];
  trainingQueue: SettlementTrainingQueueItemView[];
  influence: number;
  serverTime: number;
}

/** The one oasis type that exists so far (M2 §2: "no tiers in v1, Food-flavoured only"). */
export type OasisType = 'farm';

/** Mirrors `MapWorldView` in `apps/server/src/map/map.view.ts`. */
export interface MapWorldView {
  seed: string;
  roundNumber: number;
  act: number;
  serverTime: number;
}

/** Mirrors `MapSettlementView` in `apps/server/src/map/map.view.ts` — public fields only (§5). */
export interface MapSettlementView {
  id: string;
  x: number;
  y: number;
  name: string;
  ownerAccountId: string;
  ownerName: string;
  ownerFaction?: Faction;
  ownerSide?: Side;
}

/** Mirrors `MapOasisView` in `apps/server/src/map/map.view.ts`. Terrain never appears here — the client derives it from `world.seed` via `terrainAt`. */
export interface MapOasisView {
  x: number;
  y: number;
  type: OasisType;
}

/** Mirrors `MapView` in `apps/server/src/map/map.view.ts` — the full `GET /api/map` response. */
export interface MapView {
  world: MapWorldView;
  settlements: MapSettlementView[];
  oases: MapOasisView[];
}

/**
 * Mirrors `UnitCountEntry` in `apps/server/src/movements/movements.util.ts`. `unitType` stays
 * a plain `string` on the wire (same rationale as `SettlementTroopView`) — callers that need
 * the `game-core` `UnitType` union cast it, exactly like `settlementSelectors.ts`'s
 * `toTroopCounts` does for `SettlementTroopView`.
 */
export interface MovementUnitEntry {
  unitType: string;
  count: number;
}

/** Mirrors `MovementStatus` in `apps/server/src/schemas/movement.schema.ts`. */
export type MovementStatus = 'outbound' | 'returning' | 'done' | 'cancelled';

/**
 * Mirrors `MovementView` in `apps/server/src/movements/movements.view.ts`. `serverTime` rides
 * along on every response, same convention as `SettlementStateView` — client countdowns
 * (`useServerClock`) anchor on it, never the browser's own clock.
 */
export interface MovementView {
  id: string;
  type: string;
  fromSettlementId: string;
  toSettlementId: string;
  target: { x: number; y: number };
  units: MovementUnitEntry[];
  survivors: MovementUnitEntry[];
  departAt: number;
  arriveAt: number;
  returnAt: number | null;
  status: MovementStatus;
  serverTime: number;
}

/** Mirrors `SendScoutsDto` — the body `POST /api/movements` expects (§6). M2 ships exactly one movement type. */
export interface SendScoutsInput {
  type: 'scout';
  fromSettlementId: string;
  target: { x: number; y: number };
  units: MovementUnitEntry[];
}

/** Mirrors `ReportType` in `apps/server/src/schemas/report.schema.ts`. */
export type ReportType = 'scout' | 'scoutFailed' | 'scoutDetected';

/**
 * Mirrors `ReportView` in `apps/server/src/reports/reports.view.ts`. `payload` stays a loose
 * bag of ids/numbers on the wire, exactly as the server ships it (§8/M1 §15: "the server ships
 * keys/ids, the client renders prose") — `reports/reportPayload.ts` narrows it per `type` for
 * rendering.
 */
export interface ReportView {
  id: string;
  type: ReportType;
  read: boolean;
  createdAt: number;
  payload: Record<string, unknown>;
  serverTime: number;
}

/** Mirrors `ReportsPageView` in `apps/server/src/reports/reports.view.ts` — the `GET /api/reports` response. */
export interface ReportsPageView {
  reports: ReportView[];
  nextCursor: string | null;
  unreadCount: number;
  serverTime: number;
}
