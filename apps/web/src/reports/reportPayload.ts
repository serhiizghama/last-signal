import type { BuildingLevels, Resources } from '@last-signal/game-core';

import type { MovementUnitEntry } from '../api/types';

/**
 * Mirrors `ScoutingIntel` (`packages/game-core/src/scouting/resolve.ts`) as it appears on the
 * wire inside a `scout`/`scoutFailed` report's `payload.intel` — written verbatim by
 * `MovementArriveHandler.handle` (`apps/server/src/movements/handlers/movement-arrive.handler.ts`).
 * `'none'` never actually reaches `ScoutReportBody` (a `scout` report only exists when at
 * least one intel tier was granted — `intel.tier === 'none'` is exactly what makes the server
 * write a `scoutFailed` report instead), but is included here anyway so this type mirrors the
 * server's own union completely rather than silently narrowing it.
 */
export type ScoutIntelPayload =
  | { tier: 'none' }
  | { tier: 'base'; resources: Resources; storageCaps: Resources; troops: MovementUnitEntry[] }
  | {
      tier: 'buildings';
      resources: Resources;
      storageCaps: Resources;
      troops: MovementUnitEntry[];
      buildings: BuildingLevels;
    };

/**
 * `payload` shape for a `scout` report and the combat-caused `scoutFailed` variant
 * (`reason: 'allScoutsDead'`) — both written by `MovementArriveHandler.handle`. `reason` is
 * only ever present when `intel.tier === 'none'` (see that handler's own comment on why the
 * report `type` is derived from the exact same condition).
 */
export interface ScoutCombatPayload {
  movementId: string;
  fromSettlementId: string;
  toSettlementId: string;
  target: { x: number; y: number };
  atkPts: number;
  defPts: number;
  lossFraction: number;
  losses: MovementUnitEntry[];
  survivors: MovementUnitEntry[];
  intel: ScoutIntelPayload;
  reason?: 'allScoutsDead';
}

/**
 * `payload` shape for the M2-defensive `scoutFailed` variant (`reason: 'targetNotFound'`) —
 * written by `MovementArriveHandler.resolveMissingTarget`. Deliberately carries none of
 * `ScoutCombatPayload`'s combat/intel fields: nobody fought, so there is nothing to report
 * beyond where the scouts were headed.
 */
export interface ScoutTargetNotFoundPayload {
  movementId: string;
  fromSettlementId: string;
  target: { x: number; y: number };
  reason: 'targetNotFound';
}

export type ScoutFailedPayload = ScoutCombatPayload | ScoutTargetNotFoundPayload;

export function isTargetNotFoundPayload(
  payload: ScoutFailedPayload,
): payload is ScoutTargetNotFoundPayload {
  return payload.reason === 'targetNotFound';
}

/**
 * `payload` shape for a `scoutDetected` counter-report — written by `MovementArriveHandler`'s
 * defender branch. Names the attacker's settlement/account by id only, nothing about what
 * intel they gathered (§8) — `ScoutDetectedReportBody` resolves the ids into a name via the
 * public map data.
 */
export interface ScoutDetectedPayload {
  movementId: string;
  attackerSettlementId: string;
  attackerAccountId: string;
  at: number;
}

/**
 * The `{x, y}` target of a `scout`/`scoutFailed` report's payload, for the list row preview —
 * `scoutDetected` never carries one (§8: it names the attacker, not a location), so callers
 * get `undefined` rather than a bad cast. Reads defensively off the loose wire `payload`
 * rather than assuming a specific report type, since the list renders all three uniformly.
 */
export function reportTargetFromPayload(
  payload: Record<string, unknown>,
): { x: number; y: number } | undefined {
  const target = payload['target'];
  if (
    typeof target === 'object' &&
    target !== null &&
    typeof (target as { x: unknown }).x === 'number' &&
    typeof (target as { y: unknown }).y === 'number'
  ) {
    return target as { x: number; y: number };
  }
  return undefined;
}

/**
 * Sums duplicate `unitType` entries across one or more unit lists, e.g. a report's `losses`
 * and `survivors` combined back into "what was sent". A small local copy rather than an
 * import from the server — same "one small helper, not a cross-module dependency" convention
 * `apps/server/src/movements/movements.util.ts`'s own `mergeUnitCounts` comment describes (and
 * the web app cannot import server code at all regardless).
 */
export function mergeUnitEntries(...lists: MovementUnitEntry[][]): MovementUnitEntry[] {
  const byType = new Map<string, number>();
  for (const list of lists) {
    for (const { unitType, count } of list) {
      byType.set(unitType, (byType.get(unitType) ?? 0) + count);
    }
  }
  return [...byType.entries()].map(([unitType, count]) => ({ unitType, count }));
}
